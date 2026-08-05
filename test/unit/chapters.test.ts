import { describe, expect, it } from "vitest";
import {
  CHAPTER_ARCHIVES,
  decodeChapterCursor,
  encodeChapterCursor,
  isChapterArchive,
} from "../../src/core/store/chapters.js";
import { unavailableCardOptions, resolveMangaName } from "../../src/core/md/unavailableCard.js";
import type { MdChapterDetail } from "../../src/core/md/client.js";
import type { Chapter } from "../../src/core/md/types.js";

/**
 * The two pure pieces of the chapter views: the keyset cursor the listing pages
 * with, and the derivation of what goes on an unavailable card.
 *
 * The card derivation is worth unit-testing precisely because two callers share
 * it — the uploader that posts the image and the endpoint that previews it. If
 * they ever disagreed, an operator would approve one card and publish another,
 * and nobody would find out except a reader.
 */

const chapter: Chapter = {
  chapterLookup: null,
  chapterTimestamp: "2026-01-02T00:00:00.000Z",
  chapterExpire: "2026-02-02T00:00:00.000Z",
  chapterLanguage: "en",
  chapterNumber: "12",
  chapterTitle: "Stored title",
  chapterVolume: "2",
  chapterId: "src-12",
  chapterUrl: "https://publisher.example/ch/12",
  mdChapterId: "11111111-1111-4111-8111-111111111111",
  mangaId: "src-manga",
  mdMangaId: "22222222-2222-4222-8222-222222222222",
  mdGroupId: "33333333-3333-4333-8333-333333333333",
  mangaName: "Stored Series",
  mangaUrl: "https://publisher.example/series",
  extensionName: "exampleext",
  imageArtifacts: [],
};

const detail = (
  attrs: Partial<MdChapterDetail["attributes"]> = {},
  relationships: MdChapterDetail["relationships"] = [],
): MdChapterDetail => ({
  id: chapter.mdChapterId!,
  attributes: {
    volume: "3",
    chapter: "12.5",
    title: "Live title",
    translatedLanguage: "ja",
    externalUrl: "https://publisher.example/live",
    version: 4,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...attrs,
  },
  relationships,
});

describe("chapter cursors", () => {
  it("round-trips a position", () => {
    const at = new Date("2026-05-05T10:11:12.000Z");
    const id = "44444444-4444-4444-8444-444444444444";
    const decoded = decodeChapterCursor(encodeChapterCursor({ at, id }));
    expect(decoded?.at.toISOString()).toBe(at.toISOString());
    expect(decoded?.id).toBe(id);
  });

  it("refuses anything it did not issue", () => {
    // A caller that invents a cursor gets a 400 from the route, not a page of
    // rows from a date it guessed — which is what makes "this is not an offset"
    // enforceable rather than merely documented.
    expect(decodeChapterCursor("not-base64")).toBeNull();
    expect(decodeChapterCursor(Buffer.from("only-one-part").toString("base64url"))).toBeNull();
    expect(decodeChapterCursor(Buffer.from("nonsense|not-a-uuid").toString("base64url"))).toBeNull();
    expect(
      decodeChapterCursor(
        Buffer.from("2026-05-05T10:11:12.000Z|44444444-4444-4444-8444-444444444444").toString("base64url"),
      ),
    ).not.toBeNull();
  });

  it("names exactly the four chapter tables", () => {
    expect([...CHAPTER_ARCHIVES]).toEqual(["uploaded", "unavailable", "deleted", "edited"]);
    expect(isChapterArchive("uploaded")).toBe(true);
    expect(isChapterArchive("upload_tasks")).toBe(false);
  });
});

describe("unavailableCardOptions", () => {
  it("prefers what MangaDex holds over the stored mirror", () => {
    const opts = unavailableCardOptions({ chapter, detail: detail(), unavailableAt: null });
    expect(opts.chapterNumber).toBe("12.5");
    expect(opts.chapterTitle).toBe("Live title");
    expect(opts.chapterLanguage).toBe("ja");
    expect(opts.chapterUrl).toBe("https://publisher.example/live");
    // The extension never appears on the MangaDex resource, so it always comes
    // from our row.
    expect(opts.extensionName).toBe("exampleext");
  });

  it("falls back to the row when MangaDex could not be read", () => {
    const opts = unavailableCardOptions({ chapter, detail: null, unavailableAt: null });
    expect(opts.chapterNumber).toBe("12");
    expect(opts.chapterTitle).toBe("Stored title");
    expect(opts.chapterUrl).toBe("https://publisher.example/ch/12");
    expect(opts.mangaName).toBe("Stored Series");
  });

  it("dates the availability window from the takedown, else the source expiry", () => {
    expect(
      unavailableCardOptions({ chapter, detail: null, unavailableAt: "2026-03-03T00:00:00.000Z" })
        .availableTo,
    ).toBe("2026-03-03T00:00:00.000Z");
    expect(unavailableCardOptions({ chapter, detail: null }).availableTo).toBe(chapter.chapterExpire);
    expect(unavailableCardOptions({ chapter, detail: null }).availableFrom).toBe(chapter.chapterTimestamp);
  });

  it("carries an operator's footer note", () => {
    const note = "Removed at the publisher's request.";
    expect(unavailableCardOptions({ chapter, detail: null, footerNote: note }).footerNote).toBe(note);
    // Null rather than undefined, so the card's own default wording applies.
    expect(unavailableCardOptions({ chapter, detail: null }).footerNote).toBeNull();
  });
});

describe("resolveMangaName", () => {
  const manga = (attributes: Record<string, unknown>) => [
    { id: chapter.mdMangaId!, type: "manga", attributes },
  ];

  it("prefers the English title from the manga relationship", () => {
    const live = detail({}, manga({ title: { en: "Live Series" }, altTitles: [] }));
    expect(resolveMangaName(live, chapter)).toBe("Live Series");
  });

  it("falls back to the romanised original before any other language", () => {
    const live = detail(
      {},
      manga({
        title: { ja: "日本語タイトル" },
        altTitles: [{ "ja-ro": "Nihongo Taitoru" }, { fr: "Titre" }],
        originalLanguage: "ja",
      }),
    );
    expect(resolveMangaName(live, chapter)).toBe("Nihongo Taitoru");
  });

  it("uses the stored name when MangaDex offers nothing", () => {
    expect(resolveMangaName(detail(), chapter)).toBe("Stored Series");
    expect(resolveMangaName(null, chapter)).toBe("Stored Series");
    expect(resolveMangaName(null, { ...chapter, mangaName: null })).toBe("Untitled");
  });
});
