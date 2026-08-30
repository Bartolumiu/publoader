import type { PrismaClient } from "@prisma/client";

/**
 * Bulk curation of the series map.
 *
 * The map used to live in `manga_id_map.json` inside each extension bundle, so
 * adding a hundred series meant editing a file, opening a pull request and
 * republishing. The database is authoritative now, which makes bulk editing an
 * API concern; and a permissions concern, because "add series" is a job worth
 * delegating to a contributor while "repoint or delete a series" is not.
 *
 * Every operation reports per-row outcomes rather than failing the whole batch:
 * a contributor pasting 200 lines wants to know which three were wrong, not
 * that "the batch failed".
 */

export const MAX_BATCH_ROWS = 2000;

/** The flat id space every extension has by default. */
export const DEFAULT_NAMESPACE = "";
export const MAX_NAMESPACE_LENGTH = 128;
/**
 * A namespace names a catalogue inside one extension (viz serves `shonenjump`
 * and `vizmanga`), so it is an identifier, not free text. Restricting it also
 * keeps it unambiguous in the `namespace,externalId,titleId` paste format and
 * in a URL path segment.
 */
export const NAMESPACE_RE = /^[a-z0-9][a-z0-9_-]*$/;

export type BatchOutcome =
  | "added"
  | "updated"
  | "unchanged"
  | "removed"
  | "not_found"
  | "rejected_needs_write"
  | "invalid";

export interface BatchRowResult {
  mangaId: string;
  /** Omitted for the flat id space, so existing callers see what they always did. */
  namespace?: string;
  mdMangaId?: string;
  outcome: BatchOutcome;
  detail?: string;
}

export interface TrackedPair {
  mangaId: string;
  mdMangaId: string;
  namespace?: string;
}

export interface BatchRequest {
  /** Create or (with tracked:write) repoint these mappings. */
  set?: TrackedPair[];
  /**
   * Remove these external ids. Requires tracked:write. A bare string removes
   * from the flat id space; `{namespace, mangaId}` targets one catalogue.
   */
  remove?: (string | { mangaId: string; namespace?: string })[];
}

export interface BatchSummary {
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  failed: number;
  results: BatchRowResult[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Canonical namespace for a value that may be absent, null, or blank. */
export function normaliseNamespace(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_NAMESPACE;
  return value.trim().toLowerCase();
}

/** The identity a row is unique on. Used as a Map key, so it must not collide. */
function pairKey(namespace: string, mangaId: string): string {
  // JSON rather than `${a}|${b}`: a namespace or an external id containing the
  // separator would otherwise let two distinct pairs share a key.
  return JSON.stringify([namespace, mangaId]);
}

/**
 * Parse the format humans actually have: lines of `externalId,mdMangaId`, or
 * `namespace,externalId,mdMangaId` for an extension with more than one
 * catalogue (viz: `vizmanga,709,9a0f1e7e-…`).
 *
 * Also accepts whitespace/tab/semicolon separators, `#` comments, a header row,
 * and the columns in any order; because someone will paste it that way and
 * guessing correctly is better than rejecting a whole paste over column order.
 * The MangaDex id is identified by being a uuid, and on a three-column line the
 * two remaining values keep their relative order: namespace first, then
 * external id. Returns per-line errors instead of throwing.
 */
export function parsePairs(
  text: string,
  opts: { defaultNamespace?: string } = {},
): {
  rows: { mangaId: string; mdMangaId: string; namespace: string }[];
  errors: { line: number; text: string; reason: string }[];
} {
  const rows: { mangaId: string; mdMangaId: string; namespace: string }[] = [];
  const errors: { line: number; text: string; reason: string }[] = [];
  const fallbackNamespace = normaliseNamespace(opts.defaultNamespace);

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.split("#")[0]!.trim();
    if (line.length === 0) return;
    const parts = line.split(/[\s,;|]+/).filter(Boolean);
    if (parts.length < 2) {
      errors.push({ line: index + 1, text: line, reason: "expected two values: externalId and mangadex title id" });
      return;
    }
    if (parts.length > 3) {
      errors.push({
        line: index + 1,
        text: line,
        reason: "expected at most three values: namespace, externalId and mangadex title id",
      });
      return;
    }

    const uuidAt = parts.findIndex((part) => UUID_RE.test(part));
    if (uuidAt === -1) {
      // Skip an obvious header row rather than reporting it as an error.
      if (index === 0) return;
      errors.push({ line: index + 1, text: line, reason: "no value is a mangadex title id (uuid)" });
      return;
    }
    const rest = parts.filter((_, i) => i !== uuidAt);
    const mdMangaId = parts[uuidAt]!;
    const namespace = rest.length === 2 ? normaliseNamespace(rest[0]) : fallbackNamespace;
    const mangaId = rest.length === 2 ? rest[1]! : rest[0]!;

    if (mangaId.length === 0 || mangaId.length > 512) {
      errors.push({ line: index + 1, text: line, reason: "external id is empty or too long" });
      return;
    }
    if (namespace !== DEFAULT_NAMESPACE && !NAMESPACE_RE.test(namespace)) {
      errors.push({
        line: index + 1,
        text: line,
        reason: `namespace ${JSON.stringify(namespace)} must match ${String(NAMESPACE_RE)}`,
      });
      return;
    }
    rows.push({ mangaId, mdMangaId: mdMangaId.toLowerCase(), namespace });
  });

