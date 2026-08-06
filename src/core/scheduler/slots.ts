import { createHash } from "node:crypto";
import type { Manifest } from "../../contracts/manifest.js";
import type { JobSegment } from "../store/jobs.js";

export interface EffectiveSchedule {
  extension: string;
  hour: number;
  minute: number;
  /** 0-6, Monday=0 (matches the existing extensions-repo contract). */
  day?: number;
}

/**
 * Effective schedules: manifest defaults overridden by operator rows;
 * the same precedence the legacy scheduler applied to schedule.json + SQLite.
 */
export function effectiveSchedules(
  manifests: Manifest[],
  overrides: Record<string, { hour: number; minute: number; day?: number }>,
  disabled: string[],
): EffectiveSchedule[] {
  const disabledSet = new Set(disabled);
  const out: EffectiveSchedule[] = [];
  for (const manifest of manifests) {
    if (disabledSet.has(manifest.name)) continue;
    const override = overrides[manifest.name];
    const schedule = override ?? manifest.schedule;
    if (!schedule) continue;
    out.push({
      extension: manifest.name,
      hour: schedule.hour,
      minute: schedule.minute,
      ...(schedule.day !== undefined ? { day: schedule.day } : {}),
    });
  }
  return out;
}

/** UTC slot identifier, minute resolution: `2026-07-29T15:05`. */
export function slotId(date: Date): string {
  return date.toISOString().slice(0, 16);
}

/**
 * Is this schedule due within the window (lastTick, now]? Comparing whole
 * minutes makes ticks idempotent and crash-tolerant: a scheduler that was down
 * over the slot creates the run on its next tick within the same UTC day,
 * while the run idempotency key (`sched:<ext>:<slot>`) makes double-creation
 * impossible.
 */
export function dueSlot(
  schedule: EffectiveSchedule,
  lastTick: Date,
  now: Date,
): Date | null {
  // Python weekday(): Monday=0; JS getUTCDay(): Sunday=0.
  const jsDayToPython = (d: number) => (d + 6) % 7;
  const candidate = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      schedule.hour,
      schedule.minute,
    ),
  );
  if (schedule.day !== undefined && jsDayToPython(candidate.getUTCDay()) !== schedule.day) {
    return null;
  }
  if (candidate > now || candidate <= lastTick) return null;
  return candidate;
}

/**
 * Deterministic segmentation for partitionable extensions. Chunks the sorted
 * external manga-id list into contiguous segments; identical inputs always
 * produce identical segment keys, so retries/replays address the same
 * segments.
 */
export function computeSegments(
  extension: string,
  runKey: string,
  mangaIds: string[],
  partition: { maxSegments: number; minMangaPerSegment: number },
): JobSegment[] {
  const sorted = [...new Set(mangaIds)].sort();
  const bySize = Math.floor(sorted.length / partition.minMangaPerSegment);
  const total = Math.max(1, Math.min(partition.maxSegments, bySize));
  if (total <= 1 || sorted.length === 0) {
    return [];
  }
  const segments: JobSegment[] = [];
  const per = Math.ceil(sorted.length / total);
  for (let index = 0; index < total; index++) {
    const ids = sorted.slice(index * per, (index + 1) * per);
    if (ids.length === 0) continue;
    const key = createHash("sha256")
      .update(`${extension}|${runKey}|${index}|${total}|${ids.join(",")}`)
      .digest("hex")
      .slice(0, 16);
    segments.push({ index, total, key, mangaIds: ids });
  }
  // Re-number `total` in case trailing chunks were empty.
  return segments.map((s) => ({ ...s, total: segments.length }));
}
