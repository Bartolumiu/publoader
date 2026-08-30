import { describe, expect, it } from "vitest";
import {
  planUploadSchedule,
  summariseSchedule,
  type SchedulableChapter,
} from "../../src/core/processor/uploadSchedule.js";
import {
  DEFAULT_UPLOAD_SCHEDULE,
  type UploadSchedule,
} from "../../src/core/store/settings.js";

const NOW = new Date("2026-08-30T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const chapter = (
  mdMangaId: string,
  chapterId: string,
  chapterNumber: string,
  dayPublished = 1,
): SchedulableChapter => ({
  mdMangaId,
  chapterId,
  chapterNumber,
  chapterTimestamp: new Date(NOW.getTime() - dayPublished * DAY_MS).toISOString(),
});

const schedule = (over: Partial<UploadSchedule> = {}): UploadSchedule => ({
  ...DEFAULT_UPLOAD_SCHEDULE,
  ...over,
});

/** Day offsets keyed by chapter id, which is what most assertions care about. */
const daysById = (
  scheduled: readonly { chapter: SchedulableChapter; day: number }[],
): Record<string, number> =>
  Object.fromEntries(scheduled.map((entry) => [entry.chapter.chapterId!, entry.day]));

describe("planUploadSchedule", () => {
  it("makes a routine run entirely immediate", () => {
    // The case that must not regress: a normal day is far under the caps, so
    // every chapter comes out due now exactly as it did before scheduling.
    const chapters = Array.from({ length: 20 }, (_, i) => chapter(`m${i}`, `c${i}`, "1"));
    const scheduled = planUploadSchedule(chapters, schedule(), NOW);

    expect(scheduled).toHaveLength(20);
    expect(scheduled.every((entry) => entry.day === 0)).toBe(true);
    expect(scheduled.every((entry) => entry.notBefore.getTime() === NOW.getTime())).toBe(true);
  });

  it("queues every chapter, deferred ones included", () => {
    const chapters = Array.from({ length: 30 }, (_, i) => chapter("m1", `c${i}`, String(i + 1), 30 - i));
    const scheduled = planUploadSchedule(chapters, schedule({ perMangaPerDay: 3 }), NOW);

    // Nothing is dropped: spreading is about the date, never about the set.
    expect(scheduled).toHaveLength(30);
    expect(new Set(scheduled.map((e) => e.chapter.chapterId)).size).toBe(30);
  });

  it("spreads one series' backlog over days at its per-series cap", () => {
    const chapters = Array.from({ length: 7 }, (_, i) => chapter("m1", `c${i}`, String(i + 1), 7 - i));
    const scheduled = planUploadSchedule(chapters, schedule({ perMangaPerDay: 3 }), NOW);

    const days = daysById(scheduled);
    expect([days.c0, days.c1, days.c2]).toEqual([0, 0, 0]);
    expect([days.c3, days.c4, days.c5]).toEqual([1, 1, 1]);
    expect(days.c6).toBe(2);
  });

  it("releases a backlog oldest first, so it reads in order", () => {
    const chapters = [
      chapter("m1", "new", "3", 1),
      chapter("m1", "old", "1", 10),
      chapter("m1", "mid", "2", 5),
    ];
    const scheduled = planUploadSchedule(chapters, schedule({ perMangaPerDay: 1 }), NOW);
    expect(scheduled.map((e) => e.chapter.chapterId)).toEqual(["old", "mid", "new"]);
    expect(scheduled.map((e) => e.day)).toEqual([0, 1, 2]);
  });

  it("does not let one series' backlog delay another series' new chapter", () => {
    // The reason filling is round-robin rather than series-at-a-time: "m1" has
    // a 10-chapter backfill, "m2" published one chapter today. m2 must not wait
    // behind the backfill.
    const backlog = Array.from({ length: 10 }, (_, i) => chapter("m1", `b${i}`, String(i + 1), 20 - i));
    const fresh = chapter("m2", "fresh", "42", 0);
    const scheduled = planUploadSchedule([...backlog, fresh], schedule({ perMangaPerDay: 2 }), NOW);

    expect(daysById(scheduled).fresh).toBe(0);
  });

  it("caps the whole day across series", () => {
    const chapters = Array.from({ length: 10 }, (_, i) => chapter(`m${i}`, `c${i}`, "1"));
    const scheduled = planUploadSchedule(chapters, schedule({ perDay: 4 }), NOW);

    const perDay = new Map<number, number>();
    for (const entry of scheduled) perDay.set(entry.day, (perDay.get(entry.day) ?? 0) + 1);
    expect(perDay.get(0)).toBe(4);
    expect(perDay.get(1)).toBe(4);
    expect(perDay.get(2)).toBe(2);
  });

  it("dates deferred chapters by the configured interval", () => {
    const chapters = [chapter("m1", "a", "1", 2), chapter("m1", "b", "2", 1)];
    const scheduled = planUploadSchedule(
      chapters,
      schedule({ perMangaPerDay: 1, intervalHours: 6 }),
      NOW,
    );

    expect(scheduled[0]!.notBefore.getTime()).toBe(NOW.getTime());
    expect(scheduled[1]!.notBefore.getTime()).toBe(NOW.getTime() + 6 * 60 * 60 * 1000);
  });

  it("treats a zero cap as no limit, not as a stop switch", () => {
    // A zero that meant "release nothing" would silently halt all uploads.
    const chapters = Array.from({ length: 200 }, (_, i) => chapter("m1", `c${i}`, String(i + 1)));
    const scheduled = planUploadSchedule(
      chapters,
      schedule({ perDay: 0, perMangaPerDay: 0 }),
      NOW,
    );

    expect(scheduled).toHaveLength(200);
    expect(scheduled.every((entry) => entry.day === 0)).toBe(true);
  });

  it("is stable: the same input yields the same schedule", () => {
    const chapters = Array.from({ length: 12 }, (_, i) =>
      chapter(`m${i % 3}`, `c${i}`, String(i + 1), 12 - i),
    );
    const opts = schedule({ perDay: 5, perMangaPerDay: 2 });
    const first = planUploadSchedule(chapters, opts, NOW);
    const second = planUploadSchedule(chapters, opts, NOW);
    expect(daysById(second)).toEqual(daysById(first));
  });

  it("groups by publisher id when there is no MangaDex id yet", () => {
    const chapters = [
      { mangaId: "p1", chapterId: "a", chapterNumber: "1", chapterTimestamp: null },
      { mangaId: "p1", chapterId: "b", chapterNumber: "2", chapterTimestamp: null },
    ];
    const scheduled = planUploadSchedule(chapters, schedule({ perMangaPerDay: 1 }), NOW);
    expect(scheduled.map((e) => e.day)).toEqual([0, 1]);
  });

  it("handles an empty run", () => {
    expect(planUploadSchedule([], schedule(), NOW)).toEqual([]);
  });
});

describe("summariseSchedule", () => {
  it("counts immediate against deferred", () => {
    const chapters = Array.from({ length: 5 }, (_, i) => chapter("m1", `c${i}`, String(i + 1), 5 - i));
    const scheduled = planUploadSchedule(chapters, schedule({ perMangaPerDay: 2 }), NOW);
    const shape = summariseSchedule(scheduled);

    expect(shape.immediate).toBe(2);
    expect(shape.deferred).toBe(3);
    expect(shape.days).toBe(3);
    expect(shape.lastDate).toBe(new Date(NOW.getTime() + 2 * DAY_MS).toISOString());
  });

  it("reports nothing deferred for a routine run", () => {
    const scheduled = planUploadSchedule([chapter("m1", "a", "1")], schedule(), NOW);
    expect(summariseSchedule(scheduled)).toMatchObject({ immediate: 1, deferred: 0, days: 1 });
  });

  it("is empty for an empty run", () => {
    expect(summariseSchedule([])).toEqual({
      immediate: 0,
      deferred: 0,
      days: 0,
      lastDate: null,
    });
  });
});
