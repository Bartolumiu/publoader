import { describe, expect, it } from "vitest";
import {
  aggregateChapterIds,
  backfillVolumes,
  checkChapterUrlSame,
  decideForManga,
  findDuplicateChapters,
  formatTitle,
  urlPath,
  type DecideInput,
} from "../../src/core/processor/dedupe.js";
import type { Chapter, MdChapter } from "../../src/core/md/types.js";

const chapter = (over: Partial<Chapter> = {}): Chapter => ({
  chapterLookup: null,
  chapterTimestamp: null,
  chapterExpire: null,
  chapterLanguage: "en",
  chapterNumber: null,
  chapterTitle: null,
  chapterVolume: null,
  chapterId: null,
  chapterUrl: null,
  mdChapterId: null,
  mangaId: "ext-manga",
  mdMangaId: "md-manga",
  mdGroupId: null,
  mangaName: null,
  mangaUrl: null,
  extensionName: "ext",
  imageArtifacts: [],
  ...over,
});

const mdChapter = (
  id: string,
  attributes: Partial<MdChapter["attributes"]> = {},
  groups: string[] = ["grp"],
): MdChapter => ({
  id,
  // Cast so the factory keeps compiling if the client grows the attribute set.
  attributes: {
    volume: null,
    chapter: null,
    title: null,
    translatedLanguage: "en",
    externalUrl: null,
    version: 1,
    ...attributes,
  } as MdChapter["attributes"],
  relationships: [
    { id: "md-manga", type: "manga" },
    ...groups.map((group) => ({ id: group, type: "scanlation_group" })),
  ],
});

const withCreatedAt = (md: MdChapter, createdAt: string): MdChapter => {
  (md.attributes as unknown as { createdAt: string }).createdAt = createdAt;
  return md;
};

const decide = (over: Partial<DecideInput>) =>
  decideForManga({
    mangadexMangaId: "md-manga",
    updatedChapters: [],
    allMangaChapters: null,
    chaptersOnMd: [],
    postedMdUpdates: [],
    overrideOptions: {},
    languages: ["en"],
    groupId: "grp",
    cleanDb: false,
    ...over,
  });

describe("checkChapterUrlSame", () => {
  it("matches a chapter id against whole path components", () => {
    expect(checkChapterUrlSame("https://site.com/chapter/12345", "12345")).toBe(true);
    expect(checkChapterUrlSame("https://site.com/chapter/12345/page", "12345")).toBe(true);
    expect(checkChapterUrlSame("https://site.com/titles/9/chapters/12345", "9/12345")).toBe(true);
    expect(checkChapterUrlSame("https://site.com/chapter/12345", "99999")).toBe(false);
  });

  it("never throws on input that is not a url", () => {
    expect(checkChapterUrlSame("not-a-real-url", "x")).toBe(false);
    expect(checkChapterUrlSame(null, "12345")).toBe(false);
    expect(checkChapterUrlSame("https://site.com/c/1", null)).toBe(false);
  });

  it("parses paths permissively, not the way new URL() does", () => {
    expect(urlPath("not-a-real-url")).toBe("not-a-real-url");
    expect(urlPath("https://site.com/a/b?q=1#f")).toBe("/a/b");
    expect(urlPath("https://site.com/a/b;p=1")).toBe("/a/b");
  });
});

describe("formatTitle", () => {
  it("prefers the English title", () => {
    expect(formatTitle({ id: "m1", attributes: { title: { en: "English" }, altTitles: [] } })).toBe(
      "English",
    );
  });

  it("falls back to the romanised original language, then altTitles, then the id", () => {
    expect(
      formatTitle({
        id: "m2",
        attributes: {
          title: { "ja-ro": "Romaji" },
          altTitles: [{ ja: "日本語" }],
          originalLanguage: "ja",
        } as never,
      }),
    ).toBe("Romaji");
    expect(
      formatTitle({ id: "m3", attributes: { title: {}, altTitles: [{ en: "Alt English" }] } }),
    ).toBe("Alt English");
    expect(formatTitle({ id: "m4", attributes: { title: {}, altTitles: [] } })).toBe("m4");
  });
});

