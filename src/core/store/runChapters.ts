import { Prisma, type PrismaClient } from "@prisma/client";
import {
  isoTimeKeys,
  numericTextKeys,
  ordering,
  resolveSort,
  textKeys,
  type OrderKey,
  type SortColumns,
  type SortRequest,
} from "./ordering.js";

/**
 * What a run actually found, read back out of the result envelopes.
 *
 * A worker's envelope is already the durable record of a scrape; it is stored
 * verbatim in `result_submissions.envelope` and the processor reads it to decide
 * what to upload. Nothing else ever exposed it, so "what did mangaplus find this
 * morning?" was a question only answerable by `psql` and a `jsonb` path. This
 * store is that question, one query.
 *
 * The chapters are NOT copied into a table on ingest. Doing so would duplicate
 * up to 20 000 rows per segment (`MAX_CHAPTERS_PER_ENVELOPE`) whose only reader
 * is a human looking at one run, and would need a second write path to stay
 * honest with the envelope. Postgres unnests the array on demand instead, so the
 * envelope stays the single source of truth and paging happens in the database
 * rather than in the API process.
 *
 * `updatedChapters` is what the extension reported as new or changed this run;
 * the set the processor turns into upload and edit tasks. `allChapters` is the
 * optional full catalogue snapshot an extension may also send (it is what drives
 * removal detection), and it is null for extensions that do not send one, which
 * is why the two are separate `set` values rather than one list with a flag.
 */

/** Which array of the envelope to read. */
/**
 * What a run's chapter listing can be ordered by, under the console's column
 * names. `position` is the default: the order the extension reported them in,
 * which is the only ordering the envelope itself asserts.
 */
export const RUN_CHAPTER_SORTS = [
  "position",
  "series",
  "chapter",
  "volume",
  "title",
  "language",
  "released",
  "segment",
] as const;

const RUN_CHAPTER_SORT_COLUMNS: SortColumns = {
  position: [
    { sql: Prisma.sql`j.segment_index`, cast: "numeric", dir: "follow" },
    { sql: Prisma.sql`c.position`, cast: "numeric", dir: "follow" },
  ],
  series: textKeys(Prisma.sql`c.value->>'mangaName'`),
  chapter: numericTextKeys(Prisma.sql`c.value->>'chapterNumber'`),
  volume: numericTextKeys(Prisma.sql`c.value->>'chapterVolume'`),
  title: textKeys(Prisma.sql`c.value->>'chapterTitle'`),
  language: textKeys(Prisma.sql`c.value->>'chapterLanguage'`),
  released: isoTimeKeys(Prisma.sql`c.value->>'chapterTimestamp'`),
  segment: [{ sql: Prisma.sql`j.segment_index`, cast: "numeric", dir: "follow" }],
};

/**
 * The tiebreak. There is no id here — a chapter is an element of a JSON array,
 * not a row — so its place in the envelope stands in for one, which is unique
 * within a job and paired with the job id below.
 */
const RUN_CHAPTER_ID: OrderKey = { sql: Prisma.sql`(j.id::text || ':' || c.position)`, cast: "text", dir: "follow" };

export const CHAPTER_SETS = ["updated", "all"] as const;
export type ChapterSet = (typeof CHAPTER_SETS)[number];

const ENVELOPE_KEY: Record<ChapterSet, string> = {
  updated: "updatedChapters",
  all: "allChapters",
};

export interface RunChapterFilter {
  /** Case-insensitive substring over the manga name, chapter title and number. */
  q?: string;
  /** Exact MangaDex title id. */
  mdMangaId?: string;
  /** Exact chapter language as the extension reported it. */
  language?: string;
  /** One segment of a fanned-out run, by its index. */
  segmentIndex?: number;
}

/** One chapter as the extension reported it, plus where it came from. */
export interface RunChapterRow {
  jobId: string;
  segmentIndex: number;
  segmentKey: string | null;
  /** 1-based position within that segment's array; the extension's own order. */
  position: number;
  chapter: Record<string, unknown>;
}

