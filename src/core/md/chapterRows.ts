import { Prisma } from "@prisma/client";
import type { Chapter } from "./types.js";

/**
 * The one place the canonical `Chapter` shape is translated to and from the
 * typed columns of the four chapter tables (uploaded / deleted / unavailable /
 * edited_chapters).
 *
 * Those tables used to hold the whole chapter as an opaque JSONB document. The
 * shape is fixed and known, so the document bought nothing and cost type
 * enforcement, indexability and `chapter->>'x'` in every query. The columns are
 * identical across all four tables and every writer goes through this module,
 * which is what stops the four from drifting apart.
 *
 * `extra` is the escape hatch and it is deliberately narrow: page-artifact ids,
 * the MangaDex attribute snapshot the unavailable flow keeps, and any key a
 * legacy Mongo document carried that has no column. Unknown keys are parked
 * there rather than dropped.
 */

/** Keys of the canonical chapter JSON that have a dedicated column. */
export const CHAPTER_JSON_KEYS = [
  "chapterLookup",
  "chapterTimestamp",
  "chapterExpire",
  "chapterLanguage",
  "chapterNumber",
  "chapterTitle",
  "chapterVolume",
  "chapterId",
  "chapterUrl",
  "mdChapterId",
  "mangaId",
  "mdMangaId",
  "mdGroupId",
  "mangaName",
  "mangaUrl",
  "extensionName",
] as const;

const PROMOTED = new Set<string>(CHAPTER_JSON_KEYS);

/** Column values written to a chapter table. `extension` mirrors `extensionName`. */
export interface ChapterColumns {
  extension: string | null;
  chapterId: string | null;
  chapterUrl: string | null;
  chapterNumber: string | null;
  chapterTitle: string | null;
  chapterVolume: string | null;
  chapterLanguage: string | null;
  chapterTimestamp: Date | null;
  chapterExpire: Date | null;
  chapterLookup: Date | null;
  mangaId: string | null;
  mangaName: string | null;
  mangaUrl: string | null;
  mdMangaId: string | null;
  mdGroupId: string | null;
  extra: Prisma.InputJsonValue | typeof Prisma.DbNull;
}

/**
 * A row as Prisma hands it back. Loose on purpose: the four tables are
 * structurally identical here, and `Date | string` lets a test or a raw query
 * result be read without a cast.
 */
export interface StoredChapterRow {
  mdChapterId?: string | null;
  extension?: string | null;
  chapterId?: string | null;
  chapterUrl?: string | null;
  chapterNumber?: string | null;
  chapterTitle?: string | null;
  chapterVolume?: string | null;
  chapterLanguage?: string | null;
  chapterTimestamp?: Date | string | null;
  chapterExpire?: Date | string | null;
  chapterLookup?: Date | string | null;
  mangaId?: string | null;
  mangaName?: string | null;
  mangaUrl?: string | null;
  mdMangaId?: string | null;
  mdGroupId?: string | null;
  extra?: unknown;
}

/** Chapter -> columns. Anything in `extras` rides along in the `extra` document. */
export function chapterToColumns(
  chapter: Chapter,
  extras: Record<string, unknown> = {},
): ChapterColumns {
  const extra: Record<string, unknown> = { ...extras };
  // Only carried when there is something to carry: an archived chapter has had
  // its page artifacts deleted, so the common case is an absent key.
  if (chapter.imageArtifacts.length > 0) extra["imageArtifacts"] = chapter.imageArtifacts;

  return {
    extension: chapter.extensionName,
    chapterId: chapter.chapterId,
    chapterUrl: chapter.chapterUrl,
    chapterNumber: chapter.chapterNumber,
    chapterTitle: chapter.chapterTitle,
    chapterVolume: chapter.chapterVolume,
    chapterLanguage: chapter.chapterLanguage,
    chapterTimestamp: toDate(chapter.chapterTimestamp),
    chapterExpire: toDate(chapter.chapterExpire),
    chapterLookup: toDate(chapter.chapterLookup),
    mangaId: chapter.mangaId,
    mangaName: chapter.mangaName,
    mangaUrl: chapter.mangaUrl,
    mdMangaId: chapter.mdMangaId,
    mdGroupId: chapter.mdGroupId,
    extra: Object.keys(extra).length > 0 ? (extra as Prisma.InputJsonObject) : Prisma.DbNull,
  };
}

/**
 * `uploaded_chapters.extension` is NOT NULL; it is the per-extension canonical
 * mirror and the column every lookup of it filters on, so an unattributed row
 * would be invisible to those queries. An empty string is the pre-existing
 * stand-in for "the chapter did not name its extension".
 */
export function uploadedChapterColumns(
  chapter: Chapter,
  extras: Record<string, unknown> = {},
): ChapterColumns & { extension: string } {
  const columns = chapterToColumns(chapter, extras);
  return { ...columns, extension: columns.extension ?? "" };
}

/**
 * Columns -> Chapter. Timestamps come back as ISO-8601 UTC strings, so a value
 * written with a non-Z offset round-trips to the same instant rather than to
 * the same characters.
 */