describe("backfillVolumes", () => {
  const dictAggregate = {
    none: { volume: "none", chapters: { "1": { chapter: "1", id: "c-none" } } },
    "007": { volume: "007", chapters: { "12": { chapter: "12", id: "c1", others: ["c1b"] } } },
    "0": { volume: "0", chapters: { "3": { chapter: "3", id: "c2", others: [] } } },
  };

  it("matches on the integer part and strips leading zeros", () => {
    const chapters = [chapter({ chapterNumber: "12.5" }), chapter({ chapterNumber: "3" })];
    backfillVolumes(chapters, dictAggregate);
    expect(chapters.map((c) => c.chapterVolume)).toEqual(["7", "0"]);
  });

  it("skips the 'none' volume and never overwrites an existing volume", () => {
    const chapters = [
      chapter({ chapterNumber: "1" }),
      chapter({ chapterNumber: "12", chapterVolume: "keep" }),
    ];
    backfillVolumes(chapters, dictAggregate);
    expect(chapters.map((c) => c.chapterVolume)).toEqual([null, "keep"]);
  });

  it("handles the array-shaped aggregate response", () => {
    const chapters = [chapter({ chapterNumber: "20" })];
    backfillVolumes(chapters, [
      { volume: "2", chapters: [{ chapter: "20", id: "c20", others: ["c20b"] }] },
      { volume: "none", chapters: [{ chapter: "21", id: "c21" }] },
    ]);
    expect(chapters[0]!.chapterVolume).toBe("2");
  });

  it("collects chapter ids and their others for the dupe sweep", () => {
    expect(aggregateChapterIds(dictAggregate).sort()).toEqual(["c-none", "c1", "c1b", "c2"]);
  });
});