  return { rows, errors };
}

/**
 * The lease's `mangaIdMap`, in the wire shape documented on
 * `MangaIdMapPayload`. Exported so the lease route and its tests build it the
 * same way.
 */
export type FlatMangaIdMap = Record<string, string[]>;
export type NamespacedMangaIdMap = Record<string, Record<string, string[]>>;

export interface MangaIdMapPayload {
  /**
   * WIRE SHAPE. Two forms, because the real data files have two forms and
   * translating between them at the boundary is what caused the collision this
   * namespace column fixes:
   *
   *   flat        {mdMangaId: [externalId, …]}
   *               - every row is in the default id space. This is mangaplus's
   *                 manga_id_map.json verbatim, so an unchanged runner and an
   *                 unchanged extension see exactly what they saw before.
   *
   *   namespaced  {namespace: {mdMangaId: [externalId, …]}}
   *               - at least one row names a catalogue. This mirrors viz's
   *                 manga_id_map.json, which is `{namespace: {…}}`.
   *
   * The two are distinguishable without a flag (a flat map's values are arrays,
   * a namespaced map's are objects), but `namespaced` is sent anyway so a
   * consumer that does not implement namespaces can refuse loudly instead of
   * inverting an object-valued map into an empty lookup and reporting every
   * series as untracked.
   */
  mangaIdMap: FlatMangaIdMap | NamespacedMangaIdMap;
  namespaced: boolean;
}

/**
 * The `where` clause naming the series an extension may act on right now.
 *
 * A paused series is suppressed from BOTH sides of every run, and the second
 * side is the one that bites. Filtering only the lease map looks like it works:
 * the extension stops fetching the series and stops reporting it in
 * `allChapters`. But `authoritativeTrackedIds` rebuilds the tracked set from
 * this table, `removeMangaWithoutExternalChapters` then takes every tracked id
 * NOT in `allChapters` as a series the publisher has dropped, and the paused
 * series matches exactly that shape. A half-applied pause does not skip a
 * series; it takes its chapters down from MangaDex.
 *
 * So this predicate is the single definition of "in play", and every site that
 * decides what a run covers uses it: the lease map (what gets fetched), the
 * authoritative tracked set (what can be withdrawn), and the partitioner (what
 * gets segmented). Sites that merely RESOLVE an id — chapterReconcile mapping a
 * MangaDex title back to an external one, ingest validating that an envelope
 * only names titles the extension owns — deliberately do not use it: a paused
 * series still has a mapping and its worker may hold a lease taken before the
 * pause, and rejecting that envelope would fail an otherwise good run.
 *
 * `now` is a parameter so the boundary is testable without touching the clock.
 */
