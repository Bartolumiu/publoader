import { describe, expect, it } from "vitest";
import { buildChapterCardSvg, type ChapterCardOptions } from "../../src/core/md/card.js";
import { measureText, missingGlyphs, assertRenderable } from "../../src/core/md/fonts.js";

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

describe("font coverage", () => {
  it("covers the scripts the catalogue actually publishes in", () => {
    for (const sample of ["Black Clover", "Последняя страница", "黒の召喚士"]) {
      expect(missingGlyphs(sample)).toEqual([]);
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
