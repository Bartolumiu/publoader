import { z } from "zod";

/**
 * Wire mirror of the Python `Chapter` pydantic dataclass
 * (publoader/models/dataclasses.py). Field-for-field, camelCased; `images`
 * (raw bytes) is replaced by `imageArtifacts`: ids of separately uploaded,
 * checksummed artifacts. Datetimes travel as ISO-8601 strings (UTC).
 */
export const ChapterRecord = z
  .object({
    chapterLookup: z.string().datetime({ offset: true }).nullable().default(null),
    chapterTimestamp: z.string().datetime({ offset: true }).nullable().default(null),
    chapterExpire: z.string().datetime({ offset: true }).nullable().default(null),
    chapterLanguage: z.string().max(16).nullable().default(null),
    chapterNumber: z.string().max(64).nullable().default(null),
    chapterTitle: z.string().max(1024).nullable().default(null),
    chapterVolume: z.string().max(64).nullable().default(null),
    chapterId: z.string().max(512).nullable().default(null),
    chapterUrl: z.string().max(2048).nullable().default(null),
    mdChapterId: z.string().uuid().nullable().default(null),
    mangaId: z.string().max(512).nullable().default(null),
    mdMangaId: z.string().uuid().nullable().default(null),
    mdGroupId: z.string().uuid().nullable().default(null),
    mangaName: z.string().max(1024).nullable().default(null),
    mangaUrl: z.string().max(2048).nullable().default(null),
    extensionName: z.string().max(128).nullable().default(null),
    imageArtifacts: z.array(z.string().uuid()).max(500).default([]),
  })
  .strict();
export type ChapterRecord = z.infer<typeof ChapterRecord>;

/** Wire mirror of the Python `Manga` dataclass. */
export const MangaRecord = z
  .object({
    mangaId: z.string().max(512),
    mangaName: z.string().max(1024),
    mangaLanguage: z.string().max(16),
    mangaUrl: z.string().max(2048),
  })
  .strict();
export type MangaRecord = z.infer<typeof MangaRecord>;

/**
 * Extension override options as they travel on the WIRE, preserved verbatim
 * from the Python contract:
 * - same: master chapter id -> alternate ids that are the same chapter
 * - multi_chapters: chapter id -> chapter numbers it legitimately maps to
 * - custom_language: extension-chosen key -> MangaDex language code
 *
 * At rest those three are tables, not a document; see
 * src/core/store/extensionConfig.ts, which is the only thing that writes them
 * and the only thing that decides which rows are acceptable. This schema stays
 * deliberately TOLERANT because it also validates worker envelopes: the
 * processor ignores the copy a worker reports (configuration authority is the
 * database, see ProcessorService.loadOverrideOptions), so rejecting an envelope
 * over a stale bundle's typo would quarantine a run's real results to no end.
 * Validation that refuses bad data belongs on the admin write path, where an
 * operator sees the rejection; `custom_language` values are checked against
 * src/contracts/languages.ts there.
 */
export const OverrideOptions = z
  .object({
    same: z.record(z.array(z.string())).default({}),
    multi_chapters: z.record(z.array(z.string())).default({}),
    custom_language: z.record(z.string()).default({}),
  })
  .partial()
  .passthrough();
export type OverrideOptions = z.infer<typeof OverrideOptions>;
