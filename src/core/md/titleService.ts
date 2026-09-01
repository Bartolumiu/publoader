import type { PrismaClient, UntrackedManga } from "@prisma/client";
import type { Logger } from "../../logging.js";
import { Manifest } from "../../contracts/manifest.js";
import type { MdApi, MdMangaDetail } from "./types.js";
import { MdRequestError } from "./client.js";
import { AuditLog } from "../store/settings.js";
import { DEFAULT_NAMESPACE } from "../store/trackedManga.js";
import { normaliseOfficialLink } from "./officialLink.js";

export interface TitleNotifier {
  send(opts: { title: string; description: string; colour?: string }): Promise<void>;
}

const MAX_CREATE_ATTEMPTS = 3;

/**
 * What `tracked_manga.source` says about a mapping the auto-map pass made.
 *
 * Distinct from `auto` (a title this service created) and `operator:<name>`
 * (someone chose it): a mapping nothing human looked at should say so, because
 * that is the one an operator wants to find first if a series turns out to be
 * wired to the wrong title. The dashboard's tracked map shows this column.
 */
export const OFFICIAL_LINK_SOURCE = "auto:official-link";

/**
 * `tracked_manga.source` for a mapping the title pass made.
 *
 * Distinct from `auto:official-link` because the evidence is weaker -- a name
 * MangaDex also holds, rather than this exact page recorded on the entry -- and
 * an operator auditing a wrong mapping wants to know which of the two decided
 * it before they know anything else.
 */
export const TITLE_MATCH_SOURCE = "auto:title-match";

/** How many rows one auto-map pass searches MangaDex for. */
const AUTO_MAP_BATCH = 20;

/**
 * How long a checked row waits before being checked again.
 *
 * "No official link on MangaDex" is a fact about MangaDex today, not about the
 * series: entries gain links as people fill them in. Re-checking is one search,
 * so the cost of being wrong here is small; never re-checking means a series
 * stays in the queue forever after one early miss.
 */
const RECHECK_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

/** What one auto-map pass did, for the scheduler, the API and the CLI alike. */
export interface AutoMapReport {
  considered: number;
  mapped: { row: UntrackedManga; mdMangaId: string }[];
  /** More than one candidate carried the link; left for a human. */
  ambiguous: number;
  unmatched: number;
  /**
   * NEW rows still due a check after this pass.
   *
   * The hit rate is low and the queue is thousands deep, so a pass that maps
   * nothing is the normal case, not a failure. Without this the button looks
   * broken: it says zero, and says nothing about the two thousand rows it has
   * not reached yet.
   */
  remaining: number;
}

/** One MangaDex title offered as a mapping target for an untracked series. */
export interface TitleCandidate {
  id: string;
  title: string;
  altTitles: string[];
  url: string;
  /** The reported name matches this candidate under the auto-create check. */
  likely: boolean;
}

/** The three scraped fields an operator may correct on an untracked row. */
export interface TitleFields {
  mangaName: string;
  mangaLanguage: string;
  mangaUrl: string | null;
}

export interface MangaEditChange {
  field: "title" | "links";
  from: unknown;
  to: unknown;
}

export interface MangaEditPlan {
  /** Only the fields that changed. Empty `changes` means: send nothing. */
  payload: Record<string, unknown>;
  changes: MangaEditChange[];
  /** Things the operator should know about what was and was not touched. */
  notes: string[];
}

/**
 * What to PUT at /manga/{id} so the title says what the corrected row says.
 *
 * Two rules, both there to keep a correction from becoming a different kind of
 * mistake on a public catalogue:
 *
 *  1. A field that did not change is not sent. MangaDex leaves absent fields
 *     alone, so a title's description, authors, tags and covers survive an edit
 *     from here, which matters most when this pipeline did not create the title
 *     but was pointed at an existing one.
 *
 *  2. A field that is sent replaces its whole value, so `title` and `links` are
 *     merged from what MangaDex currently holds rather than rebuilt. Sending
 *     `{links: {raw: …}}` at a title that also has an `al` or `mu` link would
 *     delete those links.
 *
 * The one deliberate deletion: when the title carries exactly one name and the
 * operator corrected the language, the name moves rather than being duplicated.
 * A single-entry title map is what this pipeline creates (see `createOne`), so
 * that entry is ours to rewrite, and leaving it behind would publish the mangled
 * name as an alternative title in a language it was never in. A title with
 * several names is somebody's curation: the correction is added, the rest kept,
 * with a note saying so.
 */
export function mangaEditPayload(current: MdMangaDetail, desired: TitleFields): MangaEditPlan {
  const changes: MangaEditChange[] = [];
  const notes: string[] = [];
  const payload: Record<string, unknown> = {};

  const currentTitles = current.attributes.title ?? {};
  const existingLanguages = Object.keys(currentTitles);
  const singleEntry = existingLanguages.length <= 1;
  const desiredTitles = singleEntry
    ? { [desired.mangaLanguage]: desired.mangaName }
    : { ...currentTitles, [desired.mangaLanguage]: desired.mangaName };

  if (!sameStringMap(currentTitles, desiredTitles)) {
    changes.push({ field: "title", from: currentTitles, to: desiredTitles });
    payload.title = desiredTitles;
    const displaced = existingLanguages.filter((lang) => lang !== desired.mangaLanguage);
    if (singleEntry && displaced.length === 1) {
      notes.push(
        `the ${displaced[0]} title "${currentTitles[displaced[0]!]}" is replaced, not kept: ` +
          `it is the one this pipeline created`,
      );
    } else if (displaced.length > 0) {
      notes.push(
        `${displaced.length} other title(s) on this entry (${displaced.join(", ")}) are left as ` +
          `they are; if one of them is the wrong name this created, remove it on MangaDex`,
      );
    }
  }

  const currentLinks = current.attributes.links ?? {};
  // An empty url is not a correction to apply: clearing `links.raw` would drop
  // the only pointer back to the source, and the PATCH route does not let an
  // operator blank it either.
  if (desired.mangaUrl && currentLinks.raw !== desired.mangaUrl) {
    const desiredLinks = { ...currentLinks, raw: desired.mangaUrl };
    changes.push({ field: "links", from: currentLinks, to: desiredLinks });
    payload.links = desiredLinks;
  }

  return { payload, changes, notes };
}

