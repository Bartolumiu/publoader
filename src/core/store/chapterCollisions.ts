import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Chapters we uploaded onto a number our own group already holds on MangaDex.
 *
 * The single implementation behind the processor that records them, the API
 * route the dashboard reads, and the Discord bot, so the surfaces cannot drift.
 *
 * Nothing here gates an upload. See `findNumberCollisions` in the dedupe module
 * for why the number is a warning and the url is the identity.
 */

/** One MangaDex chapter already sitting on the number, as stored in `existing`. */
export interface CollisionExisting {
  mdChapterId: string;
  chapterUrl: string | null;
  chapterTitle: string | null;
  createdAt: string | null;
}

export interface CollisionRecord {
  extension: string;
  chapterId: string | null;
  chapterUrl: string | null;
  mdMangaId: string;
  mangaName: string | null;
  chapterNumber: string | null;
  chapterLanguage: string;
  existing: CollisionExisting[];
  runId: string | null;
}

export interface CollisionEntry extends CollisionRecord {
  id: string;
  mdChapterId: string | null;
  detectedAt: Date;
  acknowledgedAt: Date | null;
  acknowledgedBy: string | null;
}

/** A page of the feed, plus what the page was drawn from. */
export interface CollisionPage {
  entries: CollisionEntry[];
  total: number;
  outstanding: number;
}

export const MAX_COLLISION_PAGE = 200;

export class ChapterCollisionStore {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Record what a run saw, one row per chapter.
   *
   * Upserted on the chapter's identity so a series re-checked every day keeps
   * one row that moves its `detectedAt` forward, rather than a row per run. An
   * acknowledgement is deliberately NOT cleared by a later sighting: the
   * operator judged this specific collision fine, and the same collision being
   * seen again is the same fact, not a new one.
   */
  async record(records: CollisionRecord[]): Promise<number> {
    let written = 0;
    for (const record of records) {
      // Raw, because the identity spans two nullable columns and Prisma's
      // compound-unique `where` will not take a null. The index is NULLS NOT
      // DISTINCT, so ON CONFLICT resolves it the way the identity means it:
      // two nulls are the same chapter, not two different ones.
      written += await this.prisma.$executeRaw`
        INSERT INTO chapter_collisions
          (id, extension, chapter_id, chapter_url, md_manga_id, manga_name,
           chapter_number, chapter_language, existing, run_id, detected_at)
        VALUES
          (gen_random_uuid()::text, ${record.extension}, ${record.chapterId},
           ${record.chapterUrl}, ${record.mdMangaId}, ${record.mangaName},
           ${record.chapterNumber}, ${record.chapterLanguage},
           ${JSON.stringify(record.existing)}::jsonb, ${record.runId}, now())
        ON CONFLICT (extension, chapter_id, chapter_number, chapter_language)
        DO UPDATE SET
          existing    = EXCLUDED.existing,
          chapter_url = EXCLUDED.chapter_url,
          manga_name  = EXCLUDED.manga_name,
          run_id      = EXCLUDED.run_id,
          detected_at = EXCLUDED.detected_at
      `;
    }
    return written;
  }

  /**
   * Attach the MangaDex chapter the upload produced, so the dashboard can show
   * the new chapter beside the ones it collided with.
   *
   * Keyed on the extension chapter id because that is what the upload task
   * carries; a chapter with no publisher id cannot be matched back and simply
   * keeps a null `mdChapterId`.
   */
  async attachUploaded(
    extension: string,
    chapterId: string | null,
    chapterNumber: string | null,
    chapterLanguage: string,
    mdChapterId: string,
  ): Promise<void> {
    if (chapterId === null) return;
    await this.prisma.chapterCollision.updateMany({
      where: { extension, chapterId, chapterNumber, chapterLanguage, mdChapterId: null },
      data: { mdChapterId },
    });
  }

  /** The feed. Unacknowledged first, then newest first within each half. */
  async list(opts: {
    extension?: string | null;
    includeAcknowledged?: boolean;
    limit?: number;
    offset?: number;
  } = {}): Promise<CollisionPage> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), MAX_COLLISION_PAGE);
    const where: Prisma.ChapterCollisionWhereInput = {};
    if (opts.extension) where.extension = opts.extension;
    if (opts.includeAcknowledged !== true) where.acknowledgedAt = null;

    const [rows, total, outstanding] = await Promise.all([
      this.prisma.chapterCollision.findMany({
        where,
        orderBy: [{ acknowledgedAt: { sort: "asc", nulls: "first" } }, { detectedAt: "desc" }],
        take: limit,
        skip: Math.max(opts.offset ?? 0, 0),
      }),
      this.prisma.chapterCollision.count({ where }),
      this.prisma.chapterCollision.count({
        where: { ...where, acknowledgedAt: null },
      }),
    ]);

    return { entries: rows.map(toEntry), total, outstanding };
  }

  /** How many nobody has looked at, for the Overview tile and the nav badge. */
  async countOutstanding(): Promise<number> {
    return this.prisma.chapterCollision.count({ where: { acknowledgedAt: null } });
  }

  /**
   * Mark collisions as looked at. Hides, never deletes: the row stays for the
   * audit trail and can be listed again with `includeAcknowledged`.
   */
  async acknowledge(ids: string[], by: string): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.prisma.chapterCollision.updateMany({
      where: { id: { in: ids }, acknowledgedAt: null },
      data: { acknowledgedAt: new Date(), acknowledgedBy: by },
    });
    return result.count;
  }

  /** Undo an acknowledgement, for one judged too quickly. */
  async unacknowledge(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.prisma.chapterCollision.updateMany({
      where: { id: { in: ids } },
      data: { acknowledgedAt: null, acknowledgedBy: null },
    });
    return result.count;
  }
}

function toEntry(row: {
  id: string;
  extension: string;
  chapterId: string | null;
  chapterUrl: string | null;
  mdMangaId: string;
  mangaName: string | null;
  chapterNumber: string | null;
  chapterLanguage: string;
  existing: Prisma.JsonValue;
  mdChapterId: string | null;
  runId: string | null;
  detectedAt: Date;
  acknowledgedAt: Date | null;
  acknowledgedBy: string | null;
}): CollisionEntry {
  return {
    id: row.id,
    extension: row.extension,
    chapterId: row.chapterId,
    chapterUrl: row.chapterUrl,
    mdMangaId: row.mdMangaId,
    mangaName: row.mangaName,
    chapterNumber: row.chapterNumber,
    chapterLanguage: row.chapterLanguage,
    existing: Array.isArray(row.existing) ? (row.existing as unknown as CollisionExisting[]) : [],
    mdChapterId: row.mdChapterId,
    runId: row.runId,
    detectedAt: row.detectedAt,
    acknowledgedAt: row.acknowledgedAt,
    acknowledgedBy: row.acknowledgedBy,
  };
}
