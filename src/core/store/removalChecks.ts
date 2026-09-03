import { Prisma, type PrismaClient } from "@prisma/client";

/**
 * How many separate runs must report a chapter gone before it is removed.
 *
 * Three, because two is not enough to outlast an outage: an extension that is
 * broken for a day is broken for both of the runs inside it, and a publisher
 * that has genuinely retired a chapter will keep saying so indefinitely. Three
 * votes a day apart is two full days of a stable answer, which no transient
 * upstream failure this platform has seen has survived.
 */
export const REMOVAL_CONFIRMATIONS = 3;

/**
 * The floor on the gap between two votes.
 *
 * A day, because the failures being guarded against are measured in hours --
 * an expired token, a deploy, a geo-block, an upstream incident -- and a
 * window shorter than the outage counts the same broken answer twice.
 */
const REMOVAL_VOTE_GAP_MS = 24 * 60 * 60 * 1000;

/**
 * Extra delay on top, chosen per chapter.
 *
 * Without it every chapter of a series becomes eligible in the same second,
 * two days after one bad run, and the whole series is carded in one pass on the
 * strength of a second bad run landing on the same schedule. Spreading the
 * chapters means a recurring failure at a fixed hour cannot line up with all of
 * them at once, and a partial recovery is visible as a partial tally instead of
 * an all-or-nothing verdict.
 *
 * Up to eight hours: long enough to break a daily cadence, short enough that a
 * genuinely retired chapter is still gone within a few days.
 */
const REMOVAL_VOTE_JITTER_MS = 8 * 60 * 60 * 1000;

/** One chapter a run is reporting as gone from the publisher. */
export interface RemovalCandidate {
  mdChapterId: string;
  mdMangaId: string | null;
  extension: string;
  pass: string;
  mode: string;
}

/** What a vote did, per chapter. */
export interface RemovalVote {
  mdChapterId: string;
  /** Votes recorded so far, this one included. */
  misses: number;
  /** True once the tally is met and the chapter may be removed. */
  confirmed: boolean;
  /**
   * True when this run's report did not count: the chapter was reported again
   * inside its own vote window, so this is one observation seen twice.
   */
  tooSoon: boolean;
  /** When the next vote will count, for the log line. */
  notBefore: Date;
}

function nextVoteAt(now: number): Date {
  return new Date(now + REMOVAL_VOTE_GAP_MS + Math.floor(Math.random() * REMOVAL_VOTE_JITTER_MS));
}

/**
 * The tally behind every automatic removal.
 *
 * The problem it exists for: three of the four removal passes read their
 * evidence off what an extension listed, and "the extension did not list this
 * chapter" is the same sentence whether the publisher retired it or the
 * extension was broken when we asked. The platform could not tell those apart
 * and acted on the first report either way, so a bad half-hour upstream carded
 * live chapters onto a public catalogue -- and carding is a one-way door.
 *
 * Absence is therefore a vote. A chapter is removed only once several separate
 * runs, spread over days, have said the same thing; and any run that lists it
 * again wipes the tally, because one positive sighting outranks any number of
 * absences.
 */
export class RemovalCheckStore {
  private readonly confirmations: number;

  /**
   * `confirmations` is injectable so a test about something else -- scoped-run
   * coverage, say -- can set it to 1 and go on asserting what it was written to
   * assert, instead of every such test having to model two days of voting. The
   * voting itself is proved here, once, at the real threshold.
   */
  constructor(
    private readonly prisma: PrismaClient,
    confirmations: number = REMOVAL_CONFIRMATIONS,
  ) {
    this.confirmations = Math.max(1, Math.trunc(confirmations));
  }

