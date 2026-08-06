import type { PrismaClient, UntrackedManga } from "@prisma/client";
import type { Logger } from "../../logging.js";
import { Manifest } from "../../contracts/manifest.js";
import type { MdApi, MdMangaDetail } from "./types.js";
import { MdRequestError } from "./client.js";
import { AuditLog } from "../store/settings.js";
import { DEFAULT_NAMESPACE } from "../store/trackedManga.js";

export interface TitleNotifier {
  send(opts: { title: string; description: string; colour?: string }): Promise<void>;
}

const MAX_CREATE_ATTEMPTS = 3;

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
 *     from here untouched; which matters most for the case where this pipeline
 *     did not create the title but was pointed at an existing one.
 *
 *  2. A field that IS sent replaces its whole value, so `title` and `links` are
 *     merged from what MangaDex currently holds rather than rebuilt. Sending
 *     `{links: {raw: …}}` at a title that also has an `al` or `mu` link would
 *     delete those links, and nobody asked for that.
 *
 * The one deliberate deletion: when the title carries exactly one name and the
 * operator corrected the LANGUAGE, the name moves rather than being duplicated.
 * A single-entry title map is what this pipeline creates (see `createOne`), so
 * that entry is ours to rewrite; leaving it behind would publish the mangled
 * name as an alternative title in a language it was never in. A title with
 * several names is somebody's curation: the correction is added and the rest are
 * kept, with a note saying so.
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
 *   2. this service; running in the core uploader (the MD-credential holder)
 *     ; creates + commits a MangaDex title for each NEW row when the
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

    // The row carries the CURRENT fact; "this was applied, when, by whom" -
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
