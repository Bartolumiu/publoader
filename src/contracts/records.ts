import { z } from "zod";

/**
 * Wire mirror of the canonical `Chapter` shape
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
    /**
     * Why a reader cannot open this chapter for free, when they cannot.
     *
     * Absent (the default) means the chapter is freely readable and is
     * published normally. Anything else means the publisher still LISTS the
     * chapter but will not serve it to an ordinary reader, and the chapter is
     * published already carded, carrying this reason as its wording.
     *
     * This exists so an extension can report its whole catalogue rather than
     * silently dropping what it cannot read. Dropping was the old behaviour and
     * it is indistinguishable, from the platform's side, from the publisher
     * having removed the chapter — so a paid chapter and a deleted one produced
     * the same card, and the paid one told readers it was gone.
     */
    unavailableReason: z
      .enum(["subscriber-only", "region-locked", "removed"])
      .nullable()
      .default(null),
    /**
     * What the publisher calls the tier a `subscriber-only` chapter needs, e.g.
     * "MANGA Plus MAX". Only the extension knows the name; without one the card
     * stays generic rather than inventing it.
     */
    subscriptionName: z.string().max(128).nullable().default(null),
  })
  .strict();
export type ChapterRecord = z.infer<typeof ChapterRecord>;

/** Wire mirror of the canonical `Manga` shape. */
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
 * Deliberate departures:
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
