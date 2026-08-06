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

export class TrackedMangaStore {
  constructor(private readonly prisma: PrismaClient) {}

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
