import { describe, expect, it } from "vitest";
import { computeSegments, dueSlot, effectiveSchedules, slotId } from "../../src/core/scheduler/slots.js";
import { backoffSeconds } from "../../src/core/store/jobs.js";
import { Manifest } from "../../src/contracts/manifest.js";

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

describe("effectiveSchedules", () => {
  it("applies operator overrides over manifest defaults and drops disabled", () => {
    const schedules = effectiveSchedules(
      [manifest(), manifest({ name: "k_manga" })],
      { mangaplus: { hour: 3, minute: 30, day: 2 } },
      ["k_manga"],
    );
    expect(schedules).toEqual([{ extension: "mangaplus", hour: 3, minute: 30, day: 2 }]);
  });
});

describe("dueSlot", () => {
  const sched = { extension: "x", hour: 15, minute: 5 };
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
    const withDay = { ...sched, day: 3 };
    expect(dueSlot(withDay, new Date("2026-07-29T15:04:00Z"), new Date("2026-07-29T15:06:00Z"))).toBeNull();
    const rightDay = { ...sched, day: 2 };
    expect(dueSlot(rightDay, new Date("2026-07-29T15:04:00Z"), new Date("2026-07-29T15:06:00Z"))).not.toBeNull();
  });
  it("recovers a slot missed during downtime within the same day", () => {
    const lastTick = new Date("2026-07-29T14:00:00Z");
    const now = new Date("2026-07-29T16:00:00Z");
    expect(dueSlot(sched, lastTick, now)?.toISOString()).toBe("2026-07-29T15:05:00.000Z");
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