export function activeTrackedWhere(extension: string, now: Date = new Date()) {
  return {
    extension,
    // Due counts as active: the cooldown has expired and this run is the one
    // that should look at it.
    OR: [{ recheckAfter: null }, { recheckAfter: { lte: now } }],
  };
}

/** The complement of {@link activeTrackedWhere}: series suppressed right now. */
export function pausedTrackedWhere(extension: string, now: Date = new Date()) {
  return { extension, recheckAfter: { gt: now } };
}

/**
 * The same judgement as {@link activeTrackedWhere}, applied to a row in hand.
 *
 * Exists so the clock comparison is written once. Callers that have to decide
 * per MangaDex title rather than per row need this: uniqueness is on the
 * EXTERNAL side, so one title can carry several external rows (mangaplus keeps
 * one per language edition), and such a title is only really paused when every
 * one of its rows is. A `where` clause cannot express that; it would return the
 * title as active on the strength of a single unpaused row, or as paused on a
 * single paused one, depending which way it was written.
 */
export function isTrackedRowActive(
  row: { recheckAfter: Date | null },
  now: Date = new Date(),
): boolean {
  return row.recheckAfter === null || row.recheckAfter.getTime() <= now.getTime();
}

/**
 * The MangaDex titles a run may act on, from this extension's tracked rows and
 * whatever the workers reported.
 *
 * This is the withdrawal side of the pause, and it is the half that bites.
 * `removeMangaWithoutExternalChapters` queues a removal for every tracked id
 * absent from `allChapters` -- and a paused series is absent from `allChapters`
 * by construction, because it was withheld from the lease map. A pause applied
 * only to the lease map therefore does not skip a series; it takes its chapters
 * down from MangaDex.
 *
 * Two rules, both load-bearing:
 *
 *   per TITLE, not per row  one title can carry several external rows
 *                           (mangaplus keeps one per language edition) and is
 *                           only paused when all of them are. Otherwise pausing
 *                           one edition withdraws the others.
 *   the database wins       a worker that leased before the pause landed still
 *                           names the series, honestly. Unioning its report
 *                           blind would let an in-flight run undo the pause;
 *                           ids the database knows must also be active. Ids it
 *                           does NOT know still pass, which is what admits a
 *                           title mapped since the run started.
 *
 * Pure and exported so the rule is testable without a database.
 */
export function activeTrackedTitles(
  rows: readonly { mdMangaId: string; recheckAfter: Date | null }[],
  reportedByWorkers: readonly string[],
  now: Date = new Date(),
): string[] {
  const known = new Set<string>();
  const active = new Set<string>();
  for (const row of rows) {
    known.add(row.mdMangaId);
    if (isTrackedRowActive(row, now)) active.add(row.mdMangaId);
  }
  return [...new Set([...known, ...reportedByWorkers])].filter(
    (id) => !known.has(id) || active.has(id),
  );
}

/**
 * Build the lease payload from tracked rows.
 *
 * Rows in the default id space keep the `""` key when any other row is
 * namespaced; dropping them would hide half an extension's catalogue, and
 * inventing a name for them would not match the file the operator curates.
 */
export function buildMangaIdMap(
  rows: { mangaId: string; mdMangaId: string; namespace: string }[],
): MangaIdMapPayload {
  const namespaced = rows.some((row) => row.namespace !== DEFAULT_NAMESPACE);
  if (!namespaced) {
    const flat: FlatMangaIdMap = {};
    for (const row of rows) (flat[row.mdMangaId] ??= []).push(row.mangaId);
    return { mangaIdMap: flat, namespaced: false };
  }
  const nested: NamespacedMangaIdMap = {};
  for (const row of rows) {
    const bucket = (nested[row.namespace] ??= {});
    (bucket[row.mdMangaId] ??= []).push(row.mangaId);
  }
  return { mangaIdMap: nested, namespaced: true };
}

