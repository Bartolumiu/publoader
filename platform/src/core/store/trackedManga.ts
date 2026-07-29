import type { PrismaClient } from "@prisma/client";

/**
 * Bulk curation of the series map.
 *
 * The map used to live in `manga_id_map.json` inside each extension bundle, so
 * adding a hundred series meant editing a file, opening a pull request and
 * republishing. The database is authoritative now, which makes bulk editing an
 * API concern — and a permissions concern, because "add series" is a job worth
 * delegating to a contributor while "repoint or delete a series" is not.
 *
 * Every operation reports per-row outcomes rather than failing the whole batch:
 * a contributor pasting 200 lines wants to know which three were wrong, not
 * that "the batch failed".
 */

export const MAX_BATCH_ROWS = 2000;

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
  mdMangaId?: string;
  outcome: BatchOutcome;
  detail?: string;
}

export interface BatchRequest {
  /** Create or (with tracked:write) repoint these mappings. */
  set?: { mangaId: string; mdMangaId: string }[];
  /** Remove these external ids. Requires tracked:write. */
  remove?: string[];
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

/**
 * Parse the format humans actually have: lines of `externalId,mdMangaId`.
 * Also accepts whitespace/tab/semicolon separators, `#` comments, a header row,
 * and the reverse order (uuid first) — because someone will paste it that way
 * and guessing correctly is better than rejecting a whole paste over column
 * order. Returns per-line errors instead of throwing.
 */
export function parsePairs(text: string): {
  rows: { mangaId: string; mdMangaId: string }[];
  errors: { line: number; text: string; reason: string }[];
} {
  const rows: { mangaId: string; mdMangaId: string }[] = [];
  const errors: { line: number; text: string; reason: string }[] = [];

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.split("#")[0]!.trim();
    if (line.length === 0) return;
    const parts = line.split(/[\s,;|]+/).filter(Boolean);
    if (parts.length < 2) {
      errors.push({ line: index + 1, text: line, reason: "expected two values: externalId and mangadex title id" });
      return;
    }
    const [a, b] = [parts[0]!, parts[1]!];
    // Skip an obvious header row rather than reporting it as an error.
    if (!UUID_RE.test(a) && !UUID_RE.test(b)) {
      if (index === 0) return;
      errors.push({ line: index + 1, text: line, reason: "neither value is a mangadex title id (uuid)" });
      return;
    }
    const mdMangaId = UUID_RE.test(b) ? b : a;
    const mangaId = UUID_RE.test(b) ? a : b;
    if (mangaId.length === 0 || mangaId.length > 512) {
      errors.push({ line: index + 1, text: line, reason: "external id is empty or too long" });
      return;
    }
    rows.push({ mangaId, mdMangaId: mdMangaId.toLowerCase() });
  });

  return { rows, errors };
}

export class TrackedMangaStore {
  constructor(private readonly prisma: PrismaClient) {}

  async list(extension: string) {
    return this.prisma.trackedManga.findMany({
      where: { extension },
      orderBy: { mangaId: "asc" },
    });
  }

  /**
   * Apply a batch. `canWrite` is the caller's tracked:write status: without it,
   * rows that would change an existing mapping are rejected individually (and
   * reported) rather than silently applied or the whole batch refused.
   */
  async applyBatch(
    extension: string,
    request: BatchRequest,
    opts: { canWrite: boolean; source: string },
  ): Promise<BatchSummary> {
    const results: BatchRowResult[] = [];
    const set = request.set ?? [];
    const remove = request.remove ?? [];

    const existing = new Map(
      (
        await this.prisma.trackedManga.findMany({
          where: { extension },
          select: { mangaId: true, mdMangaId: true },
        })
      ).map((row) => [row.mangaId, row.mdMangaId]),
    );

    // De-duplicate within the paste: last value wins, but say so.
    const deduped = new Map<string, string>();
    for (const row of set) {
      if (deduped.has(row.mangaId) && deduped.get(row.mangaId) !== row.mdMangaId) {
        results.push({
          mangaId: row.mangaId,
          outcome: "invalid",
          detail: "listed twice with different title ids; the last one was used",
        });
      }
      deduped.set(row.mangaId, row.mdMangaId);
    }

    const toCreate: { extension: string; mangaId: string; mdMangaId: string; source: string }[] = [];
    const toUpdate: { mangaId: string; mdMangaId: string }[] = [];

    for (const [mangaId, mdMangaId] of deduped) {
      if (!UUID_RE.test(mdMangaId)) {
        results.push({ mangaId, mdMangaId, outcome: "invalid", detail: "not a mangadex title id" });
        continue;
      }
      const current = existing.get(mangaId);
      if (current === undefined) {
        toCreate.push({ extension, mangaId, mdMangaId, source: opts.source });
        results.push({ mangaId, mdMangaId, outcome: "added" });
      } else if (current === mdMangaId) {
        results.push({ mangaId, mdMangaId, outcome: "unchanged" });
      } else if (!opts.canWrite) {
        results.push({
          mangaId,
          mdMangaId,
          outcome: "rejected_needs_write",
          detail: `already mapped to ${current}; changing it needs scope tracked:write`,
        });
      } else {
        toUpdate.push({ mangaId, mdMangaId });
        results.push({ mangaId, mdMangaId, outcome: "updated", detail: `was ${current}` });
      }
    }

    const removable: string[] = [];
    for (const mangaId of new Set(remove)) {
      if (!opts.canWrite) {
        results.push({
          mangaId,
          outcome: "rejected_needs_write",
          detail: "removing a mapping needs scope tracked:write",
        });
      } else if (!existing.has(mangaId)) {
        results.push({ mangaId, outcome: "not_found" });
      } else {
        removable.push(mangaId);
        results.push({ mangaId, outcome: "removed" });
      }
    }

    // One transaction: a partially-applied paste is the worst outcome, because
    // the operator cannot tell what landed without diffing the table by hand.
    await this.prisma.$transaction(async (tx) => {
      if (toCreate.length > 0) {
        await tx.trackedManga.createMany({ data: toCreate, skipDuplicates: true });
      }
      for (const row of toUpdate) {
        await tx.trackedManga.updateMany({
          where: { extension, mangaId: row.mangaId },
          data: { mdMangaId: row.mdMangaId, source: opts.source },
        });
      }
      if (removable.length > 0) {
        await tx.trackedManga.deleteMany({ where: { extension, mangaId: { in: removable } } });
      }
    });

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
