import { describe, expect, it } from "vitest";
import { buildChapterCardSvg, type ChapterCardOptions } from "../../src/core/md/card.js";
import { measureText, missingGlyphs, assertRenderable } from "../../src/core/md/fonts.js";
import { unavailableCardOptions } from "../../src/core/md/unavailableCard.js";

const base = (over: Partial<ChapterCardOptions> = {}): ChapterCardOptions => ({
  mangaName: "Black Clover",
  chapterNumber: "392",
  chapterTitle: "A Chapter Title",
  extensionName: "mangaplus",
  chapterLanguage: "en",
  chapterUrl: "https://mangaplus.shueisha.co.jp/viewer/6001549",
  availableFrom: "2024-01-15T00:00:00Z",
  availableTo: null,
  ...over,
});

/** Every `x`/`width` the SVG paints, for checking nothing leaves the canvas. */
function extents(svg: string): { maxX: number } {
  let maxX = 0;
  for (const match of svg.matchAll(/x="(-?[\d.]+)"/g)) {
    maxX = Math.max(maxX, Number(match[1]));
  }
  return { maxX };
}

/**
 * The card's text as one string.
 *
 * Wrapped copy is emitted as one `<text>` per line, so asserting on a sentence
 * against the raw SVG fails wherever the wrap happens to fall — a property of
 * the line breaking, not of the wording.
 */
function plainText(svg: string): string {
  return [...svg.matchAll(/>([^<>]+)</g)].map((m) => m[1]).join(" ");
}

describe("chapter card", () => {
  it("keeps a long series title whole instead of ellipsising it", () => {
    const svg = buildChapterCardSvg(
      base({ mangaName: "The Plain Salary Man Turned Out to Be the Strongest" }),
    );
    // The defect this replaced rendered "...Turned Out to..". Every word must
    // survive, which is the whole point of shrinking the type to fit.
    for (const word of ["Plain", "Salary", "Turned", "Strongest"]) {
      expect(svg).toContain(word);
    }
    expect(svg).not.toContain("…");
  });

  it("wraps a Cyrillic chapter title inside the content box", () => {
    const title = "Последняя страница: Не сдаваться до конца";
    const svg = buildChapterCardSvg(base({ chapterTitle: title, chapterLanguage: "ru" }));

    // Pull the drawn lines back out and measure them the way layout did. The
    // old Helvetica table assumed 0.556em for every Cyrillic letter, so lines
    // measured as fitting and then ran off the page.
    const lines = [...svg.matchAll(/>([^<]*[А-Яа-я][^<]*)</g)].map((m) => m[1] ?? "");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(measureText(line, 44)).toBeLessThanOrEqual(824);
    }
  });

  it("never paints outside the 1000-unit canvas", () => {
    const svg = buildChapterCardSvg(base({ chapterNumber: "1188" }));
    expect(extents(svg).maxX).toBeLessThanOrEqual(1000);
  });

  it("no longer stamps the publoader mark on the footer", () => {
    expect(buildChapterCardSvg(base())).not.toContain("publoader");
  });

  it("keeps the removed-chapter wording for extensions with no subscription", () => {
    const copy = plainText(buildChapterCardSvg(base()));
    expect(copy).toContain("has since been removed");
    expect(copy).not.toContain("subscription");
  });

  it("explains a subscriber-only chapter and names the tier", () => {
    const copy = plainText(
      buildChapterCardSvg(base({ reason: "subscriber-only", subscriptionName: "MANGA Plus MAX" })),
    );
    expect(copy).toContain("MANGA Plus MAX");
    expect(copy).toContain("no longer free to read");
    // Saying it was "removed" would be untrue: it is still published.
    expect(copy).not.toContain("has since been removed");
  });

  it("drops the open-ended availability row when the chapter is still published", () => {
    const paywalled = buildChapterCardSvg(
      base({ reason: "subscriber-only", subscriptionName: "MANGA Plus MAX" }),
    );
    // "AVAILABLE 2019 -> now" under a note saying it is not free contradicts
    // itself, and the row is the more believable half.
    expect(paywalled).not.toContain("AVAILABLE");
    expect(buildChapterCardSvg(base())).toContain("AVAILABLE");
  });
});

