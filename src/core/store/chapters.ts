import { Prisma, type PrismaClient } from "@prisma/client";
import { chapterFromColumns, type StoredChapterRow } from "../md/chapterRows.js";
import type { Chapter } from "../md/types.js";

/**
 * The catalogue of chapters this platform has put on MangaDex — read, searched,
 * and (through an EDIT task) corrected.
 *
 * `uploaded_chapters` is the canonical mirror of what exists on MangaDex under
 * our group; `edited_chapters` is the append-only history of corrections;
 * `unavailable_chapters` and `deleted_chapters` are what has since been marked
 * unavailable or removed. All four share one column layout (see
 * md/chapterRows.ts), so one projection reads any of them.
 *
 * Nothing here writes to MangaDex. A metadata correction becomes an EDIT row on
 * the upload queue — the same row the processor would have written — so it goes
 * through the one process that holds the credentials, gets the same retry and
 * audit treatment as every other write, and can be inspected or cancelled on the
 * Queues page before it lands.
 */

/** The four chapter archives, by the name the API takes. */
export const CHAPTER_TABLES = ["uploaded", "edited", "unavailable", "deleted"] as const;
export type ChapterTable = (typeof CHAPTER_TABLES)[number];

const TABLE_SQL: Record<ChapterTable, Prisma.Sql> = {
  uploaded: Prisma.raw("uploaded_chapters"),
  edited: Prisma.raw("edited_chapters"),
  unavailable: Prisma.raw("unavailable_chapters"),
  deleted: Prisma.raw("deleted_chapters"),
};

/**
 * The instant each table sorts and pages by. Every one of the four records a
 * different moment in a chapter's life, and ordering by the wrong one would put
 * an archive in an order that means nothing (`created_at` on `deleted_chapters`
 * is when the row was archived, which is what `deleted_at` already says).
 */
const ORDER_COLUMN: Record<ChapterTable, Prisma.Sql> = {
  uploaded: Prisma.raw("updated_at"),
  edited: Prisma.raw("last_edited_at"),
  unavailable: Prisma.raw("unavailable_at"),
  deleted: Prisma.raw("deleted_at"),
};

export interface ChapterFilter {
  extension?: string;
  /** Case-insensitive substring over manga name, chapter title, number and id. */
  q?: string;
  mdMangaId?: string;
  language?: string;
}

/** A stored chapter, flattened for a list view. */
export interface StoredChapter extends Chapter {
  /** The row's own instant in the sense that table records — see ORDER_COLUMN. */
  at: Date | null;
  extra: unknown;
}

/** Everything known about one chapter across the four tables. */
export interface ChapterDetail {
  chapter: Chapter;
  extra: unknown;
  /** Which of the four tables hold a row for this MangaDex chapter id. */
  present: ChapterTable[];
  /** `{editedAt, old, new}` entries, oldest first. Empty when never edited. */
  edits: unknown[];
  uploadedAt: Date | null;
  updatedAt: Date | null;
  lastEditedAt: Date | null;
  unavailableAt: Date | null;
  deletedAt: Date | null;
}

export class ChapterStore {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * One page of a chapter archive, newest first.
   *
   * Offset paging is correct here in a way it is not for the queues: these
   * tables are effectively append-only history, so a page does not shift under
   * the reader the way a draining queue does. `updated_at DESC, id` keeps the
   * ordering total so a tie cannot duplicate or drop a row across pages.
   */
  async list(
    table: ChapterTable,
    filter: ChapterFilter,
    opts: { limit: number; offset: number },
  ): Promise<{ chapters: StoredChapter[]; total: number }> {
    const clause = where(filter);
    const [rows, counted] = await Promise.all([
      this.prisma.$queryRaw<(StoredChapterRow & { at: Date | null })[]>(Prisma.sql`
        SELECT md_chapter_id AS "mdChapterId", extension, chapter_id AS "chapterId",
               chapter_url AS "chapterUrl", chapter_number AS "chapterNumber",
               chapter_title AS "chapterTitle", chapter_volume AS "chapterVolume",
               chapter_language AS "chapterLanguage", chapter_timestamp AS "chapterTimestamp",
               chapter_expire AS "chapterExpire", chapter_lookup AS "chapterLookup",
               manga_id AS "mangaId", manga_name AS "mangaName", manga_url AS "mangaUrl",
               md_manga_id AS "mdMangaId", md_group_id AS "mdGroupId", extra,
               ${ORDER_COLUMN[table]} AS "at"
        FROM ${TABLE_SQL[table]} t
        ${clause}
        ORDER BY ${ORDER_COLUMN[table]} DESC, t.id ASC
        LIMIT ${opts.limit} OFFSET ${opts.offset}
      `),
      this.prisma.$queryRaw<{ total: bigint }[]>(Prisma.sql`
        SELECT count(*) AS total FROM ${TABLE_SQL[table]} t ${clause}
      `),
    ]);

    return {
      chapters: rows.map((row) => ({
        ...chapterFromColumns(row),
        at: row.at,
        extra: row.extra ?? null,
      })),
      total: Number(counted[0]?.total ?? 0),
    };
  }