/**
 * How long a pause lasts when the caller does not say.
 *
 * A quarter is chosen to be long enough to be worth doing — it takes a frozen
 * series out of roughly twelve weekly clean runs — and short enough that a
 * publisher's change is noticed in a season rather than never.
 */
export const DEFAULT_COOLDOWN_DAYS = 90;
/** A decade. Past this the value is a typo, not an intention. */
export const MAX_COOLDOWN_DAYS = 3650;

export interface PauseTarget {
  mangaId: string;
  namespace?: string;
}

export interface PauseRequest {
  targets: PauseTarget[];
  /** Days to suppress for; defaults to {@link DEFAULT_COOLDOWN_DAYS}. */
  days?: number;
  /**
   * Whether the cooldown re-arms itself after each clean run that covers the
   * series. True is the frozen-catalogue case and the sensible default; false
   * is a one-shot hold that expires for good.
   */
  renew?: boolean;
  reason?: string;
  actor: string;
}

export interface PauseResult {
  changed: number;
  notFound: PauseTarget[];
  /** When the paused series next rejoins a run. Absent when unpausing. */
  recheckAfter?: Date;
}

export class TrackedMangaStore {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Suppress series from runs until their cooldown expires.
   *
   * Bulk by design. The motivating case is not one series but the long tail of
   * them: on Comikey a free set is the first N episodes and nothing else, so
   * "every series whose free set is one chapter" is hundreds of rows found by
   * one query and paused in one action. A per-row API would make the useful
   * operation a loop the operator has to write.
   *
   * Rows are matched on (namespace, mangaId) and missing ones are REPORTED
   * rather than failing the batch, matching applyBatch: an operator pasting 200
   * ids wants to know which three were wrong.
   */
  async pause(extension: string, request: PauseRequest): Promise<PauseResult> {
    const days = request.days ?? DEFAULT_COOLDOWN_DAYS;
    const now = new Date();
    const recheckAfter = new Date(now.getTime() + days * 86_400_000);
    const renew = request.renew ?? true;

    const { matched, notFound } = await this.resolveTargets(extension, request.targets);
    if (matched.length === 0) return { changed: 0, notFound, recheckAfter };

    const result = await this.prisma.trackedManga.updateMany({
      where: { id: { in: matched.map((row) => row.id) } },
      data: {
        recheckAfter,
        // NULL is what makes a pause one-shot, so `renew: false` must clear any
        // interval a previous pause left behind rather than inherit it.
        cooldownDays: renew ? days : null,
        pausedAt: now,
        pausedBy: request.actor,
        pauseReason: request.reason ?? null,
      },
    });
    return { changed: result.count, notFound, recheckAfter };
  }

  /**
   * Put paused series back in play immediately.
   *
   * Clears the interval as well as the deadline: leaving `cooldownDays` set on
   * an unpaused row would do nothing today (nothing reads it while
   * `recheckAfter` is NULL) but would silently re-arm the series if it were
   * ever paused again without an explicit interval.
   */
  async unpause(extension: string, targets: PauseTarget[]): Promise<PauseResult> {
    const { matched, notFound } = await this.resolveTargets(extension, targets);
    if (matched.length === 0) return { changed: 0, notFound };

    const result = await this.prisma.trackedManga.updateMany({
      where: { id: { in: matched.map((row) => row.id) } },
      data: {
        recheckAfter: null,
        cooldownDays: null,
        pausedAt: null,
        pausedBy: null,
        pauseReason: null,
      },
    });
    return { changed: result.count, notFound };
  }

