import { Prisma, type PrismaClient } from "@prisma/client";
import { chapterFromColumns, type StoredChapterRow } from "../md/chapterRows.js";
import type { Chapter } from "../md/types.js";

/**
 * Read access to the four chapter history tables; what this platform has put
 * on MangaDex, and what has since happened to it.
 *
 * The writers already exist (processor.ts records uploads, taskWorkers.ts
 * archives deletes/unavailables/edits); until now nothing could *read* them
 * back, so "which chapter is this, and is it still up?" meant `psql` on the
 * core container. This is the read half, and it is deliberately read-only:
 * every mutation an operator can ask for goes through the upload-task queue,
 * because core-uploader is the only process holding MangaDex write credentials.
 *
 * The four tables are structurally identical (see md/chapterRows.ts), so one
 * parameterised query serves all four. Table and column names come from the
 * closed ARCHIVES map below and never from a request; `Prisma.raw` appears
 * only with values from that map, and every operator-supplied value is bound.
 */

export const CHAPTER_ARCHIVES = ["uploaded", "unavailable", "deleted", "edited"] as const;
export type ChapterArchive = (typeof CHAPTER_ARCHIVES)[number];

interface ArchiveSpec {
  /** Physical table. */
  table: string;
  /** The column that dates the row; what "at" means for this archive. */
  instant: string;
  /** Human name for messages, matching the vocabulary the dashboard uses. */
  label: string;
}

/**
 * The one place an archive name becomes SQL. Every table below has the same
 * chapter columns; they differ only in which instant dates the row, which is
 * exactly the thing each archive exists to record.
 */
export const ARCHIVES: Record<ChapterArchive, ArchiveSpec> = {
  uploaded: { table: "uploaded_chapters", instant: "created_at", label: "on MangaDex" },
  unavailable: { table: "unavailable_chapters", instant: "unavailable_at", label: "marked unavailable" },
  deleted: { table: "deleted_chapters", instant: "deleted_at", label: "deleted from MangaDex" },
  edited: { table: "edited_chapters", instant: "last_edited_at", label: "edited" },
};

export function isChapterArchive(value: string): value is ChapterArchive {
  return Object.hasOwn(ARCHIVES, value);
}

/** A row of any of the four tables, plus the instant that dates it. */
export interface ChapterRow extends StoredChapterRow {
  id: string;
  mdChapterId: string;
  extension: string | null;
  at: Date;
  /** Number of recorded edits; only the `edited` archive carries them. */
  editCount?: number;
}

export interface ChapterFilter {
  extension?: string;
  chapterLanguage?: string;
  mdMangaId?: string;
  mdChapterId?: string;
  chapterId?: string;
  chapterNumber?: string;
  /** Case-insensitive substring over the names and the four ids. */
  search?: string;
  since?: Date;
  until?: Date;
}

/**
 * Keyset position in `(at DESC, id DESC)`.
 *
 * Offset paging would be wrong here for the same reason it is wrong for the
 * queue: `uploaded_chapters` grows while it is being read (every commit inserts
 * a row at the top of this ordering), so page 2 of an offset scan repeats rows
 * page 1 already showed.
 */
export interface ChapterCursor {
  at: Date;
  id: string;
}

export function encodeChapterCursor(row: ChapterCursor): string {
  return Buffer.from(`${row.at.toISOString()}|${row.id}`, "utf8").toString("base64url");
}

/** Null for anything unparseable; the caller answers 400 rather than guessing. */
export function decodeChapterCursor(raw: string): ChapterCursor | null {
  const parts = Buffer.from(raw, "base64url").toString("utf8").split("|");
  if (parts.length !== 2) return null;
  const [at, id] = parts as [string, string];
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  return { at: when, id };
}

/** Where a MangaDex chapter id appears across the four tables. */
export interface ChapterHistory {
  uploaded: ChapterRow | null;
  unavailable: ChapterRow | null;
  deleted: ChapterRow | null;
  edited: (ChapterRow & { edits: unknown[] }) | null;
}

export class ChapterStore {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * One page of an archive, newest first, plus the total matching the filter.
   *
   * Newest-first is the operator's ordering, not the machine's: the chapter
   * somebody is looking for is nearly always one that was just published, and
   * the reason to open this view at all is usually "the last upload was wrong".
   */
  async list(
    archive: ChapterArchive,
    filter: ChapterFilter,
    opts: { limit: number; cursor?: ChapterCursor | null },
  ): Promise<{ chapters: ChapterRow[]; total: number; nextCursor: string | null }> {
    const spec = ARCHIVES[archive];
    const instant = Prisma.raw(`c.${spec.instant}`);
    const from = Prisma.raw(spec.table);
    const parts = chapterWhere(filter, spec);
    if (opts.cursor) {
      parts.push(Prisma.sql`(${instant}, c.id) < (${opts.cursor.at}, ${opts.cursor.id})`);
    }

    // One row beyond the page, so "is there another page?" costs no extra query.
    const [rows, counted] = await Promise.all([
      this.prisma.$queryRaw<ChapterRow[]>(Prisma.sql`
        SELECT ${chapterColumns(spec)} FROM ${from} c
        ${combine(parts)}
        ORDER BY ${instant} DESC, c.id DESC
        LIMIT ${opts.limit + 1}
      `),
      this.prisma.$queryRaw<{ total: bigint }[]>(Prisma.sql`
        SELECT count(*) AS total FROM ${from} c ${combine(chapterWhere(filter, spec))}
      `),
    ]);

    const page = rows.slice(0, opts.limit);
    const last = page[page.length - 1];
    return {
      chapters: page,
      total: Number(counted[0]?.total ?? 0),
      nextCursor: rows.length > opts.limit && last ? encodeChapterCursor(last) : null,
    };
  }

