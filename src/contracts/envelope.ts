import { z } from "zod";
import { ChapterRecord, MangaRecord, OverrideOptions } from "./records.js";

export const ENVELOPE_VERSION = 1;
/** Hard cap on serialized envelope size accepted by the control plane. */
export const MAX_ENVELOPE_BYTES = 32 * 1024 * 1024;
export const MAX_CHAPTERS_PER_ENVELOPE = 20_000;

export const EnvelopeError = z
  .object({
    class: z.enum(["TRANSIENT", "PERMANENT"]),
    message: z.string().max(10_000),
  })
  .strict();

/**
 * The normalized result a worker submits for one job (whole extension run or
 * one segment). Workers never write to the database; this envelope is the
 * ONLY way results enter the system, and it is validated strictly.
 */
export const ResultEnvelope = z
  .object({
    envelopeVersion: z.literal(ENVELOPE_VERSION),
    jobId: z.string().uuid(),
    leaseId: z.string().uuid(),
    segmentKey: z.string().max(64).nullable().default(null),
    extension: z.string().max(128),
    bundleSha256: z.string().regex(/^[a-f0-9]{64}$/),
    idempotencyKey: z.string().max(256),
    status: z.enum(["ok", "error"]),
    error: EnvelopeError.nullable().default(null),
    updatedChapters: z.array(ChapterRecord).max(MAX_CHAPTERS_PER_ENVELOPE).default([]),
    allChapters: z.array(ChapterRecord).max(MAX_CHAPTERS_PER_ENVELOPE).nullable().default(null),
    untrackedManga: z.array(MangaRecord).max(5_000).default([]),
    trackedMangadexIds: z.array(z.string().uuid()).max(50_000).default([]),
    mangadexGroupId: z.string().uuid().nullable().default(null),
    overrideOptions: OverrideOptions.default({}),
    extensionLanguages: z.array(z.string().max(16)).default([]),
    stats: z
      .object({
        durationS: z.number().nonnegative().optional(),
        httpRequests: z.number().int().nonnegative().optional(),
      })
      .partial()
      .default({}),
  })
  .strict();
export type ResultEnvelope = z.infer<typeof ResultEnvelope>;

export function resultIdempotencyKey(jobId: string, attempt: number): string {
  return `res:${jobId}:${attempt}`;
}
