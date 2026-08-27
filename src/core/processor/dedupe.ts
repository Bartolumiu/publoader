import { isCarded, uploadedByBot, type Chapter, type MdChapter, type MdManga } from "../md/types.js";

/**
 * Pure decision logic. Nothing here performs I/O or touches Prisma: every
 * function takes the data it needs and returns a decision, so the whole
 * duplicate/edit/skip/remove matrix is unit-testable in isolation.
 *
 * These functions never mutate their arguments. `decideForManga` works on
 * shallow copies of the chapters it is given, and the copies are what appear in
 * the returned buckets.
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
  /** The body to POST: old state with the changed fields overwritten. */
  payload: MdChapterPayload;
}

export interface DecideInput {
  mangadexMangaId: string;
  updatedChapters: Chapter[];
  /**
   * Every chapter the extension currently lists for this manga, or null when
   * the extension does not publish a full listing. null disables the
   * "on MangaDex but no longer on the publisher" removal pass entirely; an
   * empty array does not, and means the publisher has nothing here any more.
   */
  allMangaChapters: Chapter[] | null;
  chaptersOnMd: MdChapter[];
  /** Chapters uploaded earlier in this same run. See note in processor.ts. */
  postedMdUpdates: Chapter[];
  overrideOptions: OverrideOptionsLike;
  languages: string[];
  groupId: string;
  cleanDb: boolean;
  /**
   * The MangaDex user publoader uploads as. Chapters uploaded by anyone else
   * are left alone by every destructive pass.
   *
   * Optional in the type but not in effect: absent means no chapter can be
   * shown to be ours, so nothing is removed. That is the intended failure
   * direction -- a missed removal is retried next run, a wrong deletion is
   * somebody's work gone.
   */
  botUserId?: string | null;
  /**
   * Whether this extension fetches chapter images at all, judged over the whole
   * run rather than this manga.
   *
   * It has to be run-wide. The judgement is needed precisely for a series that
   * reported no updates — a dormant one — and such a series contributes no
   * evidence of its own either way, so deciding it from this manga's chapters
   * would answer "no pages" for exactly the series the question is about.
   */
  extensionPublishesPages?: boolean;
}

export interface DecideResult {
  toUpload: Chapter[];
  toEdit: ChapterEdit[];
  /** Duplicates that needed no change; bookkeeping only. */
  skipped: Chapter[];
  /**
   * Chapters dropped because the `same` override says they were already
   * uploaded under their master id. Surfaced for observability and not written
   * to bookkeeping, since they carry no mdChapterId.
   */
  skippedDifferentId: Chapter[];
  /** Chapters on MangaDex that no longer belong there. */
  toRemove: MdChapter[];
  /**
   * Clean runs only: chapters the publisher still lists, that are not on
   * MangaDex, and that this run cannot publish because it holds no pages for
   * them and the extension is one that uploads pages.
   *
   * Not an error and not silently dropped. The clean run genuinely found a gap;
   * it just cannot fill it from a catalogue listing, because a listing carries
   * chapter metadata and not chapter images. Filling it needs a run that
   * actually fetches those chapters. Reported so an operator sees the gap
   * exists rather than reading "0 uploads" as "nothing was missing".
   */
  missingWithoutPages: Chapter[];
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function flatten<T>(nested: T[][]): T[] {
  return nested.reduce<T[]>((acc, sublist) => acc.concat(sublist), []);
}

/** The key whose list value contains `element`. */
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
 * The path component of a URL, deliberately not WHATWG `new URL()`: a bare
 * string with no scheme is entirely path, where `new URL` would throw. Query,
 * fragment and trailing `;params` are stripped.
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

  // `;params` is only split off the last path segment.
  const lastSlash = rest.lastIndexOf("/");
  const params = rest.indexOf(";", lastSlash === -1 ? 0 : lastSlash);
  if (params !== -1) rest = rest.slice(0, params);

  return rest;
}

/**
 * Does any slash-separated component of `chapterId` appear as a whole path
 * component of the MangaDex externalUrl? This is how an external chapter link
 * is tied back to the extension's chapter id.
 */
