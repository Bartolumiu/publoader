import type { ChapterRecord } from "../../contracts/records.js";

/**
 * Internal canonical chapter shape — the platform-side mirror of the Python
 * `Chapter` dataclass, and what the processor/uploader pass around.
 *
 * On its way to storage it splits two ways, both via src/core/md/chapterRows.ts:
 * the four chapter history tables hold it in typed columns, while the transient
 * UploadTask.chapter queue payload stays JSONB (it carries per-kind sidecars
 * like `payload` and `unavailableAt` that are not part of this shape).
 */
export interface Chapter {
  chapterLookup: string | null;
  chapterTimestamp: string | null;
  chapterExpire: string | null;
  chapterLanguage: string | null;
  chapterNumber: string | null;
  chapterTitle: string | null;
  chapterVolume: string | null;
  chapterId: string | null;
  chapterUrl: string | null;
  mdChapterId: string | null;
  mangaId: string | null;
  mdMangaId: string | null;
  mdGroupId: string | null;
  mangaName: string | null;
  mangaUrl: string | null;
  extensionName: string | null;
  imageArtifacts: string[];
}

export function chapterFromRecord(record: ChapterRecord, extension: string): Chapter {
  return { ...record, extensionName: record.extensionName ?? extension };
}

/** MangaDex API chapter resource (subset the pipeline touches). */
export interface MdChapter {
  id: string;
  attributes: {
    volume: string | null;
    chapter: string | null;
    title: string | null;
    translatedLanguage: string;
    externalUrl: string | null;
    version: number;
    /**
     * ISO-8601 creation time. Load-bearing for duplicate resolution: when the
     * same chapter exists twice on MangaDex the oldest one is kept, so this
     * decides which id survives. Empty string when MangaDex omitted it.
     */
    createdAt: string;
  };
  relationships: { id: string; type: string }[];
}

export interface MdManga {
  id: string;
  attributes: {
    title: Record<string, string>;
    altTitles: Record<string, string>[];
    /**
     * Drives the "{lang}-ro" romanised-title fallback in format_title. Optional
     * so fixtures and mocks need not spell it out; MdClient always populates it.
     */
    originalLanguage?: string | null;
  };
}

/**
 * MangaDex API surface used by the processor and upload workers. Implemented
 * by MdClient (real) and the e2e mock. Implementations must rate-limit and
 * retry internally; callers treat every method as at-least-once safe.
 */
export interface MdApi {
  /** Paginated GET /chapter for a manga+group (order[createdAt]=desc). */
  chaptersForManga(mangaId: string, groupId: string): Promise<MdChapter[]>;
  /** Paginated GET /chapter?ids[]=… lookups (max 100 per call handled inside). */
  chaptersByIds(ids: string[]): Promise<MdChapter[]>;
  /** GET /manga?ids[]=… lookups. */
  mangaByIds(ids: string[]): Promise<MdManga[]>;
  /**
   * Search titles by name. Used before auto-creating a title, so an existing
   * MangaDex entry is mapped rather than duplicated.
   */
  searchManga(title: string, limit?: number): Promise<MdManga[]>;
  /** GET /manga/{id}/aggregate for volume backfill. */
  mangaAggregate(mangaId: string, groupId: string): Promise<unknown>;
  /** Upload-session lifecycle. */
  currentUploadSession(): Promise<{ id: string } | null>;
  deleteUploadSession(sessionId: string): Promise<void>;
  createUploadSession(mangaId: string, groupIds: string[]): Promise<{ id: string }>;
  uploadImages(
    sessionId: string,
    files: { name: string; data: Buffer }[],
  ): Promise<{ id: string; originalFileName: string }[]>;
  commitUploadSession(
    sessionId: string,
    draft: {
      volume: string | null;
      chapter: string | null;
      title: string | null;
      translatedLanguage: string;
      externalUrl: string | null;
    },
    pageOrder: string[],
  ): Promise<{ id: string } | null>;
  editChapter(chapterId: string, payload: Record<string, unknown>): Promise<boolean>;
  deleteChapter(chapterId: string): Promise<boolean>;
  /**
   * Title creation for the automated untracked-series pipeline: POST /manga
   * creates a draft, POST /manga/draft/{id}/commit publishes it.
   */
  createMangaDraft(payload: {
    title: Record<string, string>;
    originalLanguage: string;
    status: string;
    contentRating: string;
    links?: Record<string, string>;
  }): Promise<{ id: string; version: number }>;
  commitMangaDraft(mangaId: string, version: number): Promise<boolean>;
}
