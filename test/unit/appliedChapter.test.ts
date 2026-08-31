import { describe, expect, it } from "vitest";
import { appliedChapter } from "../../src/core/md/taskWorkers.js";
import type { Chapter } from "../../src/core/md/types.js";

const chapter = (over: Partial<Chapter> = {}): Chapter => ({
  chapterLookup: null,
  chapterTimestamp: null,
  chapterExpire: null,
  chapterLanguage: "en",
  chapterNumber: "10",
  chapterTitle: null,
  chapterVolume: null,
  chapterId: "c10",
  chapterUrl: "https://pub.example/c10",
  mdChapterId: "md-10",
  mangaId: "ext-manga",
  mdMangaId: "md-manga",
  mdGroupId: "grp",
  mangaName: "A series",
  mangaUrl: null,
  extensionName: "ext",
  imageArtifacts: [],
  ...over,
});

describe("appliedChapter", () => {
  it("mirrors the volume the edit actually sent, not the extension's null", () => {
    // The case this exists for: the volume was backfilled from the MangaDex
    // aggregate into the payload, while the extension chapter still says null.
    // Mirroring the chapter wrote that null into uploaded_chapters, so the same
    // chapter looked volume-less forever and every sweep re-queued the edit.
    const applied = appliedChapter(chapter({ chapterVolume: null }), {
      volume: "3",
      chapter: "10",
      title: null,
      translatedLanguage: "en",
      groups: ["grp"],
      version: 4,
    });

    expect(applied.chapterVolume).toBe("3");
    expect(applied.chapterNumber).toBe("10");
  });

  it("carries a renumber and a retitle through as well", () => {
    const applied = appliedChapter(chapter({ chapterNumber: "10", chapterTitle: "Old" }), {
      volume: null,
      chapter: "10.5",
      title: "New",
      translatedLanguage: "es",
    });

    expect(applied.chapterNumber).toBe("10.5");
    expect(applied.chapterTitle).toBe("New");
    expect(applied.chapterLanguage).toBe("es");
    // A body that genuinely clears the volume still clears it.
    expect(applied.chapterVolume).toBeNull();
  });

  it("keeps every field the edit does not describe", () => {
    const original = chapter({ chapterVolume: null });
    const applied = appliedChapter(original, {
      volume: "1",
      chapter: "10",
      title: null,
      translatedLanguage: "en",
    });

    expect(applied.chapterId).toBe(original.chapterId);
    expect(applied.chapterUrl).toBe(original.chapterUrl);
    expect(applied.mdChapterId).toBe(original.mdChapterId);
    expect(applied.mangaName).toBe(original.mangaName);
    // And the input is not mutated.
    expect(original.chapterVolume).toBeNull();
  });

  it("falls back to the chapter's language when the body omits it", () => {
    const applied = appliedChapter(chapter({ chapterLanguage: "pt-br" }), { volume: "2" });
    expect(applied.chapterLanguage).toBe("pt-br");
  });
});
