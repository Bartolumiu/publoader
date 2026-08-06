import { describe, expect, it } from "vitest";
import { computeSegments, dueSlot, effectiveSchedules, slotId } from "../../src/core/scheduler/slots.js";
import { backoffSeconds } from "../../src/core/store/jobs.js";
import { Manifest, manifestSchedule, type ScheduleSlot } from "../../src/contracts/manifest.js";

const manifest = (over: object = {}) =>
  Manifest.parse({
    name: "mangaplus",
    version: "1.0",
    entrypoint: "mangaplus.py",
    mangadex_group_id: "4f1de6a2-f0c5-4ac5-bce5-02c7dbb67deb",
    languages: ["en"],
    allowed_hosts: ["mangaplus.shueisha.co.jp"],
    schedule: { hour: 15, minute: 5 },
    ...over,
  });

const slot = (over: Partial<ScheduleSlot> = {}): ScheduleSlot => ({
  hour: 15,
  minute: 5,
  days: [],
  kind: "UPDATE",
  ...over,
});

describe("manifestSchedule", () => {
  it("accepts the single-object form every published manifest already uses", () => {
    expect(manifestSchedule(manifest())).toEqual([slot()]);
  });

  it("accepts a list, so one extension can declare several slots", () => {
    const parsed = manifest({
      schedule: [
        { hour: 15, minute: 0 },
        { hour: 1, minute: 0 },
        { hour: 1, minute: 0, day: 2, kind: "CLEAN", label: "weekly deep clean" },
      ],
    });
    expect(manifestSchedule(parsed)).toEqual([
      slot({ hour: 15, minute: 0 }),
      slot({ hour: 1, minute: 0 }),
      slot({ hour: 1, minute: 0, days: [2], kind: "CLEAN", label: "weekly deep clean" }),
    ]);
  });

  it("folds `day` and `days` into one sorted, duplicate-free set", () => {
    const parsed = manifest({ schedule: { hour: 1, minute: 0, day: 2, days: [5, 2, 0] } });
    expect(manifestSchedule(parsed)[0]?.days).toEqual([0, 2, 5]);
  });

  it("defaults an unspecified kind to UPDATE, not to whatever ran last", () => {
    expect(manifestSchedule(manifest())[0]?.kind).toBe("UPDATE");
  });
});

describe("effectiveSchedules", () => {
  it("flattens every slot of every enabled extension", () => {
    const schedules = effectiveSchedules(
      [manifest({ schedule: [{ hour: 15, minute: 0 }, { hour: 1, minute: 0 }] }), manifest({ name: "k_manga" })],
      {},
      [],
    );
    expect(schedules).toEqual([
      { extension: "mangaplus", ...slot({ hour: 15, minute: 0 }) },
      { extension: "mangaplus", ...slot({ hour: 1, minute: 0 }) },
      { extension: "k_manga", ...slot() },
    ]);
  });

  it("lets operator rows replace the manifest wholesale, and drops disabled extensions", () => {
    const schedules = effectiveSchedules(
      [manifest(), manifest({ name: "k_manga" })],
      { mangaplus: [slot({ hour: 3, minute: 30, days: [2], kind: "CLEAN" })] },
      ["k_manga"],
    );
    expect(schedules).toEqual([
      { extension: "mangaplus", ...slot({ hour: 3, minute: 30, days: [2], kind: "CLEAN" }) },
    ]);
  });

  it("an extension whose every slot is switched off runs NOTHING, not the manifest", () => {
    // The key is present with an empty list: "the operator has an opinion, and
    // the opinion is none". Falling back here would resurrect the manifest's
    // schedule the moment somebody paused the only slot they had.
    expect(effectiveSchedules([manifest()], { mangaplus: [] }, [])).toEqual([]);
  });
});