function sameStringMap(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

/**
 * Why an apply could not happen. Mapped to a status by the route: `unknown-row`
 * is a 404, `rejected` is a 502 (MangaDex said no, not the operator's fault),
 * everything else is a 409 the operator can act on.
 */
export type ApplyFailure =
  | "unknown-row"
  | "no-md-title"
  | "creating"
  | "title-missing"
  | "version-conflict"
  | "rejected";

export type ApplyResult =
  | {
      ok: true;
      /** False when the title already said what the row says; not an error. */
      applied: boolean;
      mdMangaId: string;
      titleUrl: string;
      changes: MangaEditChange[];
      notes: string[];
    }
  | { ok: false; reason: ApplyFailure; error: string };

/**
 * Automated untracked-series pipeline:
 *   1. the processor persists untracked manga reported by extensions into
 *      `untracked_manga` (state NEW);
 *   2. this service, running in the core uploader (the MD-credential holder)
 *      - creates + commits a MangaDex title for each NEW row when the
 *      extension's manifest opts in (`auto_create_titles`), or when an
 *      operator approves it via the admin API;
 *   3. the new mapping lands in `tracked_manga` (the DB-authoritative manga
 *      id map delivered to workers on lease), so the very next run uploads
 *      the series' chapters;
 *   4. Discord gets an embed linking every title just created.
 *
 * State machine per row: NEW -> CREATING -> CREATED -> TRACKED
 *                        NEW -> SKIPPED (operator)   CREATING -> FAILED (retryable)
 * Every transition is a guarded update; the CREATING claim is CAS'd so
 * replicated uploaders never double-create a title.
 */
export class TitleService {
  private readonly audit: AuditLog;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly md: MdApi,
    private readonly notifier: TitleNotifier,
    private readonly log: Logger,
  ) {
    this.audit = new AuditLog(prisma);
  }

  /** One pass: process NEW rows for extensions with auto_create_titles. */
  async tick(): Promise<void> {
    // Mapping runs first, and for every extension. A series MangaDex already
    // lists under this publisher's own url needs no new title, so resolving
    // that before the create loop is what stops a duplicate being made; and
    // unlike creating a title, mapping publishes nothing to MangaDex, so it is
    // deliberately not behind `auto_create_titles`. That flag gates writing to
    // a public catalogue. This only writes our own map.
    await this.autoMapByOfficialLink();

    const candidates = await this.prisma.untrackedManga.findMany({
      where: { state: "NEW", attempts: { lt: MAX_CREATE_ATTEMPTS } },
      orderBy: { createdAt: "asc" },
      take: 20,
    });
    if (candidates.length === 0) return;

    const manifests = await this.manifestsByExtension();
    const created: { row: UntrackedManga; mdMangaId: string }[] = [];

    for (const row of candidates) {
      const manifest = manifests.get(row.extension);
      if (!manifest) continue;
      if (!manifest.auto_create_titles) continue; // waits for operator approval
      const result = await this.createOne(row, manifest, "auto");
      if (result) created.push({ row, mdMangaId: result });
    }

    if (created.length > 0) await this.announce(created);
  }

  /** Operator-approved creation of a specific untracked row (admin API). */
  async approve(untrackedId: string, actor: string): Promise<{ mdMangaId: string } | { error: string }> {
    const row = await this.prisma.untrackedManga.findUnique({ where: { id: untrackedId } });
    if (!row) return { error: "unknown untracked manga" };
    if (row.state === "TRACKED" && row.mdMangaId) return { mdMangaId: row.mdMangaId };
    if (row.state !== "NEW" && row.state !== "FAILED") return { error: `not approvable in state ${row.state}` };
    const manifest = (await this.manifestsByExtension()).get(row.extension);
    if (!manifest) return { error: `no bundle/manifest for ${row.extension}` };

    // FAILED rows get a fresh budget on explicit approval.
    await this.prisma.untrackedManga.updateMany({
      where: { id: row.id, state: "FAILED" },
      data: { state: "NEW", attempts: 0 },
    });
    const mdMangaId = await this.createOne({ ...row, state: "NEW" }, manifest, actor);
    if (!mdMangaId) return { error: "creation failed; see untracked list for the recorded error" };
    await this.announce([{ row, mdMangaId }]);
    return { mdMangaId };
  }

  /**
   * What MangaDex currently says about a title. Read live and deliberately not
   * cached: an operator about to correct a public catalogue entry needs to be
   * editing against what is there now, not against what an extension scraped
   * days ago or what another operator has since fixed by hand.
   */
  async mangadexTitle(mdMangaId: string): Promise<MdMangaDetail | null> {
    return this.md.mangaById(mdMangaId);
  }

  /**
   * Map every NEW series MangaDex already lists under its own publisher url.
   *
   * Most of these rows are not new series at all: MangaDex has the title, and
   * records this publisher's page as its official English link. That link is a
   * far stronger signal than the name comparison the create path falls back on
   * — names are translated, romanised and abbreviated differently by every
   * party, whereas the url either is or is not the one the scraper read.
   *
   * Deliberately strict, because a wrong mapping uploads chapters onto someone
   * else's title:
   *
   *   - the urls must match exactly once normalised, so a title whose link
   *     points at the same site but a different series is not a match. That
   *     case is real — measured on the live queue, K MANGA rows turn it up
   *     regularly — and a looser host-level match would map them wrongly.
   *   - two candidates carrying the same link is an ambiguity a human should
   *     look at, not a coin toss.
   *   - a series already in the tracked map is left alone, mapped or not.
   *
   * `dryRun` reports what it would map and writes nothing, which is how the
   * backlog gets checked before it gets acted on.
   */
  async autoMapByOfficialLink(
    opts: { limit?: number; dryRun?: boolean; extension?: string } = {},
  ): Promise<AutoMapReport> {
    const limit = opts.limit ?? AUTO_MAP_BATCH;
    const dryRun = opts.dryRun ?? false;
    const staleBefore = new Date(Date.now() - RECHECK_AFTER_MS);

    const rows = await this.prisma.untrackedManga.findMany({
      where: {
        state: "NEW",
        ...(opts.extension ? { extension: opts.extension } : {}),
        OR: [{ officialLinkCheckedAt: null }, { officialLinkCheckedAt: { lt: staleBefore } }],
      },
      // Never-checked rows first, then the stalest; `nulls: "first"` keeps a
      // new arrival from queueing behind thousands of due re-checks.
      orderBy: [{ officialLinkCheckedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
      take: limit,
    });

    const report: AutoMapReport = {
      considered: rows.length,
      mapped: [],
      ambiguous: 0,
      unmatched: 0,
      remaining: 0,
    };

    for (const row of rows) {
      const match = await this.officialLinkMatch(row);

      if (match === null || match === "ambiguous") {
        // Marked on a preview too, and this is the whole difference between a
        // usable button and one that looks broken. A dry run that recorded
        // nothing re-read the same rows every time it was pressed, so with a
        // hit rate around one in twenty the operator saw zero, pressed again,
        // and saw the same zero for the same rows — while two thousand
        // unchecked rows sat behind them. Looking is what happened; say so.
        await this.markLinkChecked(row.id);
        if (match === "ambiguous") report.ambiguous++;
        else report.unmatched++;
        continue;
      }

      if (dryRun) {
        // Deliberately NOT marked. A match nobody has acted on yet has to
        // still be here when they press the button that acts on it.
        report.mapped.push({ row, mdMangaId: match });
        continue;
      }

      const written = await this.writeMapping(row, match, OFFICIAL_LINK_SOURCE);
      if (written) {
        report.mapped.push({ row, mdMangaId: match });
      } else {
        // Already mapped elsewhere: not ours to repoint, and not worth
        // re-searching every pass either.
        await this.markLinkChecked(row.id);
        report.unmatched++;
      }
    }

    report.remaining = await this.prisma.untrackedManga.count({
      where: {
        state: "NEW",
        ...(opts.extension ? { extension: opts.extension } : {}),
        OR: [{ officialLinkCheckedAt: null }, { officialLinkCheckedAt: { lt: staleBefore } }],
      },
    });

    // Deliberately not announced to Discord.
    //
    // This drains a backlog thousands of rows deep, a batch per scheduler
    // tick, so "one embed per pass that mapped something" is a message every
    // few minutes for hours -- and it buries the announcements that do need
    // reading, which is the announcement channel's whole job. The mappings are
    // not lost: each is `auto:official-link` in the tracked map, on the
    // series' own page, and in the audit log.
    return report;
  }

  /** Record that this row has been looked at, so a later pass moves past it. */
  private async markLinkChecked(id: string): Promise<void> {
    await this.prisma.untrackedManga.updateMany({
      where: { id },
      data: { officialLinkCheckedAt: new Date() },
    });
  }

  /**
   * The one MangaDex title whose official English link is this series' url.
   *
   * `null` for no match, `"ambiguous"` when more than one candidate carries the
   * link — which is a catalogue problem for a human, not something to guess at.
   *
   * Scoped to what a title search returns, and honestly so: MangaDex has no way
   * to query by link, so "no other series has this link" can only mean "none of
   * the candidates for this name does". In practice that has been enough —
   * across a 90-row sample of the live queue the ambiguous case never occurred
   * once — but it is a search over names, so a title MangaDex holds under a
   * name nothing like the scraped one is simply not found, and the row waits
   * for an operator as it did before.
   */
  private async officialLinkMatch(row: UntrackedManga): Promise<string | "ambiguous" | null> {
    const want = normaliseOfficialLink(row.mangaUrl);
    if (want === null) return null;

    const candidates = await this.md.searchManga(row.mangaName, 25);
    const matches = candidates.filter(
      (candidate) => normaliseOfficialLink(candidate.attributes.links?.["engtl"] ?? null) === want,
    );
    if (matches.length === 0) return null;

    // Distinct ids only: the same title coming back twice is a paging artefact,
    // not two series sharing a link.
    const ids = [...new Set(matches.map((m) => m.id))];
    if (ids.length > 1) return "ambiguous";
    return ids[0] ?? null;
  }

  /**
   * Map every NEW series MangaDex already holds under this exact name.
   *
   * The companion to the official-link pass, and the one that reaches the
   * backlog. Publishers mostly do not get their page recorded as a MangaDex
   * title's official English link -- measured on this queue the link pass
   * matches about one row in twenty -- while the name itself usually is on
   * MangaDex verbatim, because the publisher's English title is what the
   * catalogue's uploaders typed in. A 40-row sample across all four sources
   * found an exact name on MangaDex for 34 of them.
   *
   * A name is weaker evidence than a url, so the strictness is where the url
   * pass got it for free:
   *
   *   - equality, never containment. `titleMatches` (which the create path
   *     uses to REFUSE, where a false positive is harmless) counts a substring
   *     as a match; here that would map "Saki" onto "Saki: Achiga-hen" and
   *     upload a series onto its own spin-off.
   *   - one surviving candidate, or nobody is mapped. Two entries answering to
   *     one name is exactly the case a person has to look at: measured here it
   *     is a Japanese and a Korean series sharing an English name, or a
   *     serialised title beside its own oneshot.
   *   - a candidate whose link points at a DIFFERENT series on this very
   *     publisher's site is dropped, not counted. That is MangaDex saying "this
   *     title is that other page", which outweighs a matching name.
   *   - variant editions (a oneshot, a fan-coloured re-release) are dropped
   *     too: never the right target for a publisher's chapters, and their
   *     presence is what makes an otherwise clean name ambiguous.
   *   - very short names are skipped entirely. At three characters or fewer an
   *     exact match is a coincidence as often as a match.
   *
   * `dryRun` is the default at every caller for the same reason as the link
   * pass: this writes the series map, and the map decides where chapters land.
   */
  async autoMapByTitle(
    opts: { limit?: number; dryRun?: boolean; extension?: string } = {},
  ): Promise<AutoMapReport> {
    const limit = opts.limit ?? AUTO_MAP_BATCH;
    const dryRun = opts.dryRun ?? true;
    const staleBefore = new Date(Date.now() - RECHECK_AFTER_MS);
    const due = {
      state: "NEW" as const,
      ...(opts.extension ? { extension: opts.extension } : {}),
      OR: [{ titleCheckedAt: null }, { titleCheckedAt: { lt: staleBefore } }],
    };

    const rows = await this.prisma.untrackedManga.findMany({
      where: due,
      orderBy: [{ titleCheckedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
      take: limit,
    });

    const report: AutoMapReport = {
      considered: rows.length,
      mapped: [],
      ambiguous: 0,
      unmatched: 0,
      remaining: 0,
    };

    for (const row of rows) {
      const match = await this.titleMatch(row);

      if (match === null || match === "ambiguous") {
        // Marked even on a dry run: looking is what happened, and a preview
        // that recorded nothing would re-read the same rows every time it was
        // pressed while the rest of the queue sat behind them.
        await this.markTitleChecked(row.id);
        if (match === "ambiguous") report.ambiguous++;
        else report.unmatched++;
        continue;
      }

      if (dryRun) {
        // Deliberately NOT marked: a match nobody has acted on yet has to still
        // be here when they press the button that acts on it.
        report.mapped.push({ row, mdMangaId: match });
        continue;
      }

      const written = await this.writeMapping(row, match, TITLE_MATCH_SOURCE);
      if (written) {
        report.mapped.push({ row, mdMangaId: match });
      } else {
        await this.markTitleChecked(row.id);
        report.unmatched++;
      }
    }

    report.remaining = await this.prisma.untrackedManga.count({ where: due });
    // Not announced to Discord, for the reason the link pass is not: this
    // drains a queue thousands deep a batch at a time, and an embed per pass
    // would bury the announcements that need reading. Each mapping is
    // `auto:title-match` in the tracked map and in the audit log.
    return report;
  }

  /** Record that the title pass has looked at this row. */
  private async markTitleChecked(id: string): Promise<void> {
    await this.prisma.untrackedManga.updateMany({
      where: { id },
      data: { titleCheckedAt: new Date() },
    });
  }

  /**
   * The one MangaDex title whose name is exactly this series' name.
   *
   * `null` for no match, `"ambiguous"` when more than one survives -- which is
   * a question for a person, not a coin toss, because both answers are a real
   * series and one of them would get someone else's chapters.
   */
  private async titleMatch(row: UntrackedManga): Promise<string | "ambiguous" | null> {
    if (!isMatchableName(row.mangaName)) return null;

    const candidates = await this.md.searchManga(row.mangaName, 25);
    const survivors = candidates.filter(
      (candidate) =>
        exactNameMatch(candidate, row.mangaName) &&
        !isVariantEdition(candidate) &&
        !linkContradicts(candidate, row.mangaUrl),
    );

    // Distinct ids only: the same title returned twice is a paging artefact,
    // not two series answering to one name.
    const ids = [...new Set(survivors.map((c) => c.id))];
    if (ids.length === 0) return null;
    if (ids.length > 1) return "ambiguous";
    return ids[0] ?? null;
  }

  /**
   * Tracked map upsert plus the row's state, shared by every path that maps.
   *
   * Returns false when the series is already mapped to a different title:
   * repointing is an edit of existing curation and never something a pass or a
   * one-click button should do silently.
   */
  private async writeMapping(
    row: UntrackedManga,
    mdMangaId: string,
    source: string,
  ): Promise<boolean> {
    const identity = {
      extension: row.extension,
      namespace: DEFAULT_NAMESPACE,
      mangaId: row.mangaId,
    };
    const existing = await this.prisma.trackedManga.findUnique({
      where: { extension_namespace_mangaId: identity },
    });
    if (existing && existing.mdMangaId !== mdMangaId) return false;

    // Track first (the map is what unblocks uploads), then finalize state, so
    // a failure between the two leaves a mapped series rather than a row
    // claiming to be tracked with nothing behind it.
    await this.prisma.trackedManga.upsert({
      where: { extension_namespace_mangaId: identity },
      create: { ...identity, mdMangaId, source },
      update: {},
    });
    await this.prisma.untrackedManga.update({
      where: { id: row.id },
      data: { state: "TRACKED", mdMangaId, lastError: null },
    });
    return true;
  }

  /**
   * Candidate MangaDex titles for a query, for an operator deciding whether a
   * series already exists rather than needing a new title.
   *
   * `likely` is the same comparison the auto-create path uses to refuse a
   * duplicate, surfaced instead of hidden: the operator sees which candidate
   * the pipeline itself would have treated as a match, which is also the
   * reason a row is sitting in FAILED when it is.
   */
  async searchTitles(query: string, limit = 10, reportedName?: string): Promise<TitleCandidate[]> {
    const candidates = await this.md.searchManga(query, limit);
    // Match against the name the source reported when there is one: an
    // operator may have widened the query to find the series at all, and
    // "does this look like what the scraper saw" stays the useful question.
    const compareTo = (reportedName ?? "").trim() || query;
    return candidates.map((candidate) => ({
      id: candidate.id,
      title: primaryTitle(candidate),
      altTitles: altTitleList(candidate),
      url: `https://mangadex.org/title/${candidate.id}`,
      likely: titleMatches(candidate, compareTo),
    }));
  }

  /**
   * One title, in the shape the search returns, for an id an operator pasted.
   *
   * Pasting the link of a title you already found is faster than searching for
   * it again, but it skips the step that makes searching safe: seeing the name
   * before mapping. This puts that step back. A wrong id is otherwise
   * indistinguishable from a right one — both are uuids — until chapters start
   * arriving on someone else's series.
   *
   * Null means MangaDex does not have it, which is a typo or a deleted title;
   * `mapToExisting` refuses that case too, this just says so first.
   */
  async titleById(mdMangaId: string, reportedName?: string): Promise<TitleCandidate | null> {
    const detail = await this.md.mangaById(mdMangaId);
    if (detail === null) return null;
    return {
      id: detail.id,
      title: primaryTitle(detail),
      altTitles: altTitleList(detail),
      url: `https://mangadex.org/title/${detail.id}`,
      likely: reportedName ? titleMatches(detail, reportedName) : false,
    };
  }

  /**
   * Which of these title ids MangaDex actually holds.
   *
   * The batch counterpart to `titleById`. Checking a pasted batch one row at a
   * time would be one MangaDex request per line, which for two hundred lines is
   * both slow and rude to a service that rate-limits us; `mangaByIds` answers
   * a hundred at a time. Ids MangaDex does not return are the ones to refuse:
   * a mapping onto a title that is not there wires uploads to nothing.
   */
  async existingTitles(ids: string[]): Promise<Set<string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Set();
    const found = await this.md.mangaByIds(unique);
    return new Set(found.map((manga) => manga.id));
  }

  /**
   * Point an untracked row at a MangaDex title that already exists.
   *
   * The counterpart to `approve`: same bookkeeping, no title creation. Both
   * end with the series in `tracked_manga` — the map is what unblocks uploads —
   * and the row TRACKED. Creating a duplicate title is the one mistake in this
   * pipeline that other people have to clean up, so an operator who finds the
   * real title should have no more work to do than approving would have been.
   *
   * Two things it refuses rather than guesses at. A title id MangaDex does not
   * know is a typo or a deleted entry, and mapping to it would wire uploads to
   * nothing. And a series already mapped elsewhere is a repoint, which edits
   * existing curation rather than adding to it; that belongs in the tracked-map
   * editor where it is explicit, not behind a one-click button in a triage
   * queue.
   */
  async mapToExisting(
    untrackedId: string,
    mdMangaId: string,
    actor: string,
  ): Promise<{ ok: true; mdMangaId: string } | { ok: false; error: string }> {
    const row = await this.prisma.untrackedManga.findUnique({ where: { id: untrackedId } });
    if (!row) return { ok: false, error: "unknown untracked manga" };
    if (row.state === "CREATING") {
      return { ok: false, error: "a title creation is in flight for this row; wait for it to finish" };
    }
    if (row.state === "TRACKED" && row.mdMangaId && row.mdMangaId !== mdMangaId) {
      return {
        ok: false,
        error:
          `this series is already tracked as ${row.mdMangaId}; repointing it is an edit, ` +
          `so make it in the tracked map for ${row.extension}`,
      };
    }

    const title = await this.md.mangaById(mdMangaId);
    if (!title) {
      return { ok: false, error: `MangaDex has no title ${mdMangaId}; check the id` };
    }

    const written = await this.writeMapping(row, mdMangaId, `operator:${actor}`);
    if (!written) {
      const existing = await this.prisma.trackedManga.findUnique({
        where: {
          extension_namespace_mangaId: {
            extension: row.extension,
            namespace: DEFAULT_NAMESPACE,
            mangaId: row.mangaId,
          },
        },
      });
      return {
        ok: false,
        error:
          `${row.extension}:${row.mangaId} is already mapped to ${existing?.mdMangaId}; ` +
          `changing that mapping belongs in the tracked map, not here`,
      };
    }
    await this.audit.record(actor, "untracked.map", `${row.extension}:${row.mangaId}`, {
      mdMangaId,
      mangaName: row.mangaName,
    });
    return { ok: true, mdMangaId };
  }

  /**
   * Push a corrected untracked row's details onto the MangaDex title it created.
   *
   * The row is the source of truth for what the title should say, so this reads
   * it fresh: an operator PATCHes, looks at the diff, then applies, and anything
   * cached in between would apply the wrong thing. The write itself is
   * conditional on the version read in the same call; a concurrent edit loses
   * the race and is reported rather than overwritten.
   */
  async applyToMangaDex(untrackedId: string, actor: string): Promise<ApplyResult> {
    const row = await this.prisma.untrackedManga.findUnique({ where: { id: untrackedId } });
    if (!row) return { ok: false, reason: "unknown-row", error: "unknown untracked manga" };
    if (row.state === "CREATING") {
      return {
        ok: false,
        reason: "creating",
        error: "a title creation is in flight for this row; wait for it to finish",
      };
    }
    if (!row.mdMangaId) {
      return {
        ok: false,
        reason: "no-md-title",
        error:
          "this row has no MangaDex title yet, so there is nothing to correct there; " +
          "fix the row and approve it, and the title is created from the corrected values",
      };
    }

    const current = await this.md.mangaById(row.mdMangaId);
    if (!current) {
      return {
        ok: false,
        reason: "title-missing",
        error: `MangaDex has no title ${row.mdMangaId}; it may have been deleted or merged`,
      };
    }

    const titleUrl = `https://mangadex.org/title/${row.mdMangaId}`;
    const plan = mangaEditPayload(current, row);
    if (plan.changes.length === 0) {
      return {
        ok: true,
        applied: false,
        mdMangaId: row.mdMangaId,
        titleUrl,
        changes: [],
        notes: ["the MangaDex title already matches this row; nothing was sent"],
      };
    }

    const log = this.log.child({ extension: row.extension, mdMangaId: row.mdMangaId });
    try {
      const edited = await this.md.editManga(row.mdMangaId, plan.payload, current.attributes.version);
      if (!edited) throw new MdRequestError("MangaDex did not accept the title edit");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = err instanceof MdRequestError ? err.status : undefined;
      // A version conflict is the one failure with a different meaning: the
      // entry moved between the read and the write, so the operator has to look
      // again before deciding; re-sending the same edit would clobber whatever
      // that other change was.
      const conflict = status === 409 || (status === 400 && /version/i.test(message));
      await this.prisma.untrackedManga.update({
        where: { id: row.id },
        data: { lastError: `MangaDex edit failed: ${message}`.slice(0, 2000) },
      });
      log.error({ err, actor }, "applying corrected details to MangaDex failed");
      return {
        ok: false,
        reason: conflict ? "version-conflict" : "rejected",
        error: conflict
          ? `the MangaDex title changed since it was read (version ${current.attributes.version} ` +
            `is stale); reload the row to see what it says now, then apply again`
          : `MangaDex rejected the edit: ${message}`,
      };
    }

    // The row carries the CURRENT fact, "this was applied, when, by whom",
 // while the audit log keeps the history of each application. Deriving the
    // fact by scanning the log worked, but it made a routine read depend on log
    // retention, and current state belongs on the row.
    await this.prisma.untrackedManga.update({
      where: { id: row.id },
      data: { lastError: null, mdAppliedAt: new Date(), mdAppliedBy: actor },
    });
    await this.audit.record(actor, "untracked.mangadex_apply", row.id, {
      mdMangaId: row.mdMangaId,
      extension: row.extension,
      mangaId: row.mangaId,
      version: current.attributes.version,
      changes: plan.changes,
    });
    log.info({ actor, fields: plan.changes.map((c) => c.field) }, "corrected MangaDex title");
    return {
      ok: true,
      applied: true,
      mdMangaId: row.mdMangaId,
      titleUrl,
      changes: plan.changes,
      notes: plan.notes,
    };
  }

  private async createOne(
    row: UntrackedManga,
    manifest: Manifest,
    actor: string,
  ): Promise<string | null> {
    // CAS claim: only one service instance may create this title.
    const claimed = await this.prisma.untrackedManga.updateMany({
      where: { id: row.id, state: "NEW" },
      data: { state: "CREATING", attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) return null;
    const log = this.log.child({ extension: row.extension, mangaId: row.mangaId });

    try {
      // Defensive re-check: the id may have been tracked by another path
      // (bundle re-import, manual tracking) since it was reported.
      // The default namespace: `untracked_manga` has no namespace column, so an
      // auto-created title lands in the extension's flat id space. That is
      // correct for every extension that has one; see the note on the
      // TrackedManga.namespace model for what a multi-catalogue extension (viz)
      // still needs before its untracked series can travel this path.
      const already = await this.prisma.trackedManga.findUnique({
        where: {
          extension_namespace_mangaId: {
            extension: row.extension,
            namespace: DEFAULT_NAMESPACE,
            mangaId: row.mangaId,
          },
        },
      });
      if (already) {
        await this.prisma.untrackedManga.update({
          where: { id: row.id },
          data: { state: "TRACKED", mdMangaId: already.mdMangaId },
        });
        return null; // tracked, but nothing newly created to announce
      }

      // Does this series already exist on MangaDex? Creating a duplicate title
      // is the one mistake in this pipeline that other people have to clean up,
      // and "the publisher lists a series we have no mapping for" is a much
      // weaker signal than "this series is not on MangaDex". So when a plausible
      // match exists, refuse to auto-create and hand it to a human with the
      // candidates attached; mapping an existing title is a two-click job in
      // the dashboard, un-duplicating a catalogue is not.
      if (actor === "auto") {
        const candidates = await this.md.searchManga(row.mangaName, 5);
        const match = candidates.find((candidate) =>
          titleMatches(candidate, row.mangaName),
        );
        if (match) {
          await this.prisma.untrackedManga.update({
            where: { id: row.id },
            data: {
              state: "FAILED",
              lastError:
                `a MangaDex title already looks like this series ` +
                `(https://mangadex.org/title/${match.id}). Not auto-creating a ` +
                `duplicate; map it with \`tracked set\`, or approve this row to ` +
                `create a new title anyway.`,
            },
          });
          log.warn(
            { candidate: match.id, mangaName: row.mangaName },
            "skipping auto-create: probable existing MangaDex title",
          );
          return null;
        }
      }

      const draft = await this.md.createMangaDraft({
        // Title keyed by the language the source reports it in; fall back to en.
        title: { [row.mangaLanguage || "en"]: row.mangaName },
        originalLanguage: manifest.title_defaults.originalLanguage,
        status: manifest.title_defaults.status,
        contentRating: manifest.title_defaults.contentRating,
        links: row.mangaUrl ? { raw: row.mangaUrl } : undefined,
      });
      const committed = await this.md.commitMangaDraft(draft.id, draft.version);
      if (!committed) throw new Error("draft commit rejected by MangaDex");

      // Track first (the map is what unblocks uploads), then finalize state.
      await this.prisma.trackedManga.upsert({
        where: {
          extension_namespace_mangaId: {
            extension: row.extension,
            namespace: DEFAULT_NAMESPACE,
            mangaId: row.mangaId,
          },
        },
        create: {
          extension: row.extension,
          namespace: DEFAULT_NAMESPACE,
          mangaId: row.mangaId,
          mdMangaId: draft.id,
          source: actor === "auto" ? "auto" : `operator:${actor}`,
        },
        update: {},
      });
      await this.prisma.untrackedManga.update({
        where: { id: row.id },
        data: { state: "TRACKED", mdMangaId: draft.id, lastError: null },
      });
      await this.audit.record(
        actor === "auto" ? "title-service" : actor,
        "title.create",
        `${row.extension}:${row.mangaId}`,
        { mdMangaId: draft.id, mangaName: row.mangaName },
      );
      log.info({ mdMangaId: draft.id }, "created and tracked MangaDex title");
      return draft.id;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.untrackedManga.update({
        where: { id: row.id },
        data: {
          state: row.attempts + 1 >= MAX_CREATE_ATTEMPTS ? "FAILED" : "NEW",
          lastError: message.slice(0, 2000),
        },
      });
      log.error({ err }, "title creation failed");
      return null;
    }
  }

  private async announce(created: { row: UntrackedManga; mdMangaId: string }[]): Promise<void> {
    // Batch into embeds of 20 lines to stay under Discord limits.
    for (let i = 0; i < created.length; i += 20) {
      const batch = created.slice(i, i + 20);
      const lines = batch.map(
        ({ row, mdMangaId }) =>
          `**[${row.mangaName}](https://mangadex.org/title/${mdMangaId})** ` +
          `(${row.mangaLanguage}): [source](${row.mangaUrl}) · \`${row.extension}\``,
      );
      await this.notifier.send({
        title: `Created ${created.length} new MangaDex title${created.length === 1 ? "" : "s"}`,
        description: lines.join("\n"),
        colour: "26D454",
      });
    }
  }

  private async manifestsByExtension(): Promise<Map<string, Manifest>> {
    const bundles = await this.prisma.bundle.findMany({
      where: { yanked: false },
      orderBy: { publishedAt: "desc" },
      select: { extension: true, manifest: true },
    });
    const map = new Map<string, Manifest>();
    for (const b of bundles) {
      if (map.has(b.extension)) continue;
      const parsed = Manifest.safeParse(b.manifest);
      if (parsed.success) map.set(b.extension, parsed.data);
    }
    return map;
  }
}

/**
 * Does a MangaDex search hit plausibly denote the same series?
 *
 * Deliberately conservative on the "same" side: compares the reported name
 * against every title and alt-title after case-folding and stripping
 * punctuation/whitespace. A false positive costs one operator click; a false
 * negative creates a duplicate title on a public catalogue.
 */

/**
 * The one title to show for a candidate. English where MangaDex has it, else
 * whatever it does have — a picker with a blank row is useless, and an id is
 * not something an operator can recognise a series by.
 */
function primaryTitle(candidate: { attributes: { title: Record<string, string> } }): string {
  const titles = candidate.attributes.title ?? {};
  return titles["en"] ?? Object.values(titles)[0] ?? "(untitled)";
}

/** Alt titles, de-duplicated and minus the one already shown as the title. */
function altTitleList(candidate: {
  attributes: { title: Record<string, string>; altTitles: Record<string, string>[] };
}): string[] {
  const seen = new Set<string>([primaryTitle(candidate)]);
  const out: string[] = [];
  for (const alt of candidate.attributes.altTitles ?? []) {
    for (const value of Object.values(alt)) {
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

/**
 * A name reduced to what two records of the same series must agree on:
 * case-folded, decomposed, and stripped of everything that is not a letter or
 * a number. That is what makes "Saint☆Young Men", "Saint Young Men" and
 * "SAINT YOUNG MEN" one name, which they are.
 */
function nameKey(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

/** Every name MangaDex holds for a candidate: its titles and its alt titles. */
function candidateNames(candidate: {
  attributes: { title: Record<string, string>; altTitles: Record<string, string>[] };
}): string[] {
  return [
    ...Object.values(candidate.attributes.title ?? {}),
    ...(candidate.attributes.altTitles ?? []).flatMap((alt) => Object.values(alt)),
  ];
}

/**
 * Is this name specific enough to map on by itself?
 *
 * Three characters or fewer after normalisation is not evidence: "Ao", "GTO"
 * and "Blue" collide with unrelated series on a catalogue this size, and an
 * exact hit on one is as likely to be a coincidence as a match.
 */
export function isMatchableName(reported: string): boolean {
  return nameKey(reported ?? "").length > 3;
}

/**
 * Does MangaDex hold this candidate under exactly the reported name?
 *
 * Equality, not containment -- the difference between this and `titleMatches`,
 * and the whole reason both exist. `titleMatches` guards the create path, where
 * a false positive costs one operator click; this one writes the series map,
 * where a false positive uploads a publisher's chapters onto a different
 * series' page.
 */
export function exactNameMatch(
  candidate: { attributes: { title: Record<string, string>; altTitles: Record<string, string>[] } },
  reported: string,
): boolean {
  const target = nameKey(reported);
  if (target.length === 0) return false;
  return candidateNames(candidate).some((name) => nameKey(name) === target);
}

/**
 * Markers MangaDex's uploaders put in a title to say "this is not the main
 * entry": a oneshot pilot, a re-coloured re-release, a doujinshi. They share a
 * name with the real series by design, so they are both the commonest cause of
 * a name looking ambiguous and never the right target for a publisher's
 * chapters.
 *
 * Matched as a parenthetical or suffix only, so a series legitimately called
 * "Colorless" or "Oneshot Boy" is untouched.
 */
const VARIANT_EDITION = [
  // Bracketed, anywhere in the name -- MangaDex puts these both before and
  // after the title ("(Pre-Serialization) Tomodachi no Nee-chan ...").
  /[([]\s*(?:(?:fan|official(?:ly)?|digital|minimalist)[\s-]?)?colou?r(?:ed)?\s*[)\]]/i,
  /[([]\s*(?:oneshot|one-shot|doujinshi|anthology|spin[\s-]?off|remake|pilot|preview|promo(?:tion(?:al)?)?|trial(?:\s+comic)?|pre-?serial(?:i[sz]ation)?|remaster(?:ed)?)\s*[)\]]/i,
  // Unbracketed, and only as a trailing qualifier: "Golden Kamuy - Digital
  // Colored Comics", "Uchuu Kyoudai - Digital Colored Comics". Anchored at the
  // end so a series whose own name contains these words is untouched.
  /[-–—]\s*(?:digital\s+)?colou?red\s+comics?\s*$/i,
];

/** Is this candidate a variant edition rather than the serialised series? */
export function isVariantEdition(candidate: {
  attributes: { title: Record<string, string>; altTitles: Record<string, string>[] };
}): boolean {
  return candidateNames(candidate).some((name) =>
    VARIANT_EDITION.some((pattern) => pattern.test(name)),
  );
}

/**
 * Are two normalised urls on one site the same series?
 *
 * Equal, or one a path-prefix of the other at a segment boundary. That second
 * case is not a nicety: MangaDex entries routinely record a deep link as the
 * official English release -- `kmanga.kodansha.com/title/10028/episode/316940`
 * where the scraper holds `kmanga.kodansha.com/title/10028` -- and reading that
 * as a different series is worse than useless. It threw away the RIGHT
 * candidate for Wind Breaker and left the Korean series of the same name
 * looking like the only answer.
 *
 * The segment boundary is what keeps `/title/1002` from matching `/title/10028`.
 */
function sameSeriesLink(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Does MangaDex say this candidate is a DIFFERENT series on the publisher's own
 * site?
 *
 * The strongest available disconfirmation, and it costs nothing: when an entry
 * records a link on the same host as the series being mapped but pointing at
 * another page, the catalogue has already answered "which page is this" and the
 * answer is not this one. Left as a match when the entry carries no link for
 * that host at all -- most do not, and absence says nothing.
 *
 * Compared on host and path via `normaliseOfficialLink`, so a trailing slash or
 * a `www.` never reads as a different series, and a deep link into the series
 * counts as the series.
 */
export function linkContradicts(
  candidate: { attributes: { links?: Record<string, string> | null } },
  seriesUrl: string,
): boolean {
  const want = normaliseOfficialLink(seriesUrl);
  if (want === null) return false;
  const host = want.split("/")[0];
  let contradicted = false;
  for (const link of Object.values(candidate.attributes.links ?? {})) {
    const other = normaliseOfficialLink(link);
    if (other === null) continue;
    if (other.split("/")[0] !== host) continue;
    // One link naming this series settles it, whatever the entry's other links
    // for the same host say -- a publisher page and a deep link into it are
    // both this series, and an entry carrying both must not read as a conflict.
    if (sameSeriesLink(other, want)) return false;
    contradicted = true;
  }
  return contradicted;
}

function titleMatches(candidate: { attributes: { title: Record<string, string>; altTitles: Record<string, string>[] } }, reported: string): boolean {
  const normalise = (value: string) =>
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{Letter}\p{Number}]+/gu, "");
  const target = normalise(reported);
  if (target.length === 0) return false;
  const names = [
    ...Object.values(candidate.attributes.title ?? {}),
    ...(candidate.attributes.altTitles ?? []).flatMap((alt) => Object.values(alt)),
  ];
  return names.some((name) => {
    const other = normalise(name);
    return other.length > 0 && (other === target || other.includes(target) || target.includes(other));
  });
}