  async get(archive: ChapterArchive, mdChapterId: string): Promise<ChapterRow | null> {
    const spec = ARCHIVES[archive];
    const rows = await this.prisma.$queryRaw<ChapterRow[]>(Prisma.sql`
      SELECT ${chapterColumns(spec)} FROM ${Prisma.raw(spec.table)} c
      WHERE c.md_chapter_id = ${mdChapterId}
    `);
    return rows[0] ?? null;
  }

  /**
   * Rows for many ids from one archive, in ONE query.
   *
   * The per-id lookup that `get` supports would be four queries per chapter on
   * the locate path; a bulk action over two hundred chapters would then be
   * eight hundred round trips before it wrote anything. This keeps a bulk
   * resolution at four queries total, whatever the size of the selection.
   */
  async manyByIds(archive: ChapterArchive, ids: readonly string[]): Promise<ChapterRow[]> {
    if (ids.length === 0) return [];
    const spec = ARCHIVES[archive];
    return this.prisma.$queryRaw<ChapterRow[]>(Prisma.sql`
      SELECT ${chapterColumns(spec)} FROM ${Prisma.raw(spec.table)} c
      WHERE c.md_chapter_id = ANY(${[...ids]}::text[])
    `);
  }

  /**
   * Chapter ids matching a filter, in the list's own order, capped.
   *
   * Backs `{filter: …}` bulk calls. The cap is applied here rather than by the
   * caller so an over-wide filter cannot become an unbounded read on its way to
   * becoming an unbounded write.
   */
  async idsMatching(
    archive: ChapterArchive,
    filter: ChapterFilter,
    cap: number,
  ): Promise<string[]> {
    const spec = ARCHIVES[archive];
    const rows = await this.prisma.$queryRaw<{ mdChapterId: string }[]>(Prisma.sql`
      SELECT c.md_chapter_id AS "mdChapterId" FROM ${Prisma.raw(spec.table)} c
      ${combine(chapterWhere(filter, spec))}
      ORDER BY ${Prisma.raw(`c.${spec.instant}`)} DESC, c.id DESC
      LIMIT ${cap}
    `);
    return rows.map((row) => row.mdChapterId);
  }

  async countMatching(archive: ChapterArchive, filter: ChapterFilter): Promise<number> {
    const spec = ARCHIVES[archive];
    const rows = await this.prisma.$queryRaw<{ total: bigint }[]>(Prisma.sql`
      SELECT count(*) AS total FROM ${Prisma.raw(spec.table)} c
      ${combine(chapterWhere(filter, spec))}
    `);
    return Number(rows[0]?.total ?? 0);
  }

  /**
   * Every trace of one MangaDex chapter id.
   *
   * All four tables are read, not just the one the operator arrived from: a
   * chapter that is in `deleted_chapters` and also in `uploaded_chapters` is a
   * genuine inconsistency worth seeing, and the edit history explains a chapter
   * whose current values do not match what the source says.
   */
  async history(mdChapterId: string): Promise<ChapterHistory> {
    const [uploaded, unavailable, deleted, edited] = await Promise.all([
      this.get("uploaded", mdChapterId),
      this.get("unavailable", mdChapterId),
      this.get("deleted", mdChapterId),
      this.get("edited", mdChapterId),
    ]);

    let edits: unknown[] = [];
    if (edited) {
      const row = await this.prisma.editedChapter.findUnique({
        where: { mdChapterId },
        select: { edits: true },
      });
      edits = Array.isArray(row?.edits) ? row.edits : [];
    }
    return {
      uploaded,
      unavailable,
      deleted,
      edited: edited ? { ...edited, edits } : null,
    };
  }

  /**
   * Per-extension counts for one archive, for the filter picker, for the "what
   * does this extension have up?" question the Extensions view asks, and; with
   * a filter; for the breakdown a bulk dry run reports, which is how an
   * operator recognises the set they are about to act on.
   */
  async byExtension(
    archive: ChapterArchive,
    filter: ChapterFilter = {},
  ): Promise<{ extension: string; count: number }[]> {
    const spec = ARCHIVES[archive];
    const rows = await this.prisma.$queryRaw<{ extension: string | null; count: bigint }[]>(Prisma.sql`
      SELECT c.extension, count(*) AS count FROM ${Prisma.raw(spec.table)} c
      ${combine(chapterWhere(filter, spec))}
      GROUP BY c.extension ORDER BY count DESC, c.extension ASC
    `);
    // "" is the stand-in uploaded_chapters uses for an unattributed chapter
    // (the column is NOT NULL there); the other three tables allow NULL. Both
    // mean the same thing to a reader, so both surface as "".
    return rows.map((row) => ({ extension: row.extension ?? "", count: Number(row.count) }));
  }