describe("dueSlot", () => {
  const sched = slot();
  it("fires exactly once per slot window", () => {
    const now = new Date("2026-07-29T15:05:30Z");
    const lastTick = new Date("2026-07-29T15:04:30Z");
    expect(dueSlot(sched, lastTick, now)?.toISOString()).toBe("2026-07-29T15:05:00.000Z");
    // Next tick, same slot already covered: no fire.
    expect(dueSlot(sched, now, new Date("2026-07-29T15:06:30Z"))).toBeNull();
  });
  it("does not fire before the slot or on the wrong weekday", () => {
    expect(dueSlot(sched, new Date("2026-07-29T15:03:00Z"), new Date("2026-07-29T15:04:00Z"))).toBeNull();
    // 2026-07-29 is a Wednesday (python weekday 2).
    const wrongDay = slot({ days: [3] });
    expect(dueSlot(wrongDay, new Date("2026-07-29T15:04:00Z"), new Date("2026-07-29T15:06:00Z"))).toBeNull();
    const rightDay = slot({ days: [2] });
    expect(dueSlot(rightDay, new Date("2026-07-29T15:04:00Z"), new Date("2026-07-29T15:06:00Z"))).not.toBeNull();
  });
  it("fires on any weekday in the set", () => {
    const midweekAndWeekend = slot({ days: [2, 5] });
    // Wednesday.
    expect(
      dueSlot(midweekAndWeekend, new Date("2026-07-29T15:04:00Z"), new Date("2026-07-29T15:06:00Z")),
    ).not.toBeNull();
    // Saturday.
    expect(
      dueSlot(midweekAndWeekend, new Date("2026-08-01T15:04:00Z"), new Date("2026-08-01T15:06:00Z")),
    ).not.toBeNull();
    // Thursday: not in the set.
    expect(
      dueSlot(midweekAndWeekend, new Date("2026-07-30T15:04:00Z"), new Date("2026-07-30T15:06:00Z")),
    ).toBeNull();
  });
  it("recovers a slot missed during downtime within the same day", () => {
    const lastTick = new Date("2026-07-29T14:00:00Z");
    const now = new Date("2026-07-29T16:00:00Z");
    expect(dueSlot(sched, lastTick, now)?.toISOString()).toBe("2026-07-29T15:05:00.000Z");
  });
  it("several slots on one day are each independently due", () => {
    // The whole point of the feature: 01:00 and 15:00 on the same extension are
    // two fires, not one, and a tick that spans both must produce both.
    const lastTick = new Date("2026-07-29T00:30:00Z");
    const now = new Date("2026-07-29T16:00:00Z");
    const early = dueSlot(slot({ hour: 1, minute: 0 }), lastTick, now);
    const late = dueSlot(slot({ hour: 15, minute: 0 }), lastTick, now);
    expect(early?.toISOString()).toBe("2026-07-29T01:00:00.000Z");
    expect(late?.toISOString()).toBe("2026-07-29T15:00:00.000Z");
  });
  it("slotId is minute-resolution UTC", () => {
    expect(slotId(new Date("2026-07-29T15:05:00Z"))).toBe("2026-07-29T15:05");
  });
});

describe("computeSegments", () => {
  const ids = Array.from({ length: 100 }, (_, i) => String(1000 + i));
  const partition = { maxSegments: 4, minMangaPerSegment: 25 };

  it("is deterministic: identical inputs give identical keys", () => {
    const a = computeSegments("mangaplus", "run-1", ids, partition);
    const b = computeSegments("mangaplus", "run-1", [...ids].reverse(), partition);
    expect(a.map((s) => s.key)).toEqual(b.map((s) => s.key));
  });

  it("segments are non-overlapping and cover every id exactly once", () => {
    const segments = computeSegments("mangaplus", "run-1", ids, partition);
    const all = segments.flatMap((s) => s.mangaIds);
    expect(all.sort()).toEqual([...ids].sort());
    expect(new Set(all).size).toBe(ids.length);
  });

  it("different runs produce different keys (no cross-run collisions)", () => {
    const a = computeSegments("mangaplus", "run-1", ids, partition);
    const b = computeSegments("mangaplus", "run-2", ids, partition);
    expect(a[0]!.key).not.toBe(b[0]!.key);
  });

  it("small catalogues do not partition", () => {
    expect(computeSegments("x", "r", ids.slice(0, 30), partition)).toEqual([]);
    expect(computeSegments("x", "r", [], partition)).toEqual([]);
  });

  it("respects maxSegments", () => {
    const many = Array.from({ length: 1000 }, (_, i) => String(i));
    const segments = computeSegments("x", "r", many, partition);
    expect(segments.length).toBeLessThanOrEqual(4);
  });
});

describe("backoffSeconds", () => {
  const policy = { baseSeconds: 60, maxSeconds: 3600 };
  it("grows exponentially with jitter and respects the cap", () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      const value = backoffSeconds(attempt, policy);
      const cap = Math.min(60 * 2 ** (attempt - 1), 3600);
      expect(value).toBeGreaterThanOrEqual(Math.floor(cap / 2));
      expect(value).toBeLessThanOrEqual(cap);
    }
  });
});