/** Per-segment coverage: how many chapters each job's envelope carried. */
export interface RunSegmentCounts {
  jobId: string;
  segmentIndex: number;
  segmentKey: string | null;
  jobState: string;
  /** Null when this segment has no committed envelope yet. */
  updated: number | null;
  /** Null when the segment sent no catalogue snapshot (or has not reported). */
  all: number | null;
  untrackedManga: number | null;
  submittedAt: Date | null;
}

/**
 * What one run found, in the shape the runs list draws a row from.
 *
 * Every field is null-when-unknown rather than zero-when-unknown: a run whose
 * segments have not reported has found nothing YET, which is a different claim
 * from a completed run that found nothing, and a list that renders both as "0"
 * cannot be used to tell them apart.
 */
export interface RunTotals {
  /** Chapters the extension flagged as new or changed. */
  updated: number;
  /** Chapters in the full catalogue snapshot; null when no segment sent one. */
  all: number | null;
  /** Series the extension saw but the platform does not track; null if unreported. */
  untrackedManga: number | null;
  /** Distinct series across `updated`, counted over the whole run. */
  titlesUpdated: number;
}

export class RunChapterStore {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Coverage for every segment of a run, reported or not.
   *
   * LEFT JOIN, so a segment that has not come back yet is a row with null
   * counts rather than an absent row: "3 of 4 segments reported" is the thing an
   * operator needs to see before reading a chapter list as complete.
   */
  async segmentCounts(runId: string): Promise<RunSegmentCounts[]> {
    const rows = await this.prisma.$queryRaw<
      {
        jobId: string;
        segmentIndex: number;
        segmentKey: string | null;
        jobState: string;
        updated: number | null;
        all: number | null;
        untrackedManga: number | null;
        submittedAt: Date | null;
      }[]
    >(Prisma.sql`
      SELECT j.id AS "jobId", j.segment_index AS "segmentIndex", j.segment_key AS "segmentKey",
             j.state::text AS "jobState",
             CASE WHEN jsonb_typeof(rs.envelope -> 'updatedChapters') = 'array'
                  THEN jsonb_array_length(rs.envelope -> 'updatedChapters') END AS "updated",
             CASE WHEN jsonb_typeof(rs.envelope -> 'allChapters') = 'array'
                  THEN jsonb_array_length(rs.envelope -> 'allChapters') END AS "all",
             CASE WHEN jsonb_typeof(rs.envelope -> 'untrackedManga') = 'array'
                  THEN jsonb_array_length(rs.envelope -> 'untrackedManga') END AS "untrackedManga",
             rs.created_at AS "submittedAt"
      FROM jobs j
      LEFT JOIN result_submissions rs ON rs.job_id = j.id AND rs.state = 'COMMITTED'
      WHERE j.run_id = ${runId}
      ORDER BY j.segment_index ASC
    `);
    return rows;
  }

  /**
   * One page of the chapters a run found, in the order the extension reported
   * them within each segment.
   *
   * Offset paging, not keyset: the source is an immutable committed envelope, so
   * page 2 describes exactly the rows page 2 described a minute ago. (The queue
   * views cannot say that, which is why they page by cursor.)
   */
  async list(
    runId: string,
    set: ChapterSet,
    filter: RunChapterFilter,
    opts: { limit: number; offset: number; column?: SortRequest | null },
  ): Promise<{ chapters: RunChapterRow[]; total: number }> {
    // Offset paging needs only the ORDER BY: there is no cursor to keep in step
    // with it, because the envelope this reads cannot change under the reader.
    const sorted = opts.column
      ? ordering(resolveSort(RUN_CHAPTER_SORT_COLUMNS, opts.column.name, RUN_CHAPTER_ID)!.keys, opts.column.dir)
      : null;
    const source = Prisma.sql`
      FROM jobs j
      JOIN result_submissions rs ON rs.job_id = j.id AND rs.state = 'COMMITTED'
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(rs.envelope -> ${ENVELOPE_KEY[set]}) = 'array'
             THEN rs.envelope -> ${ENVELOPE_KEY[set]} ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS c(value, position)
      ${where(runId, filter)}
    `;

    const [chapters, counted] = await Promise.all([
      this.prisma.$queryRaw<RunChapterRow[]>(Prisma.sql`
        SELECT j.id AS "jobId", j.segment_index AS "segmentIndex", j.segment_key AS "segmentKey",
               c.position::int AS "position", c.value AS "chapter"
        ${source}
        ORDER BY ${sorted ? sorted.orderBy : Prisma.sql`j.segment_index ASC, c.position ASC`}
        LIMIT ${opts.limit} OFFSET ${opts.offset}
      `),
      this.prisma.$queryRaw<{ total: bigint }[]>(Prisma.sql`
        SELECT count(*) AS total ${source}
      `),
    ]);

    return { chapters, total: Number(counted[0]?.total ?? 0) };
  }

