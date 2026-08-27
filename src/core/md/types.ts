import type { ChapterRecord } from "../../contracts/records.js";

/**
 * Internal canonical chapter shape; the platform-side mirror of the
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
    /**
     * How many pages MangaDex is hosting for this chapter, and, for the
     * external chapters this platform publishes, the thing that says whether
     * it has been marked unavailable.
     *
     * An external chapter normally has NO pages: the reader follows
     * `externalUrl` to the publisher. Marking one unavailable replaces that
     * with a card, which is a page. So `externalUrl && pages > 0` is a chapter
     * carrying our card, and `externalUrl && pages === 0` is a live one. On the
     * live group this separates cleanly: every carded chapter has exactly one
     * page, and every live one has none.
     */
    pages?: number;
    /**
     * MangaDex's own "I will not serve this" flag. Distinct from the above:
     * this is MangaDex hiding a chapter, not us having carded it.
     *
     * Optional because it is genuinely absent, not merely sometimes false:
     * chapters whose records predate the field carry no such key even while
     * MangaDex is refusing to serve them. So `isUnavailable !== true` does not
     * mean available, and MangaDex-side hiding is established by asking whether
     * the chapter is dropped from a collection read without
     * `includeUnavailable` (see MdClient.chapterAvailabilityForGroup). Trust
     * this flag only when it is `true`.
     */
    isUnavailable?: boolean;
  };
  relationships: { id: string; type: string }[];
}

/**
 * Does this MangaDex record carry one of our unavailable cards?
 *
 * Both halves matter. `pages > 0` alone would sweep in any natively hosted
 * chapter, and `externalUrl` alone describes every chapter this platform has
 * ever published, live ones included.
 *
 * This lives here rather than beside its first caller because it is load
 * bearing in three separate places: the reconcile sweep archives on it, the
 * removal passes must not treat a carded chapter as removable, and duplicate
 * detection must not treat two cards as duplicates of each other. Marking a
 * chapter unavailable REPOINTS externalUrl (to the publisher's manga page, or
 * failing that its domain root) rather than clearing it, so every card in a
 * manga collides on URL; the page count is the only signal that separates them.
 */
export function isCardedAttributes(attributes: Record<string, unknown>): boolean {
  const external = attributes["externalUrl"];
  const pages = attributes["pages"];
  return typeof external === "string" && external !== "" && typeof pages === "number" && pages > 0;
}

/**
 * The MangaDex user who uploaded a chapter, or null when the read did not ask
 * for the relationship.
 *
 * Null is not "nobody": it means the question was not asked, and callers must
 * treat it as unknown ownership rather than as ours. `chaptersForManga` and
 * `chaptersForGroup` request `includes[]=user` so the answer is present.
 */
export function uploaderId(chapter: MdChapter): string | null {
  return chapter.relationships.find((rel) => rel.type === "user")?.id ?? null;
}

/**
 * A personal client id embeds the owner's user id:
 * `personal-client-<uuid>-<suffix>`. Extracting it means ownership checks work
 * from the credentials already configured, rather than needing a second value
 * that can drift out of sync with the account actually uploading.
 */
export function botUserIdFromClientId(clientId: string | undefined | null): string | null {
  if (!clientId) return null;
  const match = /personal-client-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(
    clientId,
  );
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * May this chapter be deleted, carded or edited?
 *
 * Fails closed in both unknown cases -- no configured bot id, or a chapter
 * whose uploader was not read -- because the cost of the two mistakes is not
 * symmetric. Refusing to act on our own chapter leaves a stale entry that the
 * next run retries; acting on someone else's destroys their work, and no run
 * can undo it.
 *
 * Group membership is deliberately not accepted as a substitute: other people
 * upload into the same scanlation group, so `groups[]=<ours>` narrows the set
 * without establishing who made any particular chapter.
 */
export function uploadedByBot(chapter: MdChapter, botUserId: string | null): boolean {
  if (!botUserId) return false;
  const uploader = uploaderId(chapter);
  if (uploader === null) return false;
  return uploader.toLowerCase() === botUserId.toLowerCase();
}

/** `isCardedAttributes` for an already-parsed chapter. */
export function isCarded(chapter: MdChapter): boolean {
  return isCardedAttributes(chapter.attributes);
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
 * A single title read in full; what an operator is shown before correcting a
 * MangaDex entry, and what an edit needs in order to be safe.
 *
 * `version` is the load-bearing field: MangaDex requires the version it
 * currently holds on every PUT /manga/{id}, and rejects the write when someone
 * else has edited the title since we read it. That optimistic check is the only
 * thing standing between two concurrent operators and a lost correction, so the
 * version always travels with the fields it describes rather than being fetched
 * separately.
 */
export interface MdMangaDetail extends MdManga {
  attributes: {
    title: Record<string, string>;
    altTitles: Record<string, string>[];
    originalLanguage?: string | null;
    status?: string | null;
    contentRating?: string | null;
    /** `raw` is the one this pipeline writes: the source URL of the series. */
    links?: Record<string, string> | null;
    version: number;
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
   * GET /manga/{id}; one title in full, or null when MangaDex 404s it. Used
   * before editing a title, both to show an operator what the entry actually
   * says and to read the `version` the edit has to carry.
   */
  mangaById(mangaId: string): Promise<MdMangaDetail | null>;
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
  /**
   * PUT /manga/{id}; correct a title this pipeline is responsible for.
   *
   * `version` is the version read from the title; MangaDex bumps it itself, and
   * rejects the request outright if it is not the current one. `payload` carries
   * ONLY the fields being changed (see `mangaEditPayload` in titleService.ts):
   * an omitted field is left alone, but a field that IS sent replaces its whole
   * value; so a `title` or `links` object must be the merged result, never just
   * the one entry being corrected.
   */
  editManga(
    mangaId: string,
    payload: Record<string, unknown>,
    version: number,
  ): Promise<boolean>;
}