export function checkChapterUrlSame(
  mdExternalUrl: string | null | undefined,
  chapterId: string | null | undefined,
): boolean {
  // A missing url and an empty chapter id are both "no match": an id-less
  // chapter can never be identified by its url, and an empty id would otherwise
  // match everything, since both sides split to [""].
  if (!mdExternalUrl || !chapterId) return false;

  const pathSegments = stripSlashes(urlPath(mdExternalUrl)).split("/");
  const idSegments = stripSlashes(chapterId).split("/");
  return idSegments.some((segment) => pathSegments.includes(segment));
}

/**
 * The MangaDex title may sit under "en", or only as a romanised "{lang}-ro"
 * with the English title in altTitles, which is a list of single-key
 * {lang: title} objects.
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
// Volume backfill
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
 * Fill in `chapterVolume` for chapters that don't carry one, by finding the
 * aggregate volume that lists the chapter's number. Only the integer part is
 * matched ("12.5" to "12"), the "none" volume is skipped, and leading zeros are
 * stripped ("008" to "8"). Mutates the chapters in place; the last matching
 * volume wins.
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

/** Chapter identity, used when subtracting uploaded and edited chapters from the skipped set. */
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
 * Chapters on MangaDex under our group that either speak a language the
 * extension is not allowed to publish, or whose externalUrl is no longer among
 * the publisher's chapters for this manga. Only meaningful when the extension
 * supplied a full chapter listing.
 */
function findExtraChapters(input: DecideInput): MdChapter[] {
  if (input.allMangaChapters === null) return [];

  const customLanguage = input.overrideOptions.custom_language ?? {};
  const allowedLanguages = new Set([...input.languages, ...Object.values(customLanguage)]);

  /**
   * The languages this run actually looked at for this series.
   *
   * One MangaDex title is fed by several of the publisher's titles — one per
   * language — and a run does not always fetch all of them. A scoped recheck of
   * RuriDragon fetched only the English title and reported eight English
   * chapters; the pass below then compared every French, Spanish, Thai and
   * Indonesian chapter on MangaDex against that English-only listing, found
   * them all "missing", and carded 213 live chapters.
   *
   * Absence is only evidence about a language the run can actually speak for.
   * A chapter in a language this listing never covered is not missing from it;
   * it was never in scope, and the run has nothing to say about it.
   *
   * An empty catalogue is the deliberate exception: "the publisher has nothing
   * for this series" carries no language, and must stay able to remove.
   */
  const coveredLanguages = new Set(input.allMangaChapters.map((c) => c.chapterLanguage));
  const listingCoversEveryLanguage = input.allMangaChapters.length === 0;
  // Null urls are kept in the set deliberately: the comprehension
  // included them, so an MD chapter with no externalUrl is "still present"
  // whenever any extension chapter also lacks one.
  const externalUrls = new Set<string | null>(input.allMangaChapters.map((c) => c.chapterUrl));

  return input.chaptersOnMd.filter(
    (mdChapter) =>
      // Somebody else's upload is never ours to remove. Filtering the listing
      // by our scanlation group is not enough on its own: other people upload
      // into the same group, and this pass has queued chapters this account
      // never uploaded for deletion because of it. `uploadedByBot` fails closed
      // when the uploader is unknown or the bot id is not configured.
      uploadedByBot(mdChapter, input.botUserId ?? null) &&
      // A chapter already carrying our card has reached the end state this
      // pass exists to move chapters towards, and it can never satisfy the url
      // test below: marking it unavailable repointed its externalUrl away from
      // the publisher's chapter, so it looks "no longer listed" on every
      // subsequent run. Left in, it is re-queued forever — re-carded under
      // `unavailable`, hard-deleted under `delete`.
      !isCarded(mdChapter) &&
      // A language the extension may not publish at all should not be on
      // MangaDex under our group whatever this run happened to fetch, so that
      // branch needs no coverage check.
      (!allowedLanguages.has(mdChapter.attributes.translatedLanguage) ||
        // "Missing from the listing" is only evidence for a language the run
        // actually fetched. See `coveredLanguages`.
        ((listingCoversEveryLanguage ||
          coveredLanguages.has(mdChapter.attributes.translatedLanguage)) &&
          !externalUrls.has(mdChapter.attributes.externalUrl))),
  );
}