  /**
   * One chapter across all four tables.
   *
   * The uploaded row is authoritative for "what is on MangaDex"; the others say
   * what has happened to it. A chapter that appears in `deleted` is not there
   * any more, and offering an edit form for it would queue a task that fails at
   * MangaDex — so the caller needs all four before it can decide.
   */
  async detail(mdChapterId: string): Promise<ChapterDetail | null> {
    const [uploaded, edited, unavailable, deleted] = await Promise.all([
      this.prisma.uploadedChapter.findUnique({ where: { mdChapterId } }),
      this.prisma.editedChapter.findUnique({ where: { mdChapterId } }),
      this.prisma.unavailableChapter.findUnique({ where: { mdChapterId } }),
      this.prisma.deletedChapter.findUnique({ where: { mdChapterId } }),
    ]);

    // Preference order is "most current first": the uploaded mirror, then the
    // last edit, then the archives. A row missing from `uploaded` but present in
    // `deleted` still has a full chapter to show.
    const source = uploaded ?? edited ?? unavailable ?? deleted;
    if (!source) return null;

    const present: ChapterTable[] = [];
    if (uploaded) present.push("uploaded");
    if (edited) present.push("edited");
    if (unavailable) present.push("unavailable");
    if (deleted) present.push("deleted");

    return {
      chapter: { ...chapterFromColumns(source as StoredChapterRow), mdChapterId },
      extra: source.extra ?? null,
      present,
      edits: Array.isArray(edited?.edits) ? (edited.edits as unknown[]) : [],
      uploadedAt: uploaded?.createdAt ?? null,
      updatedAt: uploaded?.updatedAt ?? null,
      lastEditedAt: edited?.lastEditedAt ?? null,
      unavailableAt: unavailable?.unavailableAt ?? null,
      deletedAt: deleted?.deletedAt ?? null,
    };
  }

  /** Distinct extensions that have uploaded something, for a filter picker. */
  async extensions(table: ChapterTable): Promise<{ extension: string; count: number }[]> {
    const rows = await this.prisma.$queryRaw<{ extension: string | null; count: bigint }[]>(Prisma.sql`
      SELECT extension, count(*) AS count FROM ${TABLE_SQL[table]}
      GROUP BY extension ORDER BY count DESC
    `);
    return rows
      .filter((row) => row.extension !== null && row.extension !== "")
      .map((row) => ({ extension: row.extension!, count: Number(row.count) }));
  }
}

// ------------------------------------------------------------------ internals

function where(filter: ChapterFilter): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (filter.extension) parts.push(Prisma.sql`t.extension = ${filter.extension}`);
  if (filter.mdMangaId) parts.push(Prisma.sql`t.md_manga_id = ${filter.mdMangaId}`);
  if (filter.language) parts.push(Prisma.sql`t.chapter_language = ${filter.language}`);
  if (filter.q) {
    const needle = `%${filter.q}%`;
    parts.push(Prisma.sql`(
      t.manga_name ILIKE ${needle} OR t.chapter_title ILIKE ${needle}
      OR t.chapter_number ILIKE ${needle} OR t.chapter_id ILIKE ${needle}
      OR t.md_chapter_id ILIKE ${needle}
    )`);
  }
  return parts.length > 0 ? Prisma.sql`WHERE ${Prisma.join(parts, " AND ")}` : Prisma.empty;
}