  /** Row counts for all four archives; the header of the Chapters view. */
  async totals(): Promise<Record<ChapterArchive, number>> {
    const entries = await Promise.all(
      CHAPTER_ARCHIVES.map(async (archive) => {
        const rows = await this.prisma.$queryRaw<{ total: bigint }[]>(
          Prisma.sql`SELECT count(*) AS total FROM ${Prisma.raw(ARCHIVES[archive].table)} c`,
        );
        return [archive, Number(rows[0]?.total ?? 0)] as const;
      }),
    );
    return Object.fromEntries(entries) as Record<ChapterArchive, number>;
  }
}

/**
 * A stored row as the canonical `Chapter` the upload queue carries.
 *
 * This is the bridge between the read side and the write side: an operator
 * action on a chapter is executed by building a task payload from the row that
 * records it, so the queued work describes the chapter the operator was
 * actually looking at.
 */
export function chapterOf(row: ChapterRow): Chapter {
  return chapterFromColumns(row);
}

// ------------------------------------------------------------------ internals

/**
 * The shared columns, aliased to the Prisma field names, plus the archive's own
 * instant as `at` and (for edited_chapters) the size of the edit history.
 *
 * `jsonb_array_length` is guarded by `jsonb_typeof` because it errors rather
 * than returning NULL on a non-array, and one hand-written row would then break
 * the whole listing.
 */
function chapterColumns(spec: ArchiveSpec): Prisma.Sql {
  const extra =
    spec.table === "edited_chapters"
      ? Prisma.sql`, CASE WHEN jsonb_typeof(c.edits) = 'array' THEN jsonb_array_length(c.edits) ELSE 0 END::int AS "editCount"`
      : Prisma.empty;
  return Prisma.sql`c.id, c.md_chapter_id AS "mdChapterId", c.extension,
    c.chapter_id AS "chapterId", c.chapter_url AS "chapterUrl",
    c.chapter_number AS "chapterNumber", c.chapter_title AS "chapterTitle",
    c.chapter_volume AS "chapterVolume", c.chapter_language AS "chapterLanguage",
    c.chapter_timestamp AS "chapterTimestamp", c.chapter_expire AS "chapterExpire",
    c.chapter_lookup AS "chapterLookup", c.manga_id AS "mangaId",
    c.manga_name AS "mangaName", c.manga_url AS "mangaUrl",
    c.md_manga_id AS "mdMangaId", c.md_group_id AS "mdGroupId", c.extra,
    ${Prisma.raw(`c.${spec.instant}`)} AS "at"${extra}`;
}

function chapterWhere(filter: ChapterFilter, spec: ArchiveSpec): Prisma.Sql[] {
  const parts: Prisma.Sql[] = [];
  // `extension = ''` is how an unattributed chapter is stored in
  // uploaded_chapters and NULL in the other three, so asking for "" means both.
  if (filter.extension === "") {
    parts.push(Prisma.sql`(c.extension IS NULL OR c.extension = '')`);
  } else if (filter.extension !== undefined) {
    parts.push(Prisma.sql`c.extension = ${filter.extension}`);
  }
  if (filter.chapterLanguage) parts.push(Prisma.sql`c.chapter_language = ${filter.chapterLanguage}`);
  if (filter.mdMangaId) parts.push(Prisma.sql`c.md_manga_id = ${filter.mdMangaId}`);
  if (filter.mdChapterId) parts.push(Prisma.sql`c.md_chapter_id = ${filter.mdChapterId}`);
  if (filter.chapterId) parts.push(Prisma.sql`c.chapter_id = ${filter.chapterId}`);
  if (filter.chapterNumber) parts.push(Prisma.sql`c.chapter_number = ${filter.chapterNumber}`);
  if (filter.search) {
    // Parameterised, so a `%` an operator types is the wildcard they meant and
    // a quote is data either way. The ids are included because the commonest
    // way to arrive here is with an id pasted from a MangaDex URL or a Discord
    // embed, and requiring the operator to know which field it is defeats the
    // point of a search box.
    const like = `%${filter.search}%`;
    parts.push(Prisma.sql`(
      c.manga_name ILIKE ${like} OR c.chapter_title ILIKE ${like} OR
      c.chapter_id ILIKE ${like} OR c.md_chapter_id ILIKE ${like} OR
      c.md_manga_id ILIKE ${like} OR c.chapter_url ILIKE ${like}
    )`);
  }
  if (filter.since) parts.push(Prisma.sql`${Prisma.raw(`c.${spec.instant}`)} >= ${filter.since}`);
  if (filter.until) parts.push(Prisma.sql`${Prisma.raw(`c.${spec.instant}`)} <= ${filter.until}`);
  return parts;
}

function combine(parts: Prisma.Sql[]): Prisma.Sql {
  return parts.length > 0 ? Prisma.sql`WHERE ${Prisma.join(parts, " AND ")}` : Prisma.empty;
}