describe("decideForManga", () => {
  const onMd = mdChapter("md-1", {
    chapter: "1",
    title: "Old",
    externalUrl: "https://pub.example/chapter/aaa",
  });
  const onMdUnchanged = mdChapter("md-2", {
    chapter: "9",
    title: "T",
    externalUrl: "https://pub.example/chapter/ccc",
  });

  const fresh = chapter({
    chapterId: "bbb",
    chapterNumber: "2",
    chapterUrl: "https://pub.example/chapter/bbb",
  });
  const changed = chapter({
    chapterId: "aaa",
    chapterNumber: "1",
    chapterTitle: "New",
    chapterUrl: "https://pub.example/chapter/aaa",
  });
  const unchanged = chapter({
    chapterId: "ccc",
    chapterNumber: "9",
    chapterTitle: "T",
    chapterUrl: "https://pub.example/chapter/ccc",
  });

  it("splits new, edited and unchanged chapters", () => {
    const result = decide({
      updatedChapters: [fresh, changed, unchanged],
      allMangaChapters: [fresh, changed, unchanged],
      chaptersOnMd: [onMd, onMdUnchanged],
    });

    expect(result.toUpload.map((c) => c.chapterId)).toEqual(["bbb"]);
    expect(result.toUpload[0]!.mdGroupId).toBe("grp");
    expect(result.toEdit).toHaveLength(1);
    expect(result.toEdit[0]!.mdChapterId).toBe("md-1");
    expect(result.toEdit[0]!.oldInfo.title).toBe("Old");
    expect(result.toEdit[0]!.payload.title).toBe("New");
    expect(result.toEdit[0]!.oldInfo.groups).toEqual(["grp"]);
    expect(result.skipped).toHaveLength(1);
    expect(result.toRemove).toEqual([]);
  });

  it("carries the matched MangaDex id onto skipped chapters for bookkeeping", () => {
    const result = decide({
      updatedChapters: [unchanged],
      chaptersOnMd: [onMdUnchanged],
    });
    expect(result.skipped[0]!.mdChapterId).toBe("md-2");
  });

  it("does not mutate the chapters it is given", () => {
    const input = chapter({ chapterId: "bbb", chapterNumber: "2" });
    decide({ updatedChapters: [input], chaptersOnMd: [] });
    expect(input.mdGroupId).toBeNull();
  });

  it("removes chapters in a disallowed language or no longer published", () => {
    const strayLanguage = mdChapter("md-3", {
      translatedLanguage: "fr",
      externalUrl: "https://pub.example/chapter/ccc",
    });
    const strayUrl = mdChapter("md-4", { externalUrl: "https://pub.example/chapter/zzz" });

    const result = decide({
      allMangaChapters: [unchanged],
      chaptersOnMd: [onMdUnchanged, strayLanguage, strayUrl],
      cleanDb: true,
    });
    expect(result.toRemove.map((c) => c.id)).toEqual(["md-3", "md-4"]);
  });

  it("keeps languages that custom_language maps into", () => {
    const strayLanguage = mdChapter("md-3", {
      translatedLanguage: "fr",
      externalUrl: "https://pub.example/chapter/ccc",
    });
    const result = decide({
      allMangaChapters: [unchanged],
      chaptersOnMd: [strayLanguage],
      overrideOptions: { custom_language: { fre: "fr" } },
      cleanDb: true,
    });
    expect(result.toRemove).toEqual([]);
  });

  /**
   * A carded chapter can never satisfy the "still listed by the publisher"
   * test: marking it unavailable repointed its url away from the publisher's
   * chapter. Left in the removal set it is re-queued on every single run, which
   * under `unavailable` re-renders and re-uploads the card and under `delete`
   * destroys it.
   */
  it("leaves chapters that already carry our unavailable card alone", () => {
    const carded = mdChapter("md-carded", {
      externalUrl: "https://pub.example/manga/42",
      pages: 1,
    });
    const result = decide({
      allMangaChapters: [unchanged],
      chaptersOnMd: [onMdUnchanged, carded],
      cleanDb: true,
    });
    expect(result.toRemove).toEqual([]);
  });

  it("removes nothing when the extension publishes no full listing", () => {
    const result = decide({
      allMangaChapters: null,
      chaptersOnMd: [mdChapter("md-4", { externalUrl: "https://pub.example/chapter/zzz" })],
    });
    expect(result.toRemove).toEqual([]);
  });

  it("drops an alternate id whose master chapter is already on MangaDex", () => {
    const alternate = chapter({
      chapterId: "alt-1",
      chapterNumber: "5",
      chapterUrl: "https://pub.example/chapter/alt-1",
    });
    const result = decide({
      updatedChapters: [alternate],
      chaptersOnMd: [mdChapter("md-9", { externalUrl: "https://pub.example/chapter/master-1" })],
      overrideOptions: { same: { "master-1": ["alt-1"] } },
    });
    expect(result.toUpload).toEqual([]);
    expect(result.skippedDifferentId).toHaveLength(1);
  });

  it("only treats a multi_chapters url as a duplicate for its declared numbers", () => {
    const result = decide({
      updatedChapters: [
        chapter({
          chapterId: "multi",
          chapterNumber: "99",
          chapterUrl: "https://pub.example/chapter/multi",
        }),
      ],
      chaptersOnMd: [mdChapter("md-10", { chapter: "7", externalUrl: "https://pub.example/chapter/multi" })],
      overrideOptions: { multi_chapters: { multi: ["7", "8"] } },
    });
    expect(result.toUpload).toHaveLength(1);
  });
});

