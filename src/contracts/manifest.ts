import { z } from "zod";

export const EXTENSION_NAME_RE = /^[a-z0-9_]+$/;

/** The kinds of run a schedule slot may create. Mirrors Prisma's `RunKind`. */
export const RUN_KINDS = ["UPDATE", "CLEAN", "FORCE"] as const;
export const RunKind = z.enum(RUN_KINDS);
export type RunKind = z.infer<typeof RunKind>;

/**
 * One slot in a manifest's `schedule`.
 *
 * `day` (a single weekday) and `days` (a set) both exist because `day` is what
 * every published manifest already says; `days` is what "Saturday and Sunday"
 * needs. Both use Python's `weekday()` numbering, Monday=0, which is the
 * numbering the extensions repo has used since before this platform existed;
 * the conversion to JS's Sunday=0 happens once, in `slots.ts`.
 */
export const ManifestScheduleEntry = z.object({
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  day: z.number().int().min(0).max(6).optional(),
  days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  /** What the slot creates. `UPDATE` is the ordinary incremental run. */
  kind: RunKind.default("UPDATE"),
  /** Operator-facing note; never interpreted. */
  label: z.string().min(1).max(80).optional(),
  timezone: z.literal("UTC").default("UTC"),
});
export type ManifestScheduleEntry = z.infer<typeof ManifestScheduleEntry>;

/**
 * A schedule slot with every optional form resolved: one weekday SET (empty =
 * every day) and an explicit kind. Everything downstream, the scheduler, the
 * API and the CLI table, reads this shape, so `day` vs `days` and the absent-kind
 * default are decided exactly once, here.
 */
export interface ScheduleSlot {
  hour: number;
  minute: number;
  /** Monday=0 … Sunday=6. Empty means every day. */
  days: number[];
  kind: RunKind;
  label?: string;
}

/** Resolve `day`/`days` into the sorted, duplicate-free set the slot fires on. */
export function normalizeWeekdays(entry: { day?: number; days?: number[] }): number[] {
  const set = new Set<number>(entry.days ?? []);
  if (entry.day !== undefined) set.add(entry.day);
  return [...set].sort((a, b) => a - b);
}

/** Normalise a manifest's `schedule` (object, list, or absent) into slots. */
export function manifestSchedule(manifest: Pick<Manifest, "schedule">): ScheduleSlot[] {
  if (!manifest.schedule) return [];
  const entries = Array.isArray(manifest.schedule) ? manifest.schedule : [manifest.schedule];
  return entries.map((entry) => ({
    hour: entry.hour,
    minute: entry.minute,
    days: normalizeWeekdays(entry),
    kind: entry.kind,
    ...(entry.label !== undefined ? { label: entry.label } : {}),
  }));
}

/** `15:05 UTC daily, update`: the one rendering every surface shows. */
export const WEEKDAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

export function formatSlot(slot: ScheduleSlot): string {
  const at = `${String(slot.hour).padStart(2, "0")}:${String(slot.minute).padStart(2, "0")} UTC`;
  const when =
    slot.days.length === 0
      ? "daily"
      : slot.days.map((d) => WEEKDAY_NAMES[d] ?? `day ${d}`).join(", ");
  return `${at} ${when}, ${slot.kind.toLowerCase()}`;
}

/**
 * Validated, ENFORCED extension manifest (manifest.json in each extension
 * directory). Extends the format already used by publoader-extensions;
 * existing manifests (e.g. mangaplus) validate unchanged.
 */
export const Manifest = z
  .object({
    name: z.string().regex(EXTENSION_NAME_RE),
    version: z.string().min(1).max(32),
    publoader_api: z.string().default("^1.0.0"),
    entrypoint: z.string().regex(/^[a-zA-Z0-9_./-]+\.(py|mjs|js)$/),
    /**
     * Execution runtime. "node" (extension API v2, TypeScript/ESM) is the
     * enforced runtime for new bundles; "python" survives only as the legacy
     * v1 marker so historical bundles remain describable. Inferred from
     * publoader_api when omitted.
     */
    runtime: z.enum(["node", "python"]).optional(),
    class_name: z.string().default("Extension"),
    mangadex_group_id: z.string().uuid(),
    languages: z.array(z.string().min(2).max(16)).min(1),
    allowed_hosts: z.array(z.string().min(1).max(255)).min(1),
    permissions: z
      .object({
        network: z.boolean().default(true),
        filesystem_read: z.array(z.string()).default([]),
        filesystem_write: z.array(z.string()).default([]),
        subprocess: z.boolean().default(false),
      })
      .default({ network: true, filesystem_read: [], filesystem_write: [], subprocess: false }),
    /**
     * When this extension runs, and as what kind of run.
     *
     * One object or a list of them. The list is the point: a source that wants
     * a 15:00 update, a 01:00 update and a Wednesday 01:00 CLEAN is describing
     * three independent slots, and the single-object form could only ever
     * express one of them.
     */
    schedule: z.union([ManifestScheduleEntry, z.array(ManifestScheduleEntry).min(1).max(48)]).optional(),
    data_files: z.record(z.string()).default({}),
    maintainers: z.array(z.string()).default([]),
    homepage: z.string().url().optional(),
    /** Partitioned execution capability; absent = whole-job only. */
    partition: z
      .object({
        mode: z.literal("tracked_manga"),
        maxSegments: z.number().int().min(2).max(32).default(4),
        minMangaPerSegment: z.number().int().min(1).default(25),
      })
      .optional(),
    /** Minimum worker trust tier allowed to execute this extension. */
    min_trust: z.enum(["TRUSTED", "COMMUNITY"]).default("COMMUNITY"),
    /** Removal-mode override, mirroring Extension.chapter_removal_mode. */
    chapter_removal_mode: z.enum(["unavailable", "delete"]).optional(),
    /**
     * Automated untracked-series handling: when true, untracked manga reported
     * by this extension get a MangaDex title created + committed automatically,
     * are added to the central tracked-manga overlay, and are announced on
     * Discord. When false (default) they queue for operator approval.
     */
    auto_create_titles: z.boolean().default(false),
    /** Defaults used when auto-creating MangaDex titles for this source. */
    title_defaults: z
      .object({
        originalLanguage: z.string().min(2).max(8).default("ja"),
        contentRating: z.enum(["safe", "suggestive", "erotica", "pornographic"]).default("safe"),
        status: z.enum(["ongoing", "completed", "hiatus", "cancelled"]).default("ongoing"),
      })
      .default({ originalLanguage: "ja", contentRating: "safe", status: "ongoing" }),
    /** Declared python requirements (informational; installed at image build). */
    requirements: z.array(z.string()).default([]),
    timeout_seconds: z.number().int().min(60).max(21600).default(3600),
    max_attempts: z.number().int().min(1).max(10).default(3),
  })
  .passthrough();
export type Manifest = z.infer<typeof Manifest>;

/** Effective runtime for a manifest: explicit field, else publoader_api major. */
export function manifestRuntime(manifest: Manifest): "node" | "python" {
  if (manifest.runtime) return manifest.runtime;
  const major = manifest.publoader_api.replace(/^[^0-9]*/, "").split(".")[0];
  return major === "1" ? "python" : "node";
}

/** Hostname (exact or subdomain) membership check against allowed_hosts. */
export function hostAllowed(url: string, allowedHosts: string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowedHosts.some((allowed) => {
    const a = allowed.toLowerCase();
    return host === a || host.endsWith(`.${a}`);
  });
}