describe("card source url on a re-card", () => {
  const row = {
    chapterUrl: "https://mangaplus.shueisha.co.jp/viewer/1018557",
    mangaUrl: "https://mangaplus.shueisha.co.jp/titles/100246",
    chapterNumber: "42",
    chapterTitle: "A chapter",
    chapterLanguage: "en",
    extensionName: "mangaplus",
    chapterTimestamp: null,
    chapterExpire: null,
  } as unknown as Parameters<typeof unavailableCardOptions>[0]["chapter"];

  /** A chapter that has ALREADY been carded: its externalUrl was repointed. */
  const carded = {
    attributes: {
      chapter: "42",
      title: "A chapter",
      translatedLanguage: "en",
      // The series page, written by the previous carding — not the chapter.
      externalUrl: "https://mangaplus.shueisha.co.jp/titles/100246",
      pages: 1,
      version: 2,
    },
    relationships: [],
  } as unknown as Parameters<typeof unavailableCardOptions>[0]["detail"];

  it("keeps the original chapter link as the card's source", () => {
    // Carding repoints externalUrl, so on a re-card MangaDex's value is the
    // replacement. Preferring it would print the series page under SOURCE and
    // lose where the chapter actually was — permanently, and again on every
    // subsequent re-card.
    const options = unavailableCardOptions({ chapter: row, detail: carded });
    expect(options.chapterUrl).toBe("https://mangaplus.shueisha.co.jp/viewer/1018557");
  });

  it("falls back to MangaDex only when the row never had a chapter url", () => {
    const options = unavailableCardOptions({
      chapter: { ...row, chapterUrl: null } as typeof row,
      detail: carded,
    });
    expect(options.chapterUrl).toBe("https://mangaplus.shueisha.co.jp/titles/100246");
  });
});

describe("font coverage", () => {
  it("covers what the vendored fonts ship, on any host", () => {
    // Latin and its punctuation come from the faces vendored in assets/fonts,
    // so this holds regardless of what the machine has installed.
    expect(missingGlyphs("Black Clover — Vol. 1 (2024)")).toEqual([]);
  });

  it("either renders a script or refuses to, but never draws boxes", () => {
    // Coverage for CJK, Cyrillic and Thai comes from system fonts, so it is a
    // property of the host: the runtime image installs the Noto families, a CI
    // runner generally has no CJK font at all. Both are fine. What must never
    // happen is the third outcome -- reporting full coverage and then drawing
    // tofu -- so assert the contract rather than the machine.
    //
    // The first version of this test asserted coverage directly and passed on a
    // developer Mac (which ships Arial Unicode MS) while failing CI, which is
    // exactly the environment-dependent assertion it was meant to catch in the
    // renderer.
    for (const sample of ["黒の召喚士", "Последняя страница", "ไทย"]) {
      if (missingGlyphs(sample).length === 0) {
        expect(() => assertRenderable([sample])).not.toThrow();
      } else {
        expect(() => assertRenderable([sample])).toThrow(/unrenderable/i);
      }
    }
  });

  it("refuses to render text no installed font can draw", () => {
    // U+0378 is permanently unassigned in Unicode, so no font has a glyph for
    // it. A private-use code point is the wrong probe: plenty of fonts map that
    // range for logos and icons, and a last-resort font maps all of it. This
    // stands in for the tofu case that previously uploaded boxes to MangaDex.
    const unassigned = String.fromCodePoint(0x0378);
    expect(() => assertRenderable([unassigned])).toThrow(/unrenderable/i);
  });

  it("measures CJK as wider than Latin of the same length", () => {
    // The old estimator called both 0.556em, which is what under-measured
    // Japanese titles and pushed them past the edge of the card.
    expect(measureText("黒の召喚士", 44)).toBeGreaterThan(measureText("abcde", 44));
  });
});
