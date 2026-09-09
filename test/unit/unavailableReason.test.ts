import { describe, expect, it } from "vitest";
import { ChapterRecord } from "../../src/contracts/records.js";
import { ChapterInput } from "../../src/contracts/extensionApi.js";
import { unavailableCardOptions } from "../../src/core/md/unavailableCard.js";
import type { Chapter } from "../../src/core/md/types.js";

/**
 * An extension reporting WHY a chapter cannot be read, rather than dropping it.
 *
 * Dropping was the old behaviour, and from the platform's side it is
 * indistinguishable from the publisher having deleted the chapter: both produce
 * a chapter that is simply absent from the listing, so both get carded
 * "removed". That told readers a paid chapter was gone. 30k mangaup_global
 * chapters were in exactly that state.
 */
const base: Chapter = {
  chapterLookup: null,
  chapterTimestamp: null,
  chapterExpire: null,
  chapterLanguage: "en",
  chapterNumber: "12",
  chapterTitle: null,
  chapterVolume: null,
  chapterId: "c1",
  chapterUrl: "https://publisher.example/c/1",
  mdChapterId: null,
  mangaId: "m1",
  mdMangaId: null,
  mdGroupId: null,
  mangaName: "A Series",
  mangaUrl: null,
  extensionName: "ext",
  imageArtifacts: [],
};

describe("unavailableReason on the wire", () => {
  it("defaults to null, so an extension that never sets it is unchanged", () => {
    const parsed = ChapterInput.parse({
      chapterId: "c1",
      chapterUrl: "https://publisher.example/c/1",
      mangaId: "m1",
    });
    expect(parsed.unavailableReason).toBeNull();
    expect(parsed.subscriptionName).toBeNull();
  });

  it("carries a paid chapter and the tier that unlocks it", () => {
    const parsed = ChapterInput.parse({
      chapterId: "c1",
      chapterUrl: "https://publisher.example/c/1",
      mangaId: "m1",
      unavailableReason: "subscriber-only",
      subscriptionName: "MANGA Plus MAX",
    });
    expect(parsed.unavailableReason).toBe("subscriber-only");
    expect(parsed.subscriptionName).toBe("MANGA Plus MAX");
  });

  it("refuses a reason the card has no wording for", () => {
    // An unrecognised reason would fall through to "removed" downstream, which
    // is the untrue answer this whole field exists to stop.
    expect(() =>
      ChapterRecord.parse({ unavailableReason: "paywalled-ish" }),
    ).toThrow();
  });

  it("accepts every reason the card can render", () => {
    for (const reason of ["subscriber-only", "region-locked", "removed"]) {
      expect(ChapterRecord.parse({ unavailableReason: reason }).unavailableReason).toBe(reason);
    }
  });
});

describe("card options from a reason", () => {
  it("passes the reason and tier through to the card", () => {
    const opts = unavailableCardOptions({
      chapter: base,
      detail: null,
      reason: "subscriber-only",
      subscriptionName: "MANGA Plus MAX",
    });
    expect(opts.reason).toBe("subscriber-only");
    expect(opts.subscriptionName).toBe("MANGA Plus MAX");
  });

  it("still defaults to removed when nobody said otherwise", () => {
    const opts = unavailableCardOptions({ chapter: base, detail: null });
    expect(opts.reason).toBe("removed");
  });
});