  /**
   * Currently-suppressed series, soonest to return first.
   *
   * Rows whose cooldown has expired are deliberately absent: they are due, and
   * a run will pick them up, so listing them as "paused" would report a state
   * the system no longer acts on.
   */
  async listPaused(extension: string, now: Date = new Date()) {
    return this.prisma.trackedManga.findMany({
      where: pausedTrackedWhere(extension, now),
      orderBy: [{ recheckAfter: "asc" }, { mangaId: "asc" }],
    });
  }

  /** Match pause targets to rows, reporting the ones that do not exist. */
  private async resolveTargets(
    extension: string,
    targets: PauseTarget[],
  ): Promise<{ matched: { id: string }[]; notFound: PauseTarget[] }> {
    const wanted = new Map<string, PauseTarget>();
    for (const target of targets) {
      const namespace = normaliseNamespace(target.namespace);
      wanted.set(pairKey(namespace, target.mangaId), { mangaId: target.mangaId, namespace });
    }

    const rows = await this.prisma.trackedManga.findMany({
      where: { extension, mangaId: { in: targets.map((t) => t.mangaId) } },
      select: { id: true, namespace: true, mangaId: true },
    });

    const matched: { id: string }[] = [];
    for (const row of rows) {
      const key = pairKey(row.namespace, row.mangaId);
      if (!wanted.has(key)) continue;
      matched.push({ id: row.id });
      wanted.delete(key);
    }
    return { matched, notFound: [...wanted.values()] };
  }

  async list(extension: string, namespace?: string) {
    return this.prisma.trackedManga.findMany({
      where: { extension, ...(namespace === undefined ? {} : { namespace: normaliseNamespace(namespace) }) },
      orderBy: [{ namespace: "asc" }, { mangaId: "asc" }],
    });
  }

  /** The catalogues an extension actually has rows in, default space first. */
  async namespaces(extension: string): Promise<string[]> {
    const rows = await this.prisma.trackedManga.findMany({
      where: { extension },
      select: { namespace: true },
      distinct: ["namespace"],
      orderBy: { namespace: "asc" },
    });
    return rows.map((row) => row.namespace);
  }

