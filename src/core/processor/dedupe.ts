import type { Chapter, MdChapter, MdManga } from "../md/types.js";

/**
 * Pure decision logic ported from the Python pipeline
 * (`publoader/manga_uploader.py`, `publoader/dupes_checker.py`,
 * `publoader/utils/misc.py`). Nothing in this file performs I/O or touches
 * Prisma — every function takes the data it needs and returns a decision, so
 * the whole duplicate/edit/skip/remove matrix is unit-testable in isolation.
 *
 * The functions here never mutate their arguments: `decideForManga` works on
 * shallow copies of the chapters it is given and the copies are what appear in
 * the returned buckets (the Python original mutated `md_chapter_id`,
 * `md_manga_id` and `md_group_id` in place and relied on the caller seeing it).
 */

export interface OverrideOptionsLike {
  /** master chapter id -> alternate ids that are the same chapter */
  same?: Record<string, string[]>;
  /** chapter id -> chapter numbers it legitimately maps to */
  multi_chapters?: Record<string, string[]>;
  /** extension language code -> MangaDex language code */
  custom_language?: Record<string, string>;
}

/** The MangaDex chapter-edit body, in the exact shape the API expects. */
export interface MdChapterPayload {
  volume: string | null;
  chapter: string | null;
  title: string | null;
  translatedLanguage: string;
  externalUrl: string | null;
  version: number;
  groups: string[];
}

export interface ChapterEdit {
  /** The extension chapter, with md ids filled in. */
  chapter: Chapter;
  mdChapterId: string;
  /** The chapter's MangaDex state before the edit. */
  oldInfo: MdChapterPayload;
  /** The body to POST — old state with the changed fields overwritten. */
  payload: MdChapterPayload;
}

export interface DecideInput {
  mangadexMangaId: string;
  updatedChapters: Chapter[];
  /**
   * Every chapter the extension currently lists for this manga, or null when
   * the extension does not publish a full listing. null disables the
   * "on MangaDex but no longer on the publisher" removal pass entirely — an
   * empty array does NOT (it means "the publisher has nothing here any more").
   */
  allMangaChapters: Chapter[] | null;
  chaptersOnMd: MdChapter[];
  /** Chapters uploaded earlier in this same run. See note in processor.ts. */
  postedMdUpdates: Chapter[];
  overrideOptions: OverrideOptionsLike;
  languages: string[];
  groupId: string;
  cleanDb: boolean;
}

export interface DecideResult {
  toUpload: Chapter[];
  toEdit: ChapterEdit[];
  /** Duplicates that needed no change — bookkeeping only. */
  skipped: Chapter[];
  /**
   * Chapters dropped because the `same` override says they were already
   * uploaded under their master id. Python discarded these silently; they are
   * surfaced here for observability and are NOT written to bookkeeping (they
   * carry no mdChapterId, exactly as before).
   */
  skippedDifferentId: Chapter[];
  /** Chapters on MangaDex that no longer belong there. */
  toRemove: MdChapter[];
}

// ---------------------------------------------------------------------------
// utils/misc.py ports
// ---------------------------------------------------------------------------

export function flatten<T>(nested: T[][]): T[] {
  return nested.reduce<T[]>((acc, sublist) => acc.concat(sublist), []);
}

/** find_key_from_list_value: the key whose list value contains `element`. */
export function findKeyFromListValue(
  dictToSearch: Record<string, string[]>,
  element: string,
): string | null {
  for (const [key, values] of Object.entries(dictToSearch)) {
    if (values.includes(element)) return key;
  }
  return null;
}

