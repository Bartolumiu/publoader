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

/** The MangaDex account these fixtures pretend publoader uploads as. */
const BOT = "74d95af1-7492-4fca-bc44-10c9142703e8";

const mdChapter = (
  id: string,
  attributes: Partial<MdChapter["attributes"]> = {},
  groups: string[] = ["grp"],
  uploader: string | null = BOT,
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
    // Present by default: every destructive pass now refuses to act on a
    // chapter it cannot show this account uploaded, so a fixture without an
    // uploader is testing the refusal rather than the behaviour under test.
    ...(uploader === null ? [] : [{ id: uploader, type: "user" }]),
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
    botUserId: BOT,
    ...over,
  });

describe("checkChapterUrlSame", () => {
  it("matches a chapter id against whole path components", () => {
    expect(checkChapterUrlSame("https://site.com/chapter/12345", "12345")).toBe(true);
    expect(checkChapterUrlSame("https://site.com/chapter/12345/page", "12345")).toBe(true);
    expect(checkChapterUrlSame("https://site.com/titles/9/chapters/12345", "9/12345")).toBe(true);
    expect(checkChapterUrlSame("https://site.com/chapter/12345", "99999")).toBe(false);
  });

  it("matches a namespaced chapter id against the bare url segment", () => {
    // The comikey shape: the id is "EPI-<token>", the url carries "<token>".
    expect(
      checkChapterUrlSame(
        "https://comikey.com/read/kengan-omega-manga/jDvJnD/chapter-0/?utm_source=mgd",
        "EPI-jDvJnD",
      ),
    ).toBe(true);
    // The token still has to be the one in the url.
    expect(
      checkChapterUrlSame("https://comikey.com/read/kengan-omega-manga/jDvJnD/chapter-0/", "EPI-kEvQXD"),
    ).toBe(false);
  });

  it("will not strip a prefix down to something short enough to be a word", () => {
    // "x-read" must not match the "read" every comikey url contains, or two
    // unrelated chapters become the same chapter.
    expect(checkChapterUrlSame("https://site.com/read/abc/1", "x-read")).toBe(false);
    expect(checkChapterUrlSame("https://site.com/read/abc/1", "EPI-abc")).toBe(false);
    // A prefix that is itself too long to be a namespace is left alone.
    expect(checkChapterUrlSame("https://site.com/c/token123", "averylongprefix-token123")).toBe(
      false,
    );
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

  it("matches a split-numbered series, where the aggregate holds no whole numbers", () => {
    // The comikey shape, and the case this was silently inert for: the aggregate
    // lists 1.1/1.2/1.3 and never a bare "1", so truncating only our side found
    // nothing and the whole catalogue uploaded with no volume.
    const split = {
      "1": {
        volume: "1",
        chapters: {
          "1.1": { chapter: "1.1", id: "a" },
          "1.2": { chapter: "1.2", id: "b" },
        },
      },
    };
    const chapters = [
      chapter({ chapterNumber: "1.1" }),
      // Not listed at all, but its integer part is.
      chapter({ chapterNumber: "1.7" }),
    ];
    backfillVolumes(chapters, split);
    expect(chapters.map((c) => c.chapterVolume)).toEqual(["1", "1"]);
  });

  it("prefers the exact number over the integer part when volumes straddle one", () => {
    // Volume 1 ends at 10, volume 2 opens with 10.5. "10" belongs to both by
    // integer part; only volume 1 actually lists it.
    const straddle = {
      "1": { volume: "1", chapters: { "10": { chapter: "10", id: "a" } } },
      "2": { volume: "2", chapters: { "10.5": { chapter: "10.5", id: "b" } } },
    };
    const chapters = [chapter({ chapterNumber: "10" }), chapter({ chapterNumber: "10.5" })];
    backfillVolumes(chapters, straddle);
    expect(chapters.map((c) => c.chapterVolume)).toEqual(["1", "2"]);
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

  it("never clears a MangaDex volume just because the publisher has none", () => {
    const withVolume = mdChapter("md-v", {
      chapter: "3",
      volume: "2",
      title: "Old",
      externalUrl: "https://pub.example/chapter/fff",
    });
    // Comikey and MANGA Plus both report no volume at all, so this is the
    // normal case, not an edge one.
    const noVolume = chapter({
      chapterId: "fff",
      chapterNumber: "3",
      chapterTitle: "New",
      chapterVolume: null,
      chapterUrl: "https://pub.example/chapter/fff",
    });

    const result = decide({ updatedChapters: [noVolume], chaptersOnMd: [withVolume] });
    expect(result.toEdit).toHaveLength(1);
    // The title change goes through; the volume is left alone.
    expect(result.toEdit[0]!.payload.title).toBe("New");
    expect(result.toEdit[0]!.payload.volume).toBe("2");
  });

  it("still writes a volume we do have", () => {
    const withVolume = mdChapter("md-v2", {
      chapter: "3",
      volume: "2",
      externalUrl: "https://pub.example/chapter/ggg",
    });
    const corrected = chapter({
      chapterId: "ggg",
      chapterNumber: "3",
      chapterVolume: "4",
      chapterUrl: "https://pub.example/chapter/ggg",
    });

    const result = decide({ updatedChapters: [corrected], chaptersOnMd: [withVolume] });
    expect(result.toEdit).toHaveLength(1);
    expect(result.toEdit[0]!.payload.volume).toBe("4");
  });

  it("can edit a chapter whose id is namespaced", () => {
    // buildEdit used a raw substring of the chapter id, which "EPI-jDvJnD"
    // never satisfies, so a comikey chapter recognised as a duplicate would
    // have been silently un-editable.
    const onMdComikey = mdChapter("md-ck", {
      chapter: "0",
      title: "Old",
      externalUrl: "https://comikey.com/read/kengan-omega-manga/jDvJnD/chapter-0/?utm_source=mgd",
    });
    const retitled = chapter({
      chapterId: "EPI-jDvJnD",
      chapterNumber: "0",
      chapterTitle: "Prologue",
      chapterUrl: "https://comikey.com/read/kengan-omega-manga/jDvJnD/chapter-0/",
    });

    const result = decide({ updatedChapters: [retitled], chaptersOnMd: [onMdComikey] });
    expect(result.toUpload).toEqual([]);
    expect(result.toEdit).toHaveLength(1);
    expect(result.toEdit[0]!.mdChapterId).toBe("md-ck");
    expect(result.toEdit[0]!.payload.title).toBe("Prologue");
  });

  it("does not renumber a sibling when one external chapter backs several numbers", () => {
    // The real case: MANGA Plus viewer 1019959 is Girl Meets Rock! chapters 1
    // to 4. Every one has the same externalUrl, so taking the first url match
    // renumbered chapter 2 to 1 and cleared its volume on 2026-08-26.
    const url = "https://mangaplus.shueisha.co.jp/viewer/1019959";
    const onMdTwo = mdChapter("md-two", { chapter: "2", volume: "1", externalUrl: url });
    const onMdThree = mdChapter("md-three", { chapter: "3", volume: "1", externalUrl: url });

    const parts = ["1", "2", "3", "4"].map((n) =>
      chapter({ chapterId: "1019959", chapterNumber: n, chapterUrl: url }),
    );

    const result = decide({
      updatedChapters: parts,
      chaptersOnMd: [onMdTwo, onMdThree],
    });

    // 2 and 3 are the ones already up; they are recognised as themselves.
    expect(result.skipped.map((c) => c.mdChapterId).sort()).toEqual(["md-three", "md-two"]);
    // 1 and 4 are siblings that are not on MangaDex yet, so they are uploaded
    // rather than written over 2 or 3.
    expect(result.toUpload.map((c) => c.chapterNumber).sort()).toEqual(["1", "4"]);
    // Nothing is renumbered.
    expect(result.toEdit).toEqual([]);
  });

  it("still edits a lone chapter whose number changed", () => {
    // Not a split id: one url, one MangaDex chapter, number corrected. This has
    // to keep working, which is why the fallback to the single url match stays.
    const renumbered = mdChapter("md-r", {
      chapter: "7",
      externalUrl: "https://pub.example/chapter/ddd",
    });
    const now = chapter({
      chapterId: "ddd",
      chapterNumber: "7.5",
      chapterUrl: "https://pub.example/chapter/ddd",
    });

    const result = decide({ updatedChapters: [now], chaptersOnMd: [renumbered] });
    expect(result.toUpload).toEqual([]);
    expect(result.toEdit).toHaveLength(1);
    expect(result.toEdit[0]!.mdChapterId).toBe("md-r");
    expect(result.toEdit[0]!.payload.chapter).toBe("7.5");
  });

  it("honours multi_chapters even when one run shows the id only once", () => {
    // A publisher whose split is not visible in a single run still needs the
    // override, so it is unioned with what the run shows.
    const url = "https://pub.example/chapter/eee";
    const onMdOne = mdChapter("md-o", { chapter: "1", externalUrl: url });
    const second = chapter({ chapterId: "eee", chapterNumber: "2", chapterUrl: url });

    const guarded = decide({
      updatedChapters: [second],
      chaptersOnMd: [onMdOne],
      overrideOptions: { multi_chapters: { eee: ["1", "2"] } },
    });
    expect(guarded.toUpload.map((c) => c.chapterNumber)).toEqual(["2"]);
    expect(guarded.toEdit).toEqual([]);
  });

  it("reports an upload onto a number our group already holds, without blocking it", () => {
    // The comikey shape: the extension id never matches the url, so the url
    // check says "new" and the chapter is uploaded onto a taken number.
    const already = mdChapter("md-old", {
      chapter: "1",
      title: "Prologue",
      externalUrl: "https://comikey.com/read/some-manga/jDvJnD/chapter-1/?utm_source=mgd",
    });
    const again = chapter({
      chapterId: "UNRELATED-token",
      chapterNumber: "1",
      chapterTitle: "Prologue",
      chapterUrl: "https://comikey.com/read/some-manga/other/chapter-1/",
    });

    const result = decide({ updatedChapters: [again], chaptersOnMd: [already] });

    // Still uploaded: the number is not the identity.
    expect(result.toUpload.map((c) => c.chapterId)).toEqual(["UNRELATED-token"]);
    expect(result.numberCollisions).toHaveLength(1);
    expect(result.numberCollisions[0]!.chapter.chapterId).toBe("UNRELATED-token");
    expect(result.numberCollisions[0]!.language).toBe("en");
    expect(result.numberCollisions[0]!.existing.map((c) => c.id)).toEqual(["md-old"]);
  });

  it("does not call a different language, or a chapter it matched by url, a collision", () => {
    const otherLanguage = mdChapter("md-es", {
      chapter: "2",
      translatedLanguage: "es",
      externalUrl: "https://pub.example/chapter/zzz",
    });

    // `fresh` is number 2 in en; the only chapter on that number is es.
    const result = decide({ updatedChapters: [fresh], chaptersOnMd: [otherLanguage] });
    expect(result.toUpload).toHaveLength(1);
    expect(result.numberCollisions).toEqual([]);

    // A chapter recognised by url is an edit or a skip, never an upload, so it
    // can never be a collision either.
    const matched = decide({ updatedChapters: [unchanged], chaptersOnMd: [onMdUnchanged] });
    expect(matched.numberCollisions).toEqual([]);
  });

  it("stamps the group onto skipped chapters, not only uploads", () => {
    // `recordUploaded` writes skipped chapters straight back to
    // uploaded_chapters and its upsert overwrites every column, so a chapter
    // that is merely recognised has to arrive complete. Leaving the group off
    // replaced a correct md_group_id with the null the extension reported it
    // with: 56 mangaup_global rows and 48 k_manga rows lost theirs that way.
    const result = decide({
      updatedChapters: [unchanged],
      chaptersOnMd: [onMdUnchanged],
    });

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.mdGroupId).toBe("grp");
    expect(result.skipped[0]!.mdMangaId).toBe("md-manga");
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
    expect(findDuplicateChapters([newer, older], { groupId: "grp", botUserId: BOT }).map((c) => c.id)).toEqual([
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
    expect(findDuplicateChapters([ours, otherLanguage, otherGroup], { groupId: "grp", botUserId: BOT })).toEqual([]);
  });

  it("dedupes image chapters on volume and number", () => {
    const first = mdChapter("img-a", { chapter: "4", volume: "1" });
    const second = mdChapter("img-b", { chapter: "4", volume: "1" });
    expect(findDuplicateChapters([first, second], { groupId: "grp", botUserId: BOT }).map((c) => c.id)).toEqual([
      "img-b",
    ]);
  });

  /**
   * A link naming only the publisher is not a chapter identity.
   *
   * Carding repoints externalUrl at the chapter, else the series, else the
   * publisher's bare domain. Chapters that fell through to that last one all
   * carry the same url while being different chapters, so keying duplicates on
   * it buckets them together and hard-deletes all but the oldest.
   *
   * A scan of 773 series found three "duplicates" and all three were this:
   * distinct RuriDragon chapters sharing `https://mangaplus.shueisha.co.jp/`.
   * Applying it would have deleted three live chapters.
   */
  it("does not treat a bare publisher domain as chapter identity", () => {
    const five = mdChapter("ruri-5", {
      chapter: "5",
      externalUrl: "https://mangaplus.shueisha.co.jp/",
    });
    const six = mdChapter("ruri-6", {
      chapter: "6",
      externalUrl: "https://mangaplus.shueisha.co.jp/",
    });
    expect(findDuplicateChapters([five, six], { groupId: "grp", botUserId: BOT })).toEqual([]);
  });

  it("still dedupes on a url that does name a chapter", () => {
    // The protection above must not cost the detection it exists to make safe:
    // a real link still buckets, which is also what `multi_chapters` relies on.
    const first = withCreatedAt(
      mdChapter("same-old", { chapter: "7", externalUrl: "https://pub.example/c/7" }),
      "2024-01-01T00:00:00+00:00",
    );
    const second = withCreatedAt(
      mdChapter("same-new", { chapter: "8", externalUrl: "https://pub.example/c/7" }),
      "2025-01-01T00:00:00+00:00",
    );
    expect(
      findDuplicateChapters([first, second], { groupId: "grp", botUserId: BOT }).map((c) => c.id),
    ).toEqual(["same-new"]);
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
    expect(findDuplicateChapters([cardOne, cardTwo], { groupId: "grp", botUserId: BOT })).toEqual([]);
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
      findDuplicateChapters([card, live, liveDupe], { groupId: "grp", botUserId: BOT }).map((c) => c.id),
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
