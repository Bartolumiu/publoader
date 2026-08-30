import { describe, expect, it } from "vitest";
import {
  bucketIndex,
  planUploadSchedule,
  type ScheduledLoad,
  type SchedulableChapter,
} from "../../src/core/processor/uploadSchedule.js";
import { DEFAULT_UPLOAD_SCHEDULE, type UploadSchedule } from "../../src/core/store/settings.js";

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

const load = (entries: readonly [number, number, Record<string, number>?][]): ScheduledLoad => ({
  total: new Map(entries.map(([bucket, n]) => [bucket, n])),
  perManga: new Map(
    entries.map(([bucket, , byManga]) => [bucket, new Map(Object.entries(byManga ?? {}))]),
  ),
});

const countByDay = (out: readonly { day: number }[]): Record<number, number> =>
  out.reduce<Record<number, number>>((acc, e) => {
    acc[e.day] = (acc[e.day] ?? 0) + 1;
    return acc;
  }, {});

const hours = (n: number): number => n * 60 * 60 * 1000;

describe("shared upload budget", () => {
  it("fills only what another extension left in the bucket", () => {
    // The whole point: perDay is one pool, not one pool per extension. With 8
    // of 10 already queued by somebody else, only 2 more fit today.
    const s = schedule({ perDay: 10, perMangaPerDay: 10, intervalHours: 24 });
    const chapters = Array.from({ length: 6 }, (_, i) => chapter("m1", `c${i}`, String(i + 1)));
    const here = bucketIndex(NOW, hours(24));

    const out = planUploadSchedule(chapters, s, NOW, load([[here, 8]]));

    expect(countByDay(out)).toEqual({ 0: 2, 1: 4 });
  });

  it("skips a bucket another run already filled", () => {
    const s = schedule({ perDay: 5, perMangaPerDay: 5, intervalHours: 24 });
    const chapters = Array.from({ length: 3 }, (_, i) => chapter("m1", `c${i}`, String(i + 1)));
    const here = bucketIndex(NOW, hours(24));

    const out = planUploadSchedule(chapters, s, NOW, load([[here, 5]]));

    expect(out.every((e) => e.day === 1)).toBe(true);
  });

  it("counts prior load against the per-series cap too", () => {
    const s = schedule({ perDay: 100, perMangaPerDay: 3, intervalHours: 24 });
    const chapters = Array.from({ length: 4 }, (_, i) => chapter("m1", `c${i}`, String(i + 1)));
    const here = bucketIndex(NOW, hours(24));

    // m1 already has 2 of its 3 today, so only 1 more of m1 fits.
    const out = planUploadSchedule(chapters, s, NOW, load([[here, 2, { m1: 2 }]]));

    expect(countByDay(out)).toEqual({ 0: 1, 1: 3 });
  });

  it("puts two runs an hour apart in the same absolute bucket", () => {
    // Run-relative buckets were the defect: two runs on one day each believed
    // they owned a fresh day, so the real ceiling was perDay x runs.
    const early = new Date("2026-08-30T09:00:00.000Z");
    const late = new Date("2026-08-30T10:00:00.000Z");
    expect(bucketIndex(early, hours(24))).toBe(bucketIndex(late, hours(24)));
  });

  it("dates a deferred chapter to the bucket boundary, not run time + interval", () => {
    const s = schedule({ perDay: 1, perMangaPerDay: 1, intervalHours: 24 });
    const at = new Date("2026-08-30T17:00:00.000Z");

    const out = planUploadSchedule([chapter("m1", "a", "1"), chapter("m1", "b", "2")], s, at);

    expect(out[0]!.notBefore.toISOString()).toBe(at.toISOString());
    // Tomorrow's bucket opens at midnight UTC, not at 17:00 the next day.
    expect(out[1]!.notBefore.toISOString()).toBe("2026-08-31T00:00:00.000Z");
  });

  it("still spreads normally when nothing is queued yet", () => {
    const s = schedule({ perDay: 2, perMangaPerDay: 2, intervalHours: 24 });
    const chapters = Array.from({ length: 5 }, (_, i) => chapter("m1", `c${i}`, String(i + 1)));

    const out = planUploadSchedule(chapters, s, NOW);

    expect(countByDay(out)).toEqual({ 0: 2, 1: 2, 2: 1 });
  });
});
