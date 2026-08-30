import { describe, expect, it } from "vitest";
import {
  bucketIndex,
  planUploadSchedule,
  spacingMsOf,
  type ScheduledLoad,
  type SchedulableChapter,
} from "../../src/core/processor/uploadSchedule.js";
import { DEFAULT_UPLOAD_SCHEDULE, type UploadSchedule } from "../../src/core/store/settings.js";

const NOW = new Date("2026-08-30T00:00:00.000Z");
const MIN_MS = 60 * 1000;

const chapter = (mdMangaId: string, chapterId: string, n: number): SchedulableChapter => ({
  mdMangaId,
  chapterId,
  chapterNumber: String(n),
  chapterTimestamp: new Date(NOW.getTime() - (1000 - n) * MIN_MS).toISOString(),
});

const schedule = (over: Partial<UploadSchedule> = {}): UploadSchedule => ({
  ...DEFAULT_UPLOAD_SCHEDULE,
  ...over,
});

const gaps = (out: readonly { notBefore: Date }[]): number[] => {
  const times = out.map((e) => e.notBefore.getTime()).sort((a, b) => a - b);
  return times.slice(1).map((t, i) => t - times[i]!);
};

describe("staggering inside a release day", () => {
  it("auto-spreads a day's allowance across the whole interval", () => {
    // 4 a day over 24h is one every 6 hours, not four at midnight.
    const s = schedule({ perDay: 4, perMangaPerDay: 4, intervalHours: 24, spacingSeconds: 0 });
    expect(spacingMsOf(s, 24 * 60 * MIN_MS)).toBe(6 * 60 * MIN_MS);

    // 6 chapters against a cap of 4: a big queue, so day 0 trickles.
    const chapters = Array.from({ length: 6 }, (_, i) => chapter("m1", `c${i}`, i + 1));
    const out = planUploadSchedule(chapters, s, NOW);

    const dayZero = out.filter((e) => e.day === 0);
    expect(dayZero).toHaveLength(4);
    expect(gaps(dayZero)).toEqual([6 * 60 * MIN_MS, 6 * 60 * MIN_MS, 6 * 60 * MIN_MS]);
  });

  it("leaves a run that fits in the day entirely immediate", () => {
    // The invariant staggering must not break: pacing is for a backlog, and
    // dripping a routine run across a day would delay it for no benefit.
    const s = schedule({ perDay: 50, perMangaPerDay: 50, intervalHours: 24, spacingSeconds: 0 });
    const chapters = Array.from({ length: 20 }, (_, i) => chapter("m1", `c${i}`, i + 1));

    const out = planUploadSchedule(chapters, s, NOW);

    expect(out.every((e) => e.notBefore.getTime() === NOW.getTime())).toBe(true);
  });

  it("honours an explicit gap over the auto one", () => {
    const s = schedule({ perDay: 10, perMangaPerDay: 10, intervalHours: 24, spacingSeconds: 1800 });
    const chapters = Array.from({ length: 3 }, (_, i) => chapter("m1", `c${i}`, i + 1));

    const out = planUploadSchedule(chapters, s, NOW);

    expect(gaps(out)).toEqual([30 * MIN_MS, 30 * MIN_MS]);
  });

  it("never lets a day's tail overtake the next day", () => {
    // A gap far larger than the allowance needs would otherwise push the last
    // chapter of day 0 past the start of day 1.
    const s = schedule({ perDay: 3, perMangaPerDay: 3, intervalHours: 1, spacingSeconds: 3600 });
    const chapters = Array.from({ length: 6 }, (_, i) => chapter("m1", `c${i}`, i + 1));

    const out = planUploadSchedule(chapters, s, NOW);

    const dayOne = Math.min(
      ...out.filter((e) => e.day === 1).map((e) => e.notBefore.getTime()),
    );
    const dayZeroEnd = Math.max(
      ...out.filter((e) => e.day === 0).map((e) => e.notBefore.getTime()),
    );
    expect(dayZeroEnd).toBeLessThan(dayOne);
  });

  it("queues behind work another run already put in the bucket", () => {
    // Prior load shifts the starting slot, so a top-up does not land on top of
    // the timestamps already there.
    const s = schedule({ perDay: 10, perMangaPerDay: 10, intervalHours: 24, spacingSeconds: 600 });
    const here = bucketIndex(NOW, 24 * 60 * MIN_MS);
    const existing: ScheduledLoad = {
      total: new Map([[here, 3]]),
      perManga: new Map([[here, new Map([["other", 3]])]]),
    };

    const out = planUploadSchedule([chapter("m1", "a", 1)], s, NOW, existing);

    // Slot 3, not slot 0.
    expect(out[0]!.notBefore.getTime()).toBe(NOW.getTime() + 30 * MIN_MS);
  });

  it("does not stagger when spreading is off", () => {
    const s = schedule({ perDay: 0, perMangaPerDay: 0, spacingSeconds: 0 });
    expect(spacingMsOf(s, 24 * 60 * MIN_MS)).toBe(0);

    const chapters = Array.from({ length: 3 }, (_, i) => chapter("m1", `c${i}`, i + 1));
    const out = planUploadSchedule(chapters, s, NOW);

    expect(out.every((e) => e.notBefore.getTime() === NOW.getTime())).toBe(true);
  });
});