describe("findDuplicateChapters", () => {
  it("keeps the oldest of each duplicate group", () => {
    const older = withCreatedAt(
      mdChapter("dup-old", { chapter: "1", externalUrl: "https://pub.example/c/1" }),
      "2024-01-01T00:00:00+00:00",
    );
    const newer = withCreatedAt(
      mdChapter("dup-new", { chapter: "1", externalUrl: "https://pub.example/c/1" }),
      "2025-01-01T00:00:00+00:00",
    );
    expect(findDuplicateChapters([newer, older], { groupId: "grp" }).map((c) => c.id)).toEqual([
      "dup-new",
    ]);
  });

  it("never treats other languages or other groups as duplicates", () => {
    const ours = mdChapter("dup-1", { chapter: "1", externalUrl: "https://pub.example/c/1" });
    const otherLanguage = mdChapter("dup-fr", {
      chapter: "1",
      translatedLanguage: "fr",
      externalUrl: "https://pub.example/c/1",
    });
    const otherGroup = mdChapter(
      "dup-other",
      { chapter: "1", externalUrl: "https://pub.example/c/1" },
      ["not-us"],
    );
    expect(findDuplicateChapters([ours, otherLanguage, otherGroup], { groupId: "grp" })).toEqual([]);
  });

  it("dedupes image chapters on volume and number", () => {
    const first = mdChapter("img-a", { chapter: "4", volume: "1" });
    const second = mdChapter("img-b", { chapter: "4", volume: "1" });
    expect(findDuplicateChapters([first, second], { groupId: "grp" }).map((c) => c.id)).toEqual([
      "img-b",
    ]);
  });

  /**
   * The regression this file exists to prevent from recurring. Marking a
   * chapter unavailable repoints its externalUrl at the publisher's manga page
   * rather than clearing it, so every carded chapter of a series carries the
   * SAME url. Keyed on url alone they are one duplicate group, and duplicates
   * are hard-deleted whatever the removal mode: the platform deleted its own
   * cards, one per run, for as long as any two existed.
   */
  it("never treats two of our own unavailable cards as duplicates", () => {
    const cardOne = withCreatedAt(
      mdChapter("card-1", {
        chapter: "1",
        externalUrl: "https://pub.example/manga/42",
        pages: 1,
      }),
      "2024-01-01T00:00:00+00:00",
    );
    const cardTwo = withCreatedAt(
      mdChapter("card-2", {
        chapter: "2",
        externalUrl: "https://pub.example/manga/42",
        pages: 1,
      }),
      "2025-01-01T00:00:00+00:00",
    );
    expect(findDuplicateChapters([cardOne, cardTwo], { groupId: "grp" })).toEqual([]);
  });

  it("still deletes a live duplicate of a chapter that also has a card", () => {
    const card = withCreatedAt(
      mdChapter("card-1", { chapter: "1", externalUrl: "https://pub.example/c/1", pages: 1 }),
      "2024-01-01T00:00:00+00:00",
    );
    const live = withCreatedAt(
      mdChapter("live-old", { chapter: "1", externalUrl: "https://pub.example/c/1" }),
      "2024-06-01T00:00:00+00:00",
    );
    const liveDupe = withCreatedAt(
      mdChapter("live-new", { chapter: "1", externalUrl: "https://pub.example/c/1" }),
      "2025-01-01T00:00:00+00:00",
    );
    expect(
      findDuplicateChapters([card, live, liveDupe], { groupId: "grp" }).map((c) => c.id),
    ).toEqual(["live-new"]);
  });
});

/**
 * What makes a clean run clean.
 *
 * An update run asks "what did the publisher flag as new?"; a clean run asks
 * "what does the publisher have?" and re-derives the whole answer from that.
 * The difference only shows on a chapter the extension does NOT flag — one that
 * was missed when it was new, or whose title drifted since — which is exactly
 * the chapter a clean run exists to catch and the one an update run never sees
 * again.
 */