export function chapterFromColumns(row: StoredChapterRow): Chapter {
  const extras = readExtra(row);
  const artifacts = extras["imageArtifacts"];

  return {
    chapterLookup: fromDate(row.chapterLookup),
    chapterTimestamp: fromDate(row.chapterTimestamp),
    chapterExpire: fromDate(row.chapterExpire),
    chapterLanguage: row.chapterLanguage ?? null,
    chapterNumber: row.chapterNumber ?? null,
    chapterTitle: row.chapterTitle ?? null,
    chapterVolume: row.chapterVolume ?? null,
    chapterId: row.chapterId ?? null,
    chapterUrl: row.chapterUrl ?? null,
    mdChapterId: row.mdChapterId ?? null,
    mangaId: row.mangaId ?? null,
    mdMangaId: row.mdMangaId ?? null,
    mdGroupId: row.mdGroupId ?? null,
    mangaName: row.mangaName ?? null,
    mangaUrl: row.mangaUrl ?? null,
    extensionName: row.extension ?? null,
    imageArtifacts: Array.isArray(artifacts)
      ? artifacts.filter((id): id is string => typeof id === "string")
      : [],
  };
}

/** The `extra` document minus the keys `chapterFromColumns` already consumed. */
export function chapterExtras(row: StoredChapterRow): Record<string, unknown> {
  const { imageArtifacts: _imageArtifacts, ...rest } = readExtra(row);
  return rest;
}

/**
 * Tolerant read of a chapter-shaped JSON document; an upload_tasks payload or
 * a camelCased legacy Mongo document. Unknown keys are ignored here and picked
 * up separately by `residualJsonKeys`; EDIT task rows in particular carry
 * `payload`/`oldInfo` alongside the chapter fields, so the strict ChapterRecord
 * schema cannot be used.
 */
export function chapterFromJson(raw: Record<string, unknown>): Chapter {
  const artifacts = raw["imageArtifacts"];
  return {
    chapterLookup: readString(raw, "chapterLookup"),
    chapterTimestamp: readString(raw, "chapterTimestamp"),
    chapterExpire: readString(raw, "chapterExpire"),
    chapterLanguage: readString(raw, "chapterLanguage"),
    chapterNumber: readString(raw, "chapterNumber"),
    chapterTitle: readString(raw, "chapterTitle"),
    chapterVolume: readString(raw, "chapterVolume"),
    chapterId: readString(raw, "chapterId"),
    chapterUrl: readString(raw, "chapterUrl"),
    mdChapterId: readString(raw, "mdChapterId"),
    mangaId: readString(raw, "mangaId"),
    mdMangaId: readString(raw, "mdMangaId"),
    mdGroupId: readString(raw, "mdGroupId"),
    mangaName: readString(raw, "mangaName"),
    mangaUrl: readString(raw, "mangaUrl"),
    extensionName: readString(raw, "extensionName"),
    imageArtifacts: Array.isArray(artifacts)
      ? artifacts.filter((id): id is string => typeof id === "string")
      : [],
  };
}

/**
 * A chapter-shaped document as an `upload_tasks.chapter` payload: every chapter
 * key present (defaulting to null), `imageArtifacts` set from the caller, and
 * every other key carried through verbatim.
 *
 * Carrying the residue is the point. Task payloads are NOT the canonical
 * chapter shape; EDIT rows need `payload` (the literal MangaDex PUT body) and
 * `oldInfo`, UNAVAILABLE rows need `unavailableAt`: and they are read
 * tolerantly by `chapterFromJson` plus a direct lookup for those sidecars, not
 * validated against ChapterRecord. Projecting a document down to the chapter
 * keys silently strips the sidecars, which makes an EDIT task unexecutable
 * ("edit task has no payload"). An allowlist of the sidecars known today would
 * break again the next time a task kind grows a field.
 *
 * `_id` and `images` are dropped: neither is a queue field, and `images` (the
 * legacy GridFS list) is superseded by `imageArtifacts`.
 */
export function chapterToTaskPayload(
  raw: Record<string, unknown>,
  imageArtifacts: string[],
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const key of CHAPTER_JSON_KEYS) payload[key] = raw[key] ?? null;

  for (const [key, value] of Object.entries(residualJsonKeys(raw))) {
    if (key === "_id" || key === "images") continue;
    payload[key] = value;
  }
  payload["imageArtifacts"] = imageArtifacts;
  return payload;
}

/** The keys `chapterToTaskPayload` carried that are not part of the chapter. */
export function taskPayloadSidecarKeys(payload: Record<string, unknown>): string[] {
  return Object.keys(payload).filter((key) => key !== "imageArtifacts" && !PROMOTED.has(key));
}

/**
 * Everything in a chapter-shaped document that has no column, so it can be
 * parked in `extra` instead of vanishing. `imageArtifacts` is excluded because
 * `chapterFromJson` already lifts it onto the Chapter.
 */
export function residualJsonKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (PROMOTED.has(key) || key === "imageArtifacts") continue;
    out[key] = value;
  }
  return out;
}

// ------------------------------------------------------------------ internals

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function readExtra(row: StoredChapterRow): Record<string, unknown> {
  const extra = row.extra;
  if (extra === null || extra === undefined || typeof extra !== "object" || Array.isArray(extra)) {
    return {};
  }
  return { ...(extra as Record<string, unknown>) };
}

/**
 * An unparseable timestamp becomes NULL rather than throwing: these tables are
 * history, and a bad date in one field is not worth failing an archive write
 * that is recording an irreversible action.
 */
function toDate(value: string | null): Date | null {
  if (value === null || value === "") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function fromDate(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
