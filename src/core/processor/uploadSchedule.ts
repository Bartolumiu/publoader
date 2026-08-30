/**
 * Deciding which day each newly-decided chapter is due on.
 *
 * The queue already had everything needed to run work later: `upload_tasks`
 * carries `not_before`, the claim query reads
 * `WHERE state = 'PENDING' AND not_before <= now() ORDER BY not_before ASC`,
 * and `enqueue` is `ON CONFLICT DO NOTHING`. What was missing is that nothing
 * ever set `not_before` to anything but `now()`, so every chapter a run decided
 * became due the instant it was decided.
 *
 * That is right for a routine day — a couple of dozen chapters, all immediate —
 * and wrong for the two cases that produce hundreds at once: an operator
 * tracking a batch of new series, and the first run after an outage. Those
 * flood MangaDex's latest-updates feed and sit in the upload queue in front of
 * every ordinary update behind them.
 *
 * So this spreads the overflow across days instead. Nothing is dropped or
 * withheld: every chapter is queued in the same pass, and a future-dated row is
 * an ordinary PENDING task the claim query ignores until its date arrives.
 * Because `enqueue` does nothing on conflict, a later run re-deciding the same
 * chapter leaves the date it already has — the schedule is set once and stands.
 *
 * Two properties make the cap mean what it says:
 *
 *  - **The grid is absolute.** Buckets are `floor(t / intervalMs)` anchored at
 *    the unix epoch, not `now + n * interval` measured from whenever a run
 *    happened to start. Runs start at arbitrary times, so run-relative buckets
 *    never line up between runs and two runs an hour apart would each believe
 *    they owned a fresh day. A fixed grid gives every run the same boundaries.
 *  - **The budget is shared.** `existing` carries what is already queued in
 *    each bucket, across every extension, so a bucket fills once rather than
 *    once per extension. Without it `perDay` is a per-run quota and the real
 *    ceiling is `perDay × runs × extensions`.
 */

import type { UploadSchedule } from "../store/settings.js";

/** The little a chapter must expose to be scheduled. */
export interface SchedulableChapter {
  /** Grouping key: the MangaDex title, falling back to the publisher's id. */
  mdMangaId?: string | null;
  mangaId?: string | null;
  chapterNumber?: string | null;
  chapterTimestamp?: string | Date | null;
  chapterId?: string | null;
}

export interface ScheduledChapter<T> {
  chapter: T;
  /** When the task becomes claimable. The current bucket means immediately. */
  notBefore: Date;
  /** 0 for "the bucket this run is in"; mostly here for the run log. */
  day: number;
}

/**
 * What is already queued, so a run fills what is left of each bucket rather
 * than starting every bucket empty.
 *
 * Keyed by absolute bucket index (`bucketIndex`), and within a bucket by the
 * same manga key the planner groups on, so both caps see prior load.
 */
export interface ScheduledLoad {
  /** Rows already dated into this bucket, all extensions, all series. */
  total: Map<number, number>;
  /** Rows already dated into this bucket, per manga key. */
  perManga: Map<number, Map<string, number>>;
}

export const EMPTY_LOAD: ScheduledLoad = { total: new Map(), perManga: new Map() };

/** Series with no id of any kind share one bucket rather than each being alone. */
function mangaKey(chapter: SchedulableChapter): string {
  return chapter.mdMangaId ?? chapter.mangaId ?? "";
}

