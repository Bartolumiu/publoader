import { describe, expect, it } from "vitest";
import {
  DEFAULT_COOLDOWN_DAYS,
  activeTrackedTitles,
  activeTrackedWhere,
  isTrackedRowActive,
  pausedTrackedWhere,
} from "../../src/core/store/trackedManga.js";

/**
 * The recheck cooldown takes a series out of runs for a while. It exists for
 * catalogues whose free set is frozen — a Comikey series whose first chapter is
 * permanently free and whose every later chapter is paid has an answer no run
 * can change, and a clean run pays a request per language to re-derive it.
 *
 * These tests pin the two properties the feature is only safe because of:
 *
 *   1. a pause suppresses a series from BOTH the fetch and the withdrawal diff,
 *      because suppressing only the fetch turns a pause into a takedown, and
 *   2. a title is paused only when every one of its external rows is.
 */
const now = new Date("2026-08-30T12:00:00.000Z");
const later = new Date("2026-11-28T12:00:00.000Z");
const earlier = new Date("2026-06-01T12:00:00.000Z");

describe("isTrackedRowActive", () => {
  it("treats a never-paused row as active", () => {
    expect(isTrackedRowActive({ recheckAfter: null }, now)).toBe(true);
  });

  it("suppresses a row whose cooldown has not expired", () => {
    expect(isTrackedRowActive({ recheckAfter: later }, now)).toBe(false);
  });

  /**
   * Due is ACTIVE, not paused. The cooldown expiring is the whole mechanism by
   * which a paused series gets looked at again: if a due row stayed suppressed
   * it would never rejoin a run, and the cooldown would be a permanent off
   * switch wearing a timestamp.
   */
  it("treats an expired cooldown as active, so the series rejoins the next run", () => {
    expect(isTrackedRowActive({ recheckAfter: earlier }, now)).toBe(true);
  });

  it("treats the exact boundary as due rather than still paused", () => {
    expect(isTrackedRowActive({ recheckAfter: now }, now)).toBe(true);
  });
});

describe("activeTrackedWhere / pausedTrackedWhere", () => {
  /**
   * The two predicates must partition the table. A row that satisfied neither
   * would vanish from the lease map AND from the paused listing — suppressed
   * with nothing surfacing that it was, which is the state an operator cannot
   * debug.
   */
  it("are complements over the same extension", () => {
    const active = activeTrackedWhere("comikey", now);
    const paused = pausedTrackedWhere("comikey", now);

    expect(active.extension).toBe("comikey");
    expect(paused.extension).toBe("comikey");
    // Active: never paused, or the deadline has passed.
    expect(active.OR).toEqual([{ recheckAfter: null }, { recheckAfter: { lte: now } }]);
    // Paused: strictly in the future, so the boundary belongs to exactly one side.
    expect(paused.recheckAfter).toEqual({ gt: now });
  });
});

/**
 * The exact function `authoritativeTrackedIds` delegates to, not a copy of its
 * logic: a re-implementation here would keep passing after the real rule
 * drifted, and the rule it encodes is the one whose failure deletes chapters.
 */
const activeTitles = activeTrackedTitles;

describe("the authoritative tracked set under a pause", () => {
  const TITLE = "333f4d22-7753-4e3b-b0da-0a69b2cdce4f";
  const OTHER = "fa3e0b2f-4e1f-48ee-9af0-1de9dc28ca51";

  /**
   * The trap this feature exists around. `removeMangaWithoutExternalChapters`
   * queues a removal for every tracked id absent from `allChapters`, and a
   * paused series is absent from `allChapters` by construction because it was
   * withheld from the lease map. If the pause did not also apply here, pausing
   * a series would take its chapters off MangaDex.
   */
  it("drops a fully paused title, so its absence from allChapters is not read as a withdrawal", () => {
    const ids = activeTitles([{ mdMangaId: TITLE, recheckAfter: later }], [], now);
    expect(ids).not.toContain(TITLE);
  });

  it("keeps a title whose cooldown has expired", () => {
    const ids = activeTitles([{ mdMangaId: TITLE, recheckAfter: earlier }], [], now);
    expect(ids).toContain(TITLE);
  });

  it("keeps a title while ANY of its external rows is still active", () => {
    // One language edition paused, the other not: the title still publishes.
    const ids = activeTitles(
      [
        { mdMangaId: TITLE, recheckAfter: later },
        { mdMangaId: TITLE, recheckAfter: null },
      ],
      [],
      now,
    );
    expect(ids).toContain(TITLE);
  });

  it("drops a title only once every one of its rows is paused", () => {
    const ids = activeTitles(
      [
        { mdMangaId: TITLE, recheckAfter: later },
        { mdMangaId: TITLE, recheckAfter: later },
      ],
      [],
      now,
    );
    expect(ids).not.toContain(TITLE);
  });

  /**
   * A worker that leased before the pause landed still names the series in its
   * envelope, honestly — it did fetch it. The database is the authority, so the
   * pause wins and takes effect on runs already in flight rather than one run
   * later.
   */
  it("does not let a worker's report resurrect a title the database has paused", () => {
    const ids = activeTitles([{ mdMangaId: TITLE, recheckAfter: later }], [TITLE], now);
    expect(ids).not.toContain(TITLE);
  });

  /**
   * The union with the workers' report is load-bearing for a different case: a
   * title mapped since this run started is in nobody's snapshot but is real.
   * Only ids the database KNOWS are subject to the pause filter.
   */
  it("still admits a title the workers reported that the database has no row for", () => {
    const ids = activeTitles([{ mdMangaId: TITLE, recheckAfter: null }], [OTHER], now);
    expect(ids).toContain(OTHER);
    expect(ids).toContain(TITLE);
  });
});

describe("the default cooldown", () => {
  /**
   * A quarter: long enough to skip roughly twelve weekly clean runs, short
   * enough that a publisher widening a free prefix is noticed in a season
   * rather than never. The value is asserted because it is a policy decision,
   * not an implementation detail — changing it should be deliberate.
   */
  it("is a quarter", () => {
    expect(DEFAULT_COOLDOWN_DAYS).toBe(90);
  });
});