  /**
   * Record this run's report for each candidate and say which are confirmed.
   *
   * One statement for the whole batch. A per-chapter read-then-write would race
   * two segments of the same run against each other and let both count, which
   * is exactly the double-vote `not_before` exists to stop.
   *
   * The upsert is the vote: a new chapter starts at one, an existing row past
   * its window gains one, and an existing row inside its window is left
   * untouched -- `not_before` unchanged, so a burst of retries cannot walk the
   * window forward either.
   */
  async vote(candidates: readonly RemovalCandidate[], now = new Date()): Promise<RemovalVote[]> {
    if (candidates.length === 0) return [];

    const rows = Prisma.join(
      candidates.map(
        (c) =>
          Prisma.sql`(${c.mdChapterId}::text, ${c.extension}::text, ${c.mdMangaId}::text,
                      ${c.pass}::text, ${c.mode}::text, ${nextVoteAt(now.getTime())}::timestamptz)`,
      ),
      ", ",
    );

    return this.prisma.$queryRaw<RemovalVote[]>(Prisma.sql`
      INSERT INTO chapter_removal_checks
        (id, md_chapter_id, extension, md_manga_id, pass, mode, misses,
         first_missed_at, last_missed_at, not_before, created_at, updated_at)
      SELECT gen_random_uuid()::text, v.md_chapter_id, v.extension, v.md_manga_id,
             v.pass, v.mode, 1, ${now}, ${now}, v.not_before, ${now}, ${now}
      FROM (VALUES ${rows})
        AS v(md_chapter_id, extension, md_manga_id, pass, mode, not_before)
      ON CONFLICT (md_chapter_id) DO UPDATE
        SET misses = CASE
                       WHEN chapter_removal_checks.not_before <= ${now}
                       THEN chapter_removal_checks.misses + 1
                       ELSE chapter_removal_checks.misses
                     END,
            -- Only a vote that COUNTED moves the window. Otherwise a run every
            -- five minutes would push the next vote further away each time and
            -- a chapter would never reach the tally at all.
            not_before = CASE
                           WHEN chapter_removal_checks.not_before <= ${now}
                           THEN EXCLUDED.not_before
                           ELSE chapter_removal_checks.not_before
                         END,
            -- Always: it is genuinely when the chapter was last seen missing,
            -- whether or not that sighting was allowed to count.
            last_missed_at = ${now},
            pass = EXCLUDED.pass,
            mode = EXCLUDED.mode,
            -- Only when the vote counted, which makes this the marker the
            -- RETURNING clause reads. A counting vote and an ignored one both
            -- end with not_before in the future, so the window cannot tell them
            -- apart, and asking it reports every vote as ignored.
            updated_at = CASE
                           WHEN chapter_removal_checks.not_before <= ${now}
                           THEN ${now}
                           ELSE chapter_removal_checks.updated_at
                         END
      RETURNING md_chapter_id AS "mdChapterId",
                misses,
                misses >= ${this.confirmations} AS confirmed,
                -- An existing row whose last real change was not this statement:
                -- the report landed inside the window and was not counted.
                (xmax <> 0 AND updated_at <> ${now}) AS "tooSoon",
                not_before AS "notBefore"
    `);
  }

  /**
   * Forget the tally for chapters the publisher has listed again.
   *
   * One sighting outranks any number of absences, so this is unconditional and
   * takes no account of how many votes had accumulated. A chapter that goes
   * missing again starts from one, which is the point: the evidence for
   * removing it has to be recent AND consecutive, not merely plentiful.
   */
  async clear(mdChapterIds: readonly string[]): Promise<number> {
    if (mdChapterIds.length === 0) return 0;
    const { count } = await this.prisma.chapterRemovalCheck.deleteMany({
      where: { mdChapterId: { in: [...mdChapterIds] } },
    });
    return count;
  }

  /** Drop an extension's whole tally, for an operator who knows it was an outage. */
  async clearExtension(extension: string): Promise<number> {
    const { count } = await this.prisma.chapterRemovalCheck.deleteMany({ where: { extension } });
    return count;
  }

  /** What is currently part-way to removal, newest report first. */
  async pending(extension?: string, limit = 100) {
    return this.prisma.chapterRemovalCheck.findMany({
      where: extension ? { extension } : {},
      orderBy: { lastMissedAt: "desc" },
      take: limit,
    });
  }
}