/**
 * Is this chapter already on MangaDex? Matched by comparing the MD
 * externalUrl's path components against the extension chapter id. Chapters
 * listed as an alternate id in the `same` override are never matched here;
 * `checkUploadedDifferentId` handles them.
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

  // Chapter ids are plain tokens, so a
  // substring test is equivalent and cannot blow up on regex metacharacters.
  const onMd = input.chaptersOnMd.some(
    (c) => c.attributes.externalUrl !== null && c.attributes.externalUrl.includes(masterId),
  );
  const postedThisRun = input.postedMdUpdates.some((c) => String(c.chapterId) === masterId);
  return onMd || postedThisRun;
}

/**
 * Field-by-field diff of the extension's chapter against the live MangaDex
 * chapter. Returns null when nothing changed, or when the MD externalUrl does
 * not contain this chapter's id.
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

/** The whole per-manga decision, minus the database writes the caller performs. */
export function decideForManga(input: DecideInput): DecideResult {
  const sameChapterIds = new Set(flatten(Object.values(input.overrideOptions.same ?? {})));

  // Removal is decided from the untouched MD listing, before any dedupe: a
  // chapter can be both "no longer on the publisher" and a match for an
  // updated chapter, and it is queued for removal in the
  // constructor regardless.
  const toRemove = input.chaptersOnMd.length > 0 ? findExtraChapters(input) : [];

  const { candidates, fromListingOnly } = decideCandidates(input);
  const updated = candidates
    .filter((chapter) => chapter.mdMangaId !== null)
    .map((chapter) => ({ ...chapter }));

  // A clean run may publish a chapter it holds no pages for only when there is
  // nothing missing from it. An external-link extension publishes an
  // `externalUrl` and nothing else, so a listing entry is already a whole
  // chapter. For an extension that uploads pages it is not, and committing it
  // would put a pageless chapter on a public page — and an entry with neither
  // pages nor a url is not a chapter at all, whatever the extension does.
  const publishesPages =
    input.extensionPublishesPages ?? candidates.some((c) => c.imageArtifacts.length > 0);

  const toUpload: Chapter[] = [];
  const missingWithoutPages: Chapter[] = [];
  const skippedDifferentId: Chapter[] = [];
  const dupes: { chapter: Chapter; mdChapter: MdChapter }[] = [];

  for (const chapter of updated) {
    const dupe = checkForDuplicate(chapter, input, sameChapterIds);
    if (dupe) {
      dupes.push(dupe);
    } else if (checkUploadedDifferentId(chapter, input, sameChapterIds)) {
      skippedDifferentId.push(chapter);
    } else if (
      chapter.imageArtifacts.length === 0 &&
      fromListingOnly.has(chapterIdentity(chapter)) &&
      (publishesPages || !chapter.chapterUrl)
    ) {
      missingWithoutPages.push(chapter);
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

  return { toUpload, toEdit, skipped, skippedDifferentId, toRemove, missingWithoutPages };
}

/**
 * What a run compares against MangaDex.
 *
 * An update run compares what the extension flagged as new or changed, which is
 * the whole point of one. A clean run compares the publisher's entire current
 * listing, which is the whole point of THAT: "clean" is the run that re-derives
 * the answer from scratch instead of trusting the incremental record, and it is
 * the only run that can find a chapter which was missed, or whose title drifted,
 * back when it was the new one.
 *
 * The core does this rather than trusting the extension to. `postedChapterIds`
 * is already sent empty on a clean run, which is the contract's way of asking
 * an extension to report everything — but an extension that keeps its own
 * cursor, or that reads updates off a feed endpoint and the catalogue off a
 * different one, answers with its usual handful anyway. `allChapters` is the
 * listing either way, and it is the thing the contract actually defines as
 * "everything the publisher has".
 *
 * The updated record wins on collision: both describe the same chapter, but
 * only the updated one carries the image artifacts this run fetched.
 */
function decideCandidates(input: DecideInput): {
  candidates: Chapter[];
  /** Identities present only in the listing, so never fetched this run. */
  fromListingOnly: Set<string>;
} {
  if (!input.cleanDb || input.allMangaChapters === null) {
    return { candidates: input.updatedChapters, fromListingOnly: new Set() };
  }

  const byIdentity = new Map<string, Chapter>();
  for (const chapter of input.allMangaChapters) byIdentity.set(chapterIdentity(chapter), chapter);
  const fromListingOnly = new Set(byIdentity.keys());
  for (const chapter of input.updatedChapters) {
    const identity = chapterIdentity(chapter);
    byIdentity.set(identity, chapter);
    fromListingOnly.delete(identity);
  }
  return { candidates: [...byIdentity.values()], fromListingOnly };
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

/**
 * Does this link identify a chapter, or merely a publisher?
 *
 * Carding repoints externalUrl at the best link it can find: the chapter, then
 * the series, then -- when neither is known -- the publisher's bare domain.
 * That last one is not an identity. Every chapter that fell through to it
 * carries the same url while being a different chapter, so keying duplicates on
 * it buckets unrelated chapters together and hard-deletes all but the oldest.
 *
 * A scan of 773 series found exactly three "duplicates" and all three were
 * this: distinct RuriDragon chapters -- en 5 and 6, es-la 4, 5 and 6 -- whose
 * only shared feature was `https://mangaplus.shueisha.co.jp/`. Applying it
 * would have deleted three live chapters.
 *
 * Anything with a real path is left alone, because that is where genuine
 * chapter links live and where `multi_chapters` does its work.
 */
function identifiesAChapter(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") !== "";
  } catch {
    // Unparseable: it cannot be shown to identify anything, so it does not.
    return false;
  }
}

/**
 * Chapters that duplicate one another. External/link chapters are keyed on
 * their exact externalUrl; image chapters, and link chapters whose url names
 * only the publisher, fall back to volume + number. Language is part of every
 * key, so the same chapter in two languages is never a duplicate of itself.
 *
 * The url key is deliberately kept for real links rather than tightened with
 * the chapter number. `multi_chapters` exists precisely to say which numbers
 * legitimately share one publisher link, so that an undeclared extra copy is
 * still caught; adding the number here would make every number its own bucket
 * and quietly retire that whole mechanism.
 */
function dupeKey(mdChapter: MdChapter): string {
  const attrs = mdChapter.attributes;
  if (attrs.externalUrl && identifiesAChapter(attrs.externalUrl)) {
    return JSON.stringify([attrs.translatedLanguage, "url", attrs.externalUrl]);
  }
  return JSON.stringify([attrs.translatedLanguage, "image", attrs.volume, attrs.chapter]);
}

function createdAt(mdChapter: MdChapter): string | null {
  const value = (mdChapter.attributes as { createdAt?: unknown }).createdAt;
  return typeof value === "string" ? value : null;
}

/**
 * Within each group of duplicates the oldest chapter is kept and the rest are
 * queued for deletion. Chapters covered by a `multi_chapters` override are
 * handled separately: one chapter per declared chapter number survives.
 *
 * Ordering is by `createdAt` when the API supplied it; otherwise the input
 * order is used, which the MangaDex client returns oldest-first.
 */
export function findDuplicateChapters(
  chapters: MdChapter[],
  options: {
    groupId: string;
    multiChapters?: Record<string, string[]>;
    /**
     * The MangaDex user publoader uploads as; a duplicate uploaded by anyone
     * else is not ours to delete. Absent means nothing can be shown to be
     * ours, so nothing is deleted.
     */
    botUserId?: string | null;
  },
): MdChapter[] {
  const multiChapters = options.multiChapters ?? {};

  // Cards are excluded before anything is compared. Marking a chapter
  // unavailable repoints its externalUrl at the publisher's manga page (or its
  // domain root), which is the SAME url for every carded chapter of that
  // series, so on `dupeKey` they all collapse into one bucket and every card
  // but the oldest is queued for deletion. Duplicates are hard-deleted whatever
  // the removal mode, so that path silently converted "mark unavailable" into
  // "delete" one chapter at a time, on every run.
  const chaptersToCheck = chapters.filter(
    (c) =>
      // Duplicates are hard-deleted whatever the removal mode, so this is the
      // most destructive path in the codebase and the least forgiving of a
      // wrong answer. Group membership alone does not establish authorship:
      // another uploader in the same group whose chapter happens to collide on
      // `dupeKey` would have their work deleted as our duplicate.
      uploadedByBot(c, options.botUserId ?? null) &&
      scanlationGroups(c).includes(options.groupId) &&
      !isCarded(c),
  );
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
