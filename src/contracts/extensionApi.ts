import { z } from "zod";

/**
 * Extension API v2; the TypeScript extension contract (publoader_api ^2.0.0).
 *
 * Design changes from v1:
 *  - ONE entrypoint method (`collect`) instead of five methods + six
 *    attributes: identity (name, group id, languages) and configuration
 *    (tracked map, override options, schedule) come from the manifest and the
 *    database; the extension no longer duplicates them.
 *  - Extensions are pure data producers: they receive a sandboxed context and
 *    return chapters/manga. No filesystem, no process, no ambient network;
 *    `ctx.fetch` is the only sanctioned I/O and it enforces the manifest's
 *    allowed_hosts before any packet leaves.
 *  - Bundles ship a single self-contained ESM file (built with esbuild at
 *    publish time); the worker runs it under Node's permission model with
 *    code generation from strings disabled.
 *
 * An extension module default-exports a factory:
 *
 *   import type { ExtensionFactory } from "publoader-extension-api";
 *   const factory: ExtensionFactory = (ctx) => ({
 *     async collect(input) { ... return { updatedChapters: [...] }; },
 *   });
 *   export default factory;
 */

/** Chapter as produced by an extension (camelCase; datetimes ISO-8601 UTC). */
export const ChapterInput = z
  .object({
    chapterTimestamp: z.string().datetime({ offset: true }).nullable().default(null),
    chapterExpire: z.string().datetime({ offset: true }).nullable().default(null),
    chapterLanguage: z.string().max(16).nullable().default(null),
    chapterNumber: z.string().max(64).nullable().default(null),
    chapterTitle: z.string().max(1024).nullable().default(null),
    chapterVolume: z.string().max(64).nullable().default(null),
    chapterId: z.string().max(512),
    chapterUrl: z.string().max(2048),
    mangaId: z.string().max(512),
    /** MangaDex title id. Omit or null when unknown: the runner resolves it
     * from the platform's tracked map, and unresolved chapters are dropped. */
    mdMangaId: z.string().uuid().nullable().default(null),
    mangaName: z.string().max(1024).nullable().default(null),
    mangaUrl: z.string().max(2048).nullable().default(null),
    /** Page images (rare; card generation is core-side). */
    images: z.array(z.instanceof(Uint8Array)).max(500).optional(),
  })
  .strict();
export type ChapterInput = z.infer<typeof ChapterInput>;

export const MangaInput = z
  .object({
    mangaId: z.string().max(512),
    mangaName: z.string().max(1024),
    mangaLanguage: z.string().max(16),
    mangaUrl: z.string().max(2048),
  })
  .strict();
export type MangaInput = z.infer<typeof MangaInput>;

export const CollectResult = z
  .object({
    updatedChapters: z.array(ChapterInput).default([]),
    /** Full current catalogue; REQUIRED semantics on clean runs (absence =
     * "no removal information", never "everything was removed"). */
    allChapters: z.array(ChapterInput).nullable().default(null),
    untrackedManga: z.array(MangaInput).default([]),
  })
  .strict();
export type CollectResult = z.infer<typeof CollectResult>;

export interface CollectInput {
  /** Chapter ids already uploaded for this extension (empty on clean runs). */
  postedChapterIds: readonly string[];
  /** Clean run: return the full catalogue in allChapters. */
  cleanRun: boolean;
  /**
   * When set, this job is one segment of a partitioned run: fetch only these
   * external manga ids. The runner filters the output to this set regardless,
   * so honoring it is an optimization, not a correctness requirement.
   */
  trackedSubset: readonly string[] | null;
}

export interface ExtensionContext {
  /** The extension's manifest (validated copy; read-only). */
  readonly manifest: Readonly<Record<string, unknown>>;
  /**
   * External manga id -> MangaDex title id, from the platform's
   * DB-authoritative tracked map (includes titles auto-created since the
   * bundle was published).
   */
  readonly mangaIdMap: ReadonlyMap<string, string>;
  /**
   * The ONLY sanctioned network primitive. Enforces the manifest's
   * allowed_hosts (exact or subdomain) before connecting, applies a default
   * per-host politeness delay, timeout, and bounded retries. Same signature
   * as global fetch.
   */
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
  /** Read a bundled data file (declared in manifest data_files). */
  dataFile(name: string): Promise<string>;
  /** Structured logging to the job's log stream (never stdout). */
  log(message: string, fields?: Record<string, unknown>): void;
}

export interface ExtensionRuntime {
  collect(input: CollectInput): Promise<CollectResult>;
}

export type ExtensionFactory = (
  ctx: ExtensionContext,
) => ExtensionRuntime | Promise<ExtensionRuntime>;

/** Runner→agent wire protocol version for the Node runner. */
export const NODE_RUNNER_VERSION = 2;