describe("decideForManga on a clean run", () => {
  const onMd = (id: string, over: Partial<MdChapter["attributes"]> = {}) =>
    mdChapter(id, { chapter: "1", title: "T", externalUrl: "https://pub.example/c/1", ...over });

  const listed = (id: string, over: Partial<Chapter> = {}) =>
    chapter({
      chapterId: id,
      chapterNumber: id,
      chapterTitle: "T",
      chapterUrl: `https://pub.example/c/${id}`,
      ...over,
    });

  it("uploads a chapter the publisher lists that never reached MangaDex", () => {
    const result = decide({
      // The extension flagged nothing: this chapter is old news to it.
      updatedChapters: [],
      allMangaChapters: [listed("1"), listed("2")],
      chaptersOnMd: [onMd("md-1")],
      cleanDb: true,
    });

    expect(result.toUpload.map((c) => c.chapterId)).toEqual(["2"]);
    expect(result.missingWithoutPages).toEqual([]);
  });

  it("edits a chapter the extension never flagged as changed", () => {
    const result = decide({
      updatedChapters: [],
      allMangaChapters: [listed("1", { chapterTitle: "Corrected" })],
      chaptersOnMd: [onMd("md-1", { title: "Wrong" })],
      cleanDb: true,
    });

    expect(result.toEdit).toHaveLength(1);
    expect(result.toEdit[0]!.oldInfo.title).toBe("Wrong");
    expect(result.toEdit[0]!.payload.title).toBe("Corrected");
  });

  /**
   * The control. Same inputs, an update run: the listing is read for removal
   * detection and for nothing else, so the gap stays invisible. If this ever
   * starts uploading, clean and update have stopped being different runs.
   */
  it("is what separates a clean run from an update run", () => {
    const input = {
      updatedChapters: [],
      allMangaChapters: [listed("1"), listed("2")],
      chaptersOnMd: [onMd("md-1")],
    };
    expect(decide({ ...input, cleanDb: false }).toUpload).toEqual([]);
    expect(decide({ ...input, cleanDb: true }).toUpload).toHaveLength(1);
  });

  /**
   * A catalogue listing carries chapter metadata, never chapter images. For an
   * external-link extension that is a whole chapter; for an extension that
   * uploads pages it is not, and committing it would put a pageless chapter on
   * a public page. The gap is real either way, so it is reported rather than
   * dropped.
   */
  it("refuses to publish a listing entry when the extension deals in pages", () => {
    const result = decide({
      updatedChapters: [listed("1", { imageArtifacts: ["11111111-1111-4111-8111-111111111111"] })],
      allMangaChapters: [listed("1"), listed("2")],
      chaptersOnMd: [],
      cleanDb: true,
    });

    expect(result.toUpload.map((c) => c.chapterId)).toEqual(["1"]);
    expect(result.missingWithoutPages.map((c) => c.chapterId)).toEqual(["2"]);
  });

  it("publishes listing entries for an extension that only ever links out", () => {
    const result = decide({
      updatedChapters: [],
      allMangaChapters: [listed("1"), listed("2")],
      chaptersOnMd: [],
      cleanDb: true,
    });

    expect(result.toUpload.map((c) => c.chapterId)).toEqual(["1", "2"]);
    expect(result.missingWithoutPages).toEqual([]);
  });

  /**
   * The case the per-manga guess gets wrong, and the reason the signal is taken
   * over the whole run. This series reported nothing, so nothing about IT says
   * whether the extension fetches pages — and it is exactly the series a clean
   * run is asked about. Judged locally the answer would be "no pages, publish
   * away", which is how a pageless chapter reaches a public page.
   */
  it("trusts the run, not the manga, when a dormant series carries no evidence", () => {
    const result = decide({
      updatedChapters: [],
      allMangaChapters: [listed("1"), listed("2")],
      chaptersOnMd: [],
      cleanDb: true,
      extensionPublishesPages: true,
    });

    expect(result.toUpload).toEqual([]);
    expect(result.missingWithoutPages.map((c) => c.chapterId)).toEqual(["1", "2"]);
  });

  it("never publishes a listing entry with neither pages nor a link", () => {
    const result = decide({
      updatedChapters: [],
      allMangaChapters: [listed("1", { chapterUrl: null })],
      chaptersOnMd: [],
      cleanDb: true,
      extensionPublishesPages: false,
    });

    expect(result.toUpload).toEqual([]);
    expect(result.missingWithoutPages.map((c) => c.chapterId)).toEqual(["1"]);
  });

  it("keeps this run's fetched pages when a chapter is in both lists", () => {
    const withPages = listed("2", { imageArtifacts: ["22222222-2222-4222-8222-222222222222"] });
    const result = decide({
      updatedChapters: [withPages],
      allMangaChapters: [listed("1"), listed("2")],
      chaptersOnMd: [onMd("md-1")],
      cleanDb: true,
    });

    expect(result.toUpload.map((c) => c.chapterId)).toEqual(["2"]);
    expect(result.toUpload[0]!.imageArtifacts).toEqual([
      "22222222-2222-4222-8222-222222222222",
    ]);
  });
});