function stripSlashes(value: string): string {
  return value.replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * The path component of a URL, following Python's `urllib.parse.urlparse`
 * rather than WHATWG `new URL()`: a bare string with no scheme is entirely
 * path (urlparse("not-a-real-url").path === "not-a-real-url"), where `new URL`
 * would throw. Query, fragment and trailing `;params` are stripped.
 */
export function urlPath(url: string): string {
  let rest = url;

  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.exec(rest);
  if (scheme) rest = rest.slice(scheme[0].length);

  if (rest.startsWith("//")) {
    const afterSlashes = rest.slice(2);
    const authorityEnd = afterSlashes.search(/[/?#]/);
    rest = authorityEnd === -1 ? "" : afterSlashes.slice(authorityEnd);
  }

  const fragment = rest.indexOf("#");
  if (fragment !== -1) rest = rest.slice(0, fragment);
  const query = rest.indexOf("?");
  if (query !== -1) rest = rest.slice(0, query);

  // urllib only splits `;params` off the last path segment.
  const lastSlash = rest.lastIndexOf("/");
  const params = rest.indexOf(";", lastSlash === -1 ? 0 : lastSlash);
  if (params !== -1) rest = rest.slice(0, params);

  return rest;
}

/**
 * check_chapter_url_same: does any slash-separated component of `chapterId`
 * appear as a whole path component of the MangaDex externalUrl? This is how an
 * external chapter link is tied back to the extension's chapter id.
 */
export function checkChapterUrlSame(
  mdExternalUrl: string | null | undefined,
  chapterId: string | null | undefined,
): boolean {
  // Python only guarded the url and raised on a null chapter id; an empty id
  // matched everything (both sides split to [""]). Both are treated as "no
  // match" here — an id-less chapter can never be identified by its url.
  if (!mdExternalUrl || !chapterId) return false;

  const pathSegments = stripSlashes(urlPath(mdExternalUrl)).split("/");
  const idSegments = stripSlashes(chapterId).split("/");
  return idSegments.some((segment) => pathSegments.includes(segment));
}

/**
 * format_title: the MangaDex title may sit under "en", or (newer responses)
 * only as a romanised "{lang}-ro" with the English title in altTitles, which
 * is a list of single-key {lang: title} objects.
 */
export function formatTitle(manga: MdManga): string {
  const attributes = manga.attributes as
    | (MdManga["attributes"] & { originalLanguage?: string | null })
    | undefined;
  if (!attributes) return manga.id;

  const title = attributes.title ?? {};
  const altTitles = attributes.altTitles ?? [];

  const altLookup: Record<string, string> = {};
  for (const entry of altTitles) {
    if (entry && typeof entry === "object") {
      for (const [lang, value] of Object.entries(entry)) {
        if (!(lang in altLookup)) altLookup[lang] = value;
      }
    }
  }

  const pick = (lang: string): string | undefined => title[lang] || altLookup[lang];

  const originalLanguage = attributes.originalLanguage ?? null;
  let mangaTitle = pick("en");
  if (mangaTitle === undefined && originalLanguage) {
    mangaTitle = pick(`${originalLanguage}-ro`) ?? pick(originalLanguage);
  }
  if (mangaTitle === undefined) {
    const firstTitle = Object.values(title)[0];
    if (firstTitle !== undefined) mangaTitle = firstTitle;
  }
  if (mangaTitle === undefined) {
    const firstAlt = Object.values(altLookup)[0];
    if (firstAlt !== undefined) mangaTitle = firstAlt;
  }

  return mangaTitle || manga.id || "Untitled";
}

// ---------------------------------------------------------------------------
// Volume backfill (MangaUploaderProcess.get_chapter_volumes)
// ---------------------------------------------------------------------------

interface AggregateVolume {
  volume?: unknown;
  chapters?: unknown;
}

interface AggregateChapter {
  id?: unknown;
  chapter?: unknown;
  others?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The aggregate endpoint returns `volumes` either as a map keyed by volume
 * label or as an array of volume objects; each volume's `chapters` is likewise
 * a map keyed by chapter number or an array. Normalised here to
 * {label, chapterNumbers, chapters}.
 */
function aggregateVolumes(
  aggregate: unknown,
): { label: string | null; chapterNumbers: string[]; chapters: AggregateChapter[] }[] {
  const raw: { label: string | null; chapters: unknown }[] = [];

  if (isRecord(aggregate)) {
    for (const [label, volume] of Object.entries(aggregate)) {
      raw.push({ label, chapters: isRecord(volume) ? volume["chapters"] : undefined });
    }
  } else if (Array.isArray(aggregate)) {
    for (const volume of aggregate as AggregateVolume[]) {
      const label = isRecord(volume) && typeof volume["volume"] === "string" ? volume["volume"] : null;
      raw.push({ label, chapters: isRecord(volume) ? volume["chapters"] : undefined });
    }
  }

  return raw.map(({ label, chapters }) => {
    let entries: AggregateChapter[] = [];
    let numbers: string[] = [];
    if (isRecord(chapters)) {
      numbers = Object.keys(chapters);
      entries = Object.values(chapters).filter(isRecord) as AggregateChapter[];
    } else if (Array.isArray(chapters)) {
      entries = (chapters as unknown[]).filter(isRecord) as AggregateChapter[];
      numbers = entries
        .map((entry) => entry.chapter)
        .filter((n): n is string => typeof n === "string");
    }
    return { label, chapterNumbers: numbers, chapters: entries };
  });
}

/**
 * get_chapter_volumes: fill in `chapterVolume` for chapters that don't carry
 * one, by finding the aggregate volume that lists the chapter's number. Only
 * the integer part of the number is matched ("12.5" -> "12"), the "none"
 * volume is skipped, and leading zeros are stripped ("008" -> "8", "000" ->
 * "0"). Mutates the chapters in place, like the original; the last matching
 * volume wins (Python did not break out of the loop either).
 *
 * Deviation: the Python version only handled the map-shaped `chapters` and,
 * for the array shape, stringified the whole volume object into the volume
 * label. Both aggregate shapes are handled properly here.
 */
export function backfillVolumes(chapters: Chapter[], aggregate: unknown): void {
  const volumes = aggregateVolumes(aggregate);
  if (volumes.length === 0) return;

  for (const chapter of chapters) {
    if (chapter.chapterVolume !== null) continue;

    for (const volume of volumes) {
      if (volume.label === null || volume.label === "none") continue;
      const chapterNumber = chapter.chapterNumber?.split(".", 1)[0] ?? null;
      if (chapterNumber === null) continue;

      if (volume.chapterNumbers.includes(chapterNumber)) {
        chapter.chapterVolume = volume.label.replace(/^0+/, "") || "0";
      }
    }
  }
}

/** Every chapter id (and its `others`) in an aggregate response. */
export function aggregateChapterIds(aggregate: unknown): string[] {
  const ids: string[] = [];
  for (const volume of aggregateVolumes(aggregate)) {
    for (const chapter of volume.chapters) {
      if (typeof chapter.id === "string") ids.push(chapter.id);
      if (Array.isArray(chapter.others)) {
        for (const other of chapter.others) {
          if (typeof other === "string") ids.push(other);
        }
      }
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Per-manga upload / edit / skip / remove decisions
// ---------------------------------------------------------------------------

/**
 * Chapter.__eq__ / __hash__ in the Python dataclass compare this tuple, and
 * `start_manga_uploading_process` relies on it when subtracting the uploaded
 * and edited chapters from the skipped set.
 */
function chapterIdentity(chapter: Chapter): string {
  return JSON.stringify([
    chapter.chapterId,
    chapter.chapterNumber,
    chapter.chapterLanguage,
    chapter.mangaId,
    chapter.mangaName,
  ]);
}

function scanlationGroups(mdChapter: MdChapter): string[] {
  return mdChapter.relationships.filter((r) => r.type === "scanlation_group").map((r) => r.id);
}

/** The manga a MangaDex chapter belongs to, per its relationships. */
export function mdChapterMangaId(mdChapter: MdChapter): string | null {
  return mdChapter.relationships.find((r) => r.type === "manga")?.id ?? null;
}

/**
 * _delete_extra_chapters: chapters sitting on MangaDex under our group that
 * either speak a language the extension is not allowed to publish, or whose
 * externalUrl is no longer among the publisher's chapters for this manga.
 * Only meaningful when the extension supplied a full chapter listing.
 */
function findExtraChapters(input: DecideInput): MdChapter[] {
  if (input.allMangaChapters === null) return [];

  const customLanguage = input.overrideOptions.custom_language ?? {};
  const allowedLanguages = new Set([...input.languages, ...Object.values(customLanguage)]);
  // Null urls are kept in the set deliberately: Python's set comprehension
  // included them, so an MD chapter with no externalUrl is "still present"
  // whenever any extension chapter also lacks one.
  const externalUrls = new Set<string | null>(input.allMangaChapters.map((c) => c.chapterUrl));

  return input.chaptersOnMd.filter(
    (mdChapter) =>
      !allowedLanguages.has(mdChapter.attributes.translatedLanguage) ||
      !externalUrls.has(mdChapter.attributes.externalUrl),
  );
}

/**
 * _check_for_duplicate_chapter_md_list: is this chapter already on MangaDex?
 * Matched by comparing the MD externalUrl's path components against the
 * extension chapter id. Chapters listed as an alternate id in the `same`
 * override are never matched here — `checkUploadedDifferentId` handles them.
 */
function checkForDuplicate(
  chapter: Chapter,
  input: DecideInput,
  sameChapterIds: Set<string>,
): { chapter: Chapter; mdChapter: MdChapter } | null {
  const multiChapters = input.overrideOptions.multi_chapters ?? {};

  for (const mdChapter of input.chaptersOnMd) {
    if (!mdChapter.attributes.externalUrl) continue;
    if (chapter.chapterId !== null && sameChapterIds.has(chapter.chapterId)) continue;

    if (!checkChapterUrlSame(mdChapter.attributes.externalUrl, chapter.chapterId)) continue;

    // A single external chapter can legitimately back several MangaDex chapter
    // numbers; only the declared numbers count as the same chapter.
    if (chapter.chapterId !== null && chapter.chapterId in multiChapters) {
      const allowedNumbers = multiChapters[chapter.chapterId] ?? [];
      if (chapter.chapterNumber === null || !allowedNumbers.includes(chapter.chapterNumber)) {
        continue;
      }
    }

    chapter.mdChapterId = mdChapter.id;
    return { chapter, mdChapter };
  }
  return null;
}

/**
 * _check_uploaded_different_id: the `same` override maps a master chapter id
 * to alternate ids for the same chapter. If this chapter is one of the
 * alternates and the master is already on MangaDex (or was uploaded earlier in
 * this run), the chapter must not be uploaded again.
 */
function checkUploadedDifferentId(
  chapter: Chapter,
  input: DecideInput,
  sameChapterIds: Set<string>,
): boolean {
  if (chapter.chapterId === null || !sameChapterIds.has(chapter.chapterId)) return false;

  const masterId = findKeyFromListValue(input.overrideOptions.same ?? {}, chapter.chapterId);
  if (masterId === null) return false;

  // Python used `re.search(master_id, url)`; chapter ids are plain tokens, so a
  // substring test is equivalent and cannot blow up on regex metacharacters.
  const onMd = input.chaptersOnMd.some(
    (c) => c.attributes.externalUrl !== null && c.attributes.externalUrl.includes(masterId),
  );
  const postedThisRun = input.postedMdUpdates.some((c) => String(c.chapterId) === masterId);
  return onMd || postedThisRun;
}

/**
 * edit_chapter: field-by-field diff of the extension's chapter against the
 * live MangaDex chapter. Returns null when nothing changed, or when the MD
 * externalUrl does not actually contain this chapter's id (a defensive check
 * against a bad url match).
 */
function buildEdit(
  chapter: Chapter,
  mdChapter: MdChapter,
  mangadexMangaId: string,
  groupId: string,
): ChapterEdit | null {
  const attrs = mdChapter.attributes;
  const payload: MdChapterPayload = {
    volume: attrs.volume,
    chapter: attrs.chapter,
    title: attrs.title,
    translatedLanguage: attrs.translatedLanguage,
    externalUrl: attrs.externalUrl,
    version: attrs.version,
    groups: scanlationGroups(mdChapter),
  };
  // Snapshot before any field is overwritten, so the queued edit carries both
  // the old and the new MangaDex state in the same shape.
  const oldInfo: MdChapterPayload = { ...payload, groups: [...payload.groups] };

  if (
    chapter.chapterId === null ||
    !attrs.externalUrl ||
    !attrs.externalUrl.includes(chapter.chapterId)
  ) {
    return null;
  }

  let changed = false;
  if (chapter.chapterVolume !== attrs.volume) {
    payload.volume = chapter.chapterVolume;
    changed = true;
  }
  if (chapter.chapterNumber !== attrs.chapter) {
    payload.chapter = chapter.chapterNumber;
    changed = true;
  }
  if (chapter.chapterTitle !== attrs.title) {
    payload.title = chapter.chapterTitle;
    changed = true;
  }
  // The extension is expected to have already mapped its own language code
  // through `custom_language`; that override only widens the set of languages
  // allowed to stay on MangaDex (see findExtraChapters), it is not applied here.
  if (chapter.chapterLanguage !== attrs.translatedLanguage) {
    payload.translatedLanguage = chapter.chapterLanguage ?? attrs.translatedLanguage;
    changed = true;
  }
  if (!changed) return null;

  chapter.mdChapterId = mdChapter.id;
  chapter.mdMangaId = chapter.mdMangaId || mangadexMangaId;
  chapter.mdGroupId = groupId;
  return { chapter, mdChapterId: mdChapter.id, oldInfo, payload };
}

/**
 * The whole per-manga decision, equivalent to constructing a
 * MangaUploaderProcess and calling start_manga_uploading_process — minus the
 * database writes, which the caller performs.
 */
export function decideForManga(input: DecideInput): DecideResult {
  const sameChapterIds = new Set(flatten(Object.values(input.overrideOptions.same ?? {})));

  // Removal is decided from the untouched MD listing, before any dedupe: a
  // chapter can be both "no longer on the publisher" and a match for an
  // updated chapter, and the Python original queued it for removal in the
  // constructor regardless.
  const toRemove = input.chaptersOnMd.length > 0 ? findExtraChapters(input) : [];

  const updated = input.updatedChapters
    .filter((chapter) => chapter.mdMangaId !== null)
    .map((chapter) => ({ ...chapter }));

  const toUpload: Chapter[] = [];
  const skippedDifferentId: Chapter[] = [];
  const dupes: { chapter: Chapter; mdChapter: MdChapter }[] = [];

  for (const chapter of updated) {
    const dupe = checkForDuplicate(chapter, input, sameChapterIds);
    if (dupe) {
      dupes.push(dupe);
    } else if (checkUploadedDifferentId(chapter, input, sameChapterIds)) {
      skippedDifferentId.push(chapter);
    } else {
      toUpload.push(chapter);
    }
  }

  const toEdit: ChapterEdit[] = [];
  for (const dupe of dupes) {
    const edit = buildEdit(dupe.chapter, dupe.mdChapter, input.mangadexMangaId, input.groupId);
    if (edit) toEdit.push(edit);
  }

  const uploadedOrEdited = new Set([
    ...toUpload.map(chapterIdentity),
    ...toEdit.map((edit) => chapterIdentity(edit.chapter)),
  ]);
  const skipped = dupes
    .map((dupe) => dupe.chapter)
    .filter((chapter) => !uploadedOrEdited.has(chapterIdentity(chapter)));

  for (const chapter of toUpload) {
    chapter.mdMangaId = chapter.mdMangaId || input.mangadexMangaId;
    chapter.mdGroupId = input.groupId;
  }

  return { toUpload, toEdit, skipped, skippedDifferentId, toRemove };
}

// ---------------------------------------------------------------------------
// Duplicate detection (dupes_checker.DeleteDuplicatesMD)
// ---------------------------------------------------------------------------

/**
 * Chapters that duplicate one another. External/link chapters are keyed on
 * their exact externalUrl; image chapters fall back to volume + number.
 * Language is part of every key, so the same chapter in two languages is never
 * a duplicate of itself.
 */
function dupeKey(mdChapter: MdChapter): string {
  const attrs = mdChapter.attributes;
  if (attrs.externalUrl) {
    return JSON.stringify([attrs.translatedLanguage, "url", attrs.externalUrl]);
  }
  return JSON.stringify([attrs.translatedLanguage, "image", attrs.volume, attrs.chapter]);
}

function createdAt(mdChapter: MdChapter): string | null {
  const value = (mdChapter.attributes as { createdAt?: unknown }).createdAt;
  return typeof value === "string" ? value : null;
}

/**
 * check_chapters: within each group of duplicates the oldest chapter is kept
 * and the rest are queued for deletion. Chapters covered by a `multi_chapters`
 * override are handled separately — one chapter per declared chapter number
 * survives, the remainder are removed.
 *
 * Ordering is by `createdAt` when the API supplied it; otherwise the input
 * order is used, which the MangaDex client returns oldest-first.
 */
export function findDuplicateChapters(
  chapters: MdChapter[],
  options: { groupId: string; multiChapters?: Record<string, string[]> },
): MdChapter[] {
  const multiChapters = options.multiChapters ?? {};

  const chaptersToCheck = chapters.filter((c) => scanlationGroups(c).includes(options.groupId));
  if (chaptersToCheck.length <= 1) return [];

  const grouped = new Map<string, MdChapter[]>();
  for (const chapter of chaptersToCheck) {
    const key = dupeKey(chapter);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(chapter);
    else grouped.set(key, [chapter]);
  }

  const toRemove: MdChapter[] = [];
  for (const bucket of grouped.values()) {
    if (bucket.length <= 1) continue;

    const sorted = [...bucket].sort((a, b) => {
      const left = createdAt(a);
      const right = createdAt(b);
      if (left === null || right === null) return 0;
      return left < right ? -1 : left > right ? 1 : 0;
    });

    const multiChapterMatches: { externalChapterId: string; chapter: MdChapter }[] = [];
    for (const externalChapterId of Object.keys(multiChapters)) {
      for (const chapter of sorted) {
        if (checkChapterUrlSame(chapter.attributes.externalUrl, externalChapterId)) {
          multiChapterMatches.push({ externalChapterId, chapter });
        }
      }
    }

    const multiChapterSet = new Set(multiChapterMatches.map((m) => m.chapter));
    const singleChapters = sorted.filter((chapter) => !multiChapterSet.has(chapter));

    // One survivor per declared chapter number, in the order the duplicates
    // were created.
    const keep: MdChapter[] = [];
    for (const match of multiChapterMatches) {
      const declaredNumbers = multiChapters[match.externalChapterId] ?? [];
      if (match.chapter.attributes.chapter === null) continue;
      if (!declaredNumbers.includes(match.chapter.attributes.chapter)) continue;
      for (const number of declaredNumbers) {
        if (!keep.some((k) => k.attributes.chapter === number)) keep.push(match.chapter);
      }
    }

    for (const match of multiChapterMatches) {
      if (!keep.includes(match.chapter)) toRemove.push(match.chapter);
    }
    toRemove.push(...singleChapters.slice(1));
  }

  // A chapter can match more than one multi_chapters id; queue it once.
  const seen = new Set<string>();
  return toRemove.filter((chapter) => {
    if (seen.has(chapter.id)) return false;
    seen.add(chapter.id);
    return true;
  });
}