  /**
   * Apply a batch. `canWrite` is the caller's tracked:write status: without it,
   * rows that would change an existing mapping are rejected individually (and
   * reported) rather than silently applied or the whole batch refused.
   *
   * With `dryRun`, every row is judged exactly as it would be and nothing is
   * written. The judgement above this line is already pure, it reads the
   * current mappings and decides outcomes, so the preview is the real thing
   * minus its last statement, not a second implementation that can drift.
   */
  async applyBatch(
    extension: string,
    request: BatchRequest,
    opts: { canWrite: boolean; source: string; dryRun?: boolean },
  ): Promise<BatchSummary> {
    const results: BatchRowResult[] = [];
    const set = request.set ?? [];
    const remove = request.remove ?? [];

    // Reported only when it is not the default, so a flat extension's results
    // are shaped exactly as they were before namespaces existed.
    const report = (
      namespace: string,
      row: Omit<BatchRowResult, "namespace">,
    ): void => {
      results.push(namespace === DEFAULT_NAMESPACE ? row : { ...row, namespace });
    };

    const existing = new Map(
      (
        await this.prisma.trackedManga.findMany({
          where: { extension },
          select: { namespace: true, mangaId: true, mdMangaId: true },
        })
      ).map((row) => [pairKey(row.namespace, row.mangaId), row.mdMangaId]),
    );

    // De-duplicate within the paste: last value wins, but say so.
    const deduped = new Map<string, { namespace: string; mangaId: string; mdMangaId: string }>();
    for (const row of set) {
      const namespace = normaliseNamespace(row.namespace);
      const key = pairKey(namespace, row.mangaId);
      const seen = deduped.get(key);
      if (seen && seen.mdMangaId !== row.mdMangaId) {
        report(namespace, {
          mangaId: row.mangaId,
          outcome: "invalid",
          detail: "listed twice with different title ids; the last one was used",
        });
      }
      deduped.set(key, { namespace, mangaId: row.mangaId, mdMangaId: row.mdMangaId });
    }

    const toCreate: {
      extension: string;
      namespace: string;
      mangaId: string;
      mdMangaId: string;
      source: string;
    }[] = [];
    const toUpdate: { namespace: string; mangaId: string; mdMangaId: string }[] = [];

    for (const [key, row] of deduped) {
      const { namespace, mangaId, mdMangaId } = row;
      if (!UUID_RE.test(mdMangaId)) {
        report(namespace, { mangaId, mdMangaId, outcome: "invalid", detail: "not a mangadex title id" });
        continue;
      }
      if (namespace !== DEFAULT_NAMESPACE && !NAMESPACE_RE.test(namespace)) {
        report(namespace, {
          mangaId,
          mdMangaId,
          outcome: "invalid",
          detail: `namespace must match ${String(NAMESPACE_RE)}`,
        });
        continue;
      }
      const current = existing.get(key);
      if (current === undefined) {
        toCreate.push({ extension, namespace, mangaId, mdMangaId, source: opts.source });
        report(namespace, { mangaId, mdMangaId, outcome: "added" });
      } else if (current === mdMangaId) {
        report(namespace, { mangaId, mdMangaId, outcome: "unchanged" });
      } else if (!opts.canWrite) {
        report(namespace, {
          mangaId,
          mdMangaId,
          outcome: "rejected_needs_write",
          detail: `already mapped to ${current}; changing it needs scope tracked:write`,
        });
      } else {
        toUpdate.push({ namespace, mangaId, mdMangaId });
        report(namespace, { mangaId, mdMangaId, outcome: "updated", detail: `was ${current}` });
      }
    }

    const removable: { namespace: string; mangaId: string }[] = [];
    const removeSeen = new Set<string>();
    for (const entry of remove) {
      const namespace = typeof entry === "string" ? DEFAULT_NAMESPACE : normaliseNamespace(entry.namespace);
      const mangaId = typeof entry === "string" ? entry : entry.mangaId;
      const key = pairKey(namespace, mangaId);
      if (removeSeen.has(key)) continue;
      removeSeen.add(key);

      if (!opts.canWrite) {
        report(namespace, {
          mangaId,
          outcome: "rejected_needs_write",
          detail: "removing a mapping needs scope tracked:write",
        });
      } else if (!existing.has(key)) {
        report(namespace, { mangaId, outcome: "not_found" });
      } else {
        removable.push({ namespace, mangaId });
        report(namespace, { mangaId, outcome: "removed" });
      }
    }

    // One transaction: a partially-applied paste is the worst outcome, because
    // the operator cannot tell what landed without diffing the table by hand.
    if (!opts.dryRun) {
      await this.prisma.$transaction(async (tx) => {
        if (toCreate.length > 0) {
          await tx.trackedManga.createMany({ data: toCreate, skipDuplicates: true });
        }
        for (const row of toUpdate) {
          await tx.trackedManga.updateMany({
            where: { extension, namespace: row.namespace, mangaId: row.mangaId },
            data: { mdMangaId: row.mdMangaId, source: opts.source },
          });
        }
        // Grouped by namespace so a 2000-row removal is one statement per
        // catalogue rather than one per row.
        const removeByNamespace = new Map<string, string[]>();
        for (const row of removable) {
          const bucket = removeByNamespace.get(row.namespace);
          if (bucket) bucket.push(row.mangaId);
          else removeByNamespace.set(row.namespace, [row.mangaId]);
        }
        for (const [namespace, mangaIds] of removeByNamespace) {
          await tx.trackedManga.deleteMany({
            where: { extension, namespace, mangaId: { in: mangaIds } },
          });
        }
      });
    }

    const count = (outcome: BatchOutcome) => results.filter((r) => r.outcome === outcome).length;
    return {
      added: count("added"),
      updated: count("updated"),
      unchanged: count("unchanged"),
      removed: count("removed"),
      failed: count("invalid") + count("rejected_needs_write") + count("not_found"),
      results,
    };
  }
}