function timestampOf(chapter: SchedulableChapter): number {
  const raw = chapter.chapterTimestamp;
  if (raw === null || raw === undefined) return Number.POSITIVE_INFINITY;
  const parsed = raw instanceof Date ? raw.getTime() : Date.parse(raw);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

/**
 * Oldest first, then by chapter number, so a spread backlog is released in
 * reading order rather than scattered.
 */
function compareChapters(a: SchedulableChapter, b: SchedulableChapter): number {
  const at = timestampOf(a);
  const bt = timestampOf(b);
  if (at !== bt) return at - bt;

  const an = Number(a.chapterNumber);
  const bn = Number(b.chapterNumber);
  const aValid = a.chapterNumber !== null && a.chapterNumber !== undefined && !Number.isNaN(an);
  const bValid = b.chapterNumber !== null && b.chapterNumber !== undefined && !Number.isNaN(bn);
  if (aValid && bValid && an !== bn) return an - bn;
  if (aValid !== bValid) return aValid ? -1 : 1;

  return (a.chapterId ?? "").localeCompare(b.chapterId ?? "");
}

/** 0 means "no limit" for both caps, matching `UploadSchedule`'s documented 0. */
function limitOf(value: number): number {
  return value > 0 ? value : Number.POSITIVE_INFINITY;
}

export function intervalMsOf(schedule: UploadSchedule): number {
  return Math.max(1, schedule.intervalHours) * 60 * 60 * 1000;
}

/**
 * The absolute bucket a moment falls in.
 *
 * Anchored at the unix epoch so every run, of every extension, agrees on where
 * one bucket ends and the next begins.
 */
export function bucketIndex(at: Date, intervalMs: number): number {
  return Math.floor(at.getTime() / intervalMs);
}

/** When a bucket opens. The current bucket opened in the past, so `now` wins. */
function bucketStart(index: number, intervalMs: number, now: Date): number {
  return Math.max(index * intervalMs, now.getTime());
}

/**
 * How far apart two consecutive uploads in one bucket are placed.
 *
 * Auto (`spacingSeconds: 0`) paces only a queue big enough to need it: a run
 * that does not fill a day is the routine case, and dripping a dozen chapters
 * across 24 hours would delay them for no benefit. Once the work does fill a
 * day, the day's allowance is divided across the whole interval so it trickles
 * rather than landing at once — without that, the cap spreads work across days
 * and still bursts inside each one, which is exactly what a backlog does.
 *
 * An explicit `spacingSeconds` is an operator's decision and always applies.
 * With no `perDay` there is nothing to divide by and nothing to burst.
 */
export function spacingMsOf(
  schedule: UploadSchedule,
  intervalMs: number,
  /** Whether the work actually fills a day. False keeps a routine run immediate. */
  crowded = true,
): number {
  if (schedule.spacingSeconds > 0) return schedule.spacingSeconds * 1000;
  if (!crowded) return 0;
  if (schedule.perDay > 0) return Math.floor(intervalMs / schedule.perDay);
  return 0;
}

/**
 * Assign every chapter a release bucket.
 *
 * Filling is round-robin over series, oldest chapter first, advancing a bucket
 * when either cap is reached. Round-robin is the part that matters: filling one
 * series at a time would put a single 300-chapter backlog in front of every
 * other series for a week, so a title that published one new chapter today
 * would wait behind it. Going a slice at a time per series keeps today's
 * chapter on today.
 *
 * Ordering is stable — series sorted by key, chapters oldest-first — so the same
 * input always produces the same schedule.
 */
export function planUploadSchedule<T extends SchedulableChapter>(
  chapters: readonly T[],
  schedule: UploadSchedule,
  now: Date = new Date(),
  existing: ScheduledLoad = EMPTY_LOAD,
): ScheduledChapter<T>[] {
  if (chapters.length === 0) return [];

  const perDay = limitOf(schedule.perDay);
  const perMangaPerDay = limitOf(schedule.perMangaPerDay);
  const intervalMs = intervalMsOf(schedule);

  // No caps: everything is due now, which is exactly the old behaviour.
  if (perDay === Number.POSITIVE_INFINITY && perMangaPerDay === Number.POSITIVE_INFINITY) {
    return chapters.map((chapter) => ({ chapter, notBefore: new Date(now), day: 0 }));
  }

  const queues = new Map<string, T[]>();
  for (const chapter of chapters) {
    const key = mangaKey(chapter);
    const queue = queues.get(key);
    if (queue) queue.push(chapter);
    else queues.set(key, [chapter]);
  }

  const keys = [...queues.keys()].sort();
  for (const key of keys) queues.get(key)!.sort(compareChapters);

  const cursors = new Map<string, number>(keys.map((key) => [key, 0]));
  const out: ScheduledChapter<T>[] = [];

  const firstBucket = bucketIndex(now, intervalMs);
  // "Big queue" is the whole trigger for pacing: work that fits in today with
  // room to spare is the routine case and goes out as it always did.
  const crowded = chapters.length + (existing.total.get(firstBucket) ?? 0) > perDay;
  const spacingMs = spacingMsOf(schedule, intervalMs, crowded);
  let day = 0;
  let remaining = chapters.length;

  /**
   * Where in its bucket the nth upload lands.
   *
   * `slot` counts prior load too, so a run topping up a bucket another run
   * already partly filled queues behind that work rather than on top of it. The
   * offset is clamped to the interval so a bucket's tail can never overtake the
   * bucket after it.
   */
  const releaseAt = (bucket: number, slot: number): Date => {
    const offset = Math.min(slot * spacingMs, Math.max(0, intervalMs - 1));
    return new Date(bucketStart(bucket, intervalMs, now) + offset);
  };

  while (remaining > 0) {
    const bucket = firstBucket + day;

    // Prior load counts against both caps, so a bucket another extension
    // already filled is skipped rather than doubled up on.
    let placedToday = existing.total.get(bucket) ?? 0;
    const placedPerManga = new Map<string, number>(existing.perManga.get(bucket) ?? []);
    const placedHere = placedToday;

    // One pass per round so series interleave; repeated until the bucket is
    // full or nothing more fits in it.
    let progressed = true;
    while (progressed && placedToday < perDay) {
      progressed = false;

      for (const key of keys) {
        if (placedToday >= perDay) break;

        const queue = queues.get(key)!;
        const cursor = cursors.get(key)!;
        if ((placedPerManga.get(key) ?? 0) >= perMangaPerDay) continue;

        const next = queue[cursor];
        if (next === undefined) continue;

        out.push({ chapter: next, notBefore: releaseAt(bucket, placedToday), day });
        cursors.set(key, cursor + 1);
        placedPerManga.set(key, (placedPerManga.get(key) ?? 0) + 1);
        placedToday++;
        remaining--;
        progressed = true;
      }
    }

    // Nothing fitted in this bucket. If prior load is why, the next bucket is
    // the answer and the loop simply moves on; only a bucket that was empty and
    // still took nothing is unfillable, and dumping the rest there beats
    // spinning forever.
    if (placedToday === placedHere && placedHere === 0) {
      let slot = 0;
      for (const key of keys) {
        const queue = queues.get(key)!;
        for (let i = cursors.get(key)!; i < queue.length; i++) {
          const chapter = queue[i];
          if (chapter === undefined) continue;
          out.push({ chapter, notBefore: releaseAt(bucket, slot++), day });
        }
        cursors.set(key, queue.length);
      }
      break;
    }

    day++;
  }

  return out;
}

/** How many chapters land on each day, for the run log. */
export function summariseSchedule<T>(scheduled: readonly ScheduledChapter<T>[]): {
  immediate: number;
  deferred: number;
  days: number;
  lastDate: string | null;
} {
  let immediate = 0;
  let maxDay = 0;
  let lastDate: string | null = null;

  for (const entry of scheduled) {
    if (entry.day === 0) immediate++;
    if (entry.day >= maxDay) {
      maxDay = entry.day;
      lastDate = entry.notBefore.toISOString();
    }
  }

  return {
    immediate,
    deferred: scheduled.length - immediate,
    days: scheduled.length === 0 ? 0 : maxDay + 1,
    lastDate,
  };
}