  /**
   * Chapters-found totals for a set of runs, for the list view's columns.
   *
   * Aggregated in one statement over the page of runs being drawn rather than
   * one query per run: a 50-row runs list is the common case and 50 round trips
   * to render one column is not.
   *
   * There is deliberately no `titlesAll` here. Measured against production over
   * a 50-run page: the lengths alone are ~390ms (this is dominated by detoasting
   * the envelopes, not by the arithmetic), adding the `updatedChapters` unnest
   * for `titlesUpdated` takes it to ~630ms, and unnesting `allChapters` as well
   * would add ~530ms more — a catalogue snapshot is tens of thousands of
   * elements per run where the updated set is tens. This list polls, so that
   * last step is not affordable here. The catalogue's distinct-title count is a
   * question about ONE run, and `titlesFor` answers it on the detail page for a
   * fraction of the cost.
   */
  async totalsForRuns(runIds: readonly string[]): Promise<Map<string, RunTotals>> {
    if (runIds.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<
      { runId: string; updated: bigint; all: bigint | null; untracked: bigint | null; titlesUpdated: bigint }[]
    >(Prisma.sql`
      WITH env AS (
        SELECT j.run_id, rs.envelope
        FROM jobs j
        JOIN result_submissions rs ON rs.job_id = j.id AND rs.state = 'COMMITTED'
        WHERE j.run_id = ANY(${[...runIds]}::text[])
      ),
      -- The lengths, one row per envelope. Kept apart from the unnest below
      -- rather than folded into one GROUP BY: unnesting multiplies each
      -- envelope's row by its chapter count, and summing a length over those
      -- copies would report a 40-chapter segment as 1600.
      counts AS (
        SELECT run_id,
               coalesce(sum(
                 CASE WHEN jsonb_typeof(envelope -> 'updatedChapters') = 'array'
                      THEN jsonb_array_length(envelope -> 'updatedChapters') ELSE 0 END
               ), 0) AS updated,
               -- NULL when no segment sent a catalogue snapshot, so the column
               -- can say "-" rather than a zero that reads as "found nothing".
               sum(
                 CASE WHEN jsonb_typeof(envelope -> 'allChapters') = 'array'
                      THEN jsonb_array_length(envelope -> 'allChapters') END
               ) AS "all",
               sum(
                 CASE WHEN jsonb_typeof(envelope -> 'untrackedManga') = 'array'
                      THEN jsonb_array_length(envelope -> 'untrackedManga') END
               ) AS untracked
        FROM env GROUP BY run_id
      ),
      -- Distinct across the whole run, not summed per segment: a title split
      -- over two segments is one title, and adding the segments' counts would
      -- report it as two.
      titles AS (
        SELECT e.run_id, count(DISTINCT coalesce(u.value ->> 'mdMangaId', u.value ->> 'mangaId')) AS titles
        FROM env e
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(e.envelope -> 'updatedChapters') = 'array'
               THEN e.envelope -> 'updatedChapters' ELSE '[]'::jsonb END
        ) AS u(value)
        GROUP BY e.run_id
      )
      SELECT c.run_id AS "runId", c.updated, c."all", c.untracked,
             coalesce(t.titles, 0) AS "titlesUpdated"
      FROM counts c
      LEFT JOIN titles t ON t.run_id = c.run_id
    `);
    return new Map(
      rows.map((row) => [
        row.runId,
        {
          updated: Number(row.updated),
          all: row.all === null ? null : Number(row.all),
          untrackedManga: row.untracked === null ? null : Number(row.untracked),
          titlesUpdated: Number(row.titlesUpdated),
        },
      ]),
    );
  }

  /**
   * How many distinct titles one run's chosen set covers, uncapped.
   *
   * Separate from `byManga` because that one is a LIMITed page of the breakdown:
   * its length is the number of rows the caller asked for, not the number of
   * titles the run touched, and reading it as the latter silently reports "200
   * titles" for every run that has more. This counts in the database instead, so
   * a capped breakdown can still say what it is a breakdown OF.
   */
  async titlesFor(runId: string, set: ChapterSet): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ titles: bigint }[]>(Prisma.sql`
      SELECT count(DISTINCT coalesce(c.value ->> 'mdMangaId', c.value ->> 'mangaId')) AS titles
      FROM jobs j
      JOIN result_submissions rs ON rs.job_id = j.id AND rs.state = 'COMMITTED'
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(rs.envelope -> ${ENVELOPE_KEY[set]}) = 'array'
             THEN rs.envelope -> ${ENVELOPE_KEY[set]} ELSE '[]'::jsonb END
      ) AS c(value)
      WHERE j.run_id = ${runId}
    `);
    return Number(rows[0]?.titles ?? 0);
  }

  /**
   * Per-title breakdown of one run: how many chapters were found for each
   * series, newest reported first.
   *
   * This is the shape an operator actually reads a run in, "mangaplus found 41
   * chapters across 9 titles", and it is cheap enough to compute on demand
   * because the grouping happens in Postgres over the same unnest the list uses.
   */
  async byManga(
    runId: string,
    set: ChapterSet,
    limit: number,
  ): Promise<{ mdMangaId: string | null; mangaId: string | null; mangaName: string | null; count: number }[]> {
    const rows = await this.prisma.$queryRaw<
      { mdMangaId: string | null; mangaId: string | null; mangaName: string | null; count: bigint }[]
    >(Prisma.sql`
      SELECT c.value ->> 'mdMangaId' AS "mdMangaId",
             c.value ->> 'mangaId' AS "mangaId",
             -- One title can arrive with the name on some rows and null on
             -- others (the processor fills names in later), so take any non-null.
             max(c.value ->> 'mangaName') AS "mangaName",
             count(*) AS count
      FROM jobs j
      JOIN result_submissions rs ON rs.job_id = j.id AND rs.state = 'COMMITTED'
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(rs.envelope -> ${ENVELOPE_KEY[set]}) = 'array'
             THEN rs.envelope -> ${ENVELOPE_KEY[set]} ELSE '[]'::jsonb END
      ) AS c(value)
      WHERE j.run_id = ${runId}
      GROUP BY 1, 2
      ORDER BY count DESC, 3 ASC
      LIMIT ${limit}
    `);
    return rows.map((row) => ({
      mdMangaId: row.mdMangaId,
      mangaId: row.mangaId,
      mangaName: row.mangaName,
      count: Number(row.count),
    }));
  }
}

// ------------------------------------------------------------------ internals

function where(runId: string, filter: RunChapterFilter): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`j.run_id = ${runId}`];
  if (filter.segmentIndex !== undefined) {
    parts.push(Prisma.sql`j.segment_index = ${filter.segmentIndex}`);
  }
  if (filter.mdMangaId) parts.push(Prisma.sql`c.value ->> 'mdMangaId' = ${filter.mdMangaId}`);
  if (filter.language) parts.push(Prisma.sql`c.value ->> 'chapterLanguage' = ${filter.language}`);
  if (filter.q) {
    // Parameterised, so a `%` is a wildcard the operator meant and a quote is
    // data. Spans the three fields a human searches by: which series, which
    // chapter, and what it was called.
    const needle = `%${filter.q}%`;
    parts.push(Prisma.sql`(
      c.value ->> 'mangaName' ILIKE ${needle}
      OR c.value ->> 'chapterTitle' ILIKE ${needle}
      OR c.value ->> 'chapterNumber' ILIKE ${needle}
      OR c.value ->> 'chapterId' ILIKE ${needle}
    )`);
  }
  return Prisma.sql`WHERE ${Prisma.join(parts, " AND ")}`;
}
