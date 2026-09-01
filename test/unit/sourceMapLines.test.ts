import { describe, expect, it } from "vitest";
import { parseSourceMapLines } from "../../src/core/store/sourceLinks.js";

/**
 * Reading a paste of `<publisher link> <mangadex link>` pairs.
 *
 * The shape this has to survive is a paste assembled by copying browser tabs in
 * whatever order they were opened, which is why neither column is fixed: the
 * MangaDex value is identified by being one, and whatever else is on the line is
 * the publisher's page. Every rejection below is a line that would otherwise map
 * a series onto the wrong thing or onto nothing.
 */

const ID_A = "8f3e1a94-1234-4c56-89ab-0123456789ab";
const ID_B = "1c2d3e4f-5678-4901-8abc-def012345678";
const SOURCE_A = "https://comikey.com/comics/kengan-omega";
const SOURCE_B = "https://mangaplus.shueisha.co.jp/titles/100001";

describe("parseSourceMapLines", () => {
  it("reads a pair per line, in either order and with either separator", () => {
    const { rows, errors } = parseSourceMapLines(
      [
        `${SOURCE_A} https://mangadex.org/title/${ID_A}/kengan-omega`,
        // MangaDex first: the tab that was open first is the one copied first.
        `${ID_B},${SOURCE_B}`,
      ].join("\n"),
    );
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { line: 1, sourceUrl: SOURCE_A, mdMangaId: ID_A },
      { line: 2, sourceUrl: SOURCE_B, mdMangaId: ID_B },
    ]);
  });

  it("keeps the comment, blank-line and header conventions of the other paste boxes", () => {
    const { rows, errors } = parseSourceMapLines(
      [
        "source,mangadex",
        "",
        `${SOURCE_A} ${ID_A}   # the first one`,
        "   ",
      ].join("\n"),
    );
    expect(errors).toEqual([]);
    expect(rows).toEqual([{ line: 3, sourceUrl: SOURCE_A, mdMangaId: ID_A }]);
  });

  it("reports the line number, so a two-hundred-line paste can be corrected", () => {
    const { rows, errors } = parseSourceMapLines(
      [`${SOURCE_A} ${ID_A}`, "just-one-value", `${SOURCE_B} ${ID_B}`].join("\n"),
    );
    expect(rows).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.line).toBe(2);
  });

  it("names a chapter link rather than treating it as the publisher's page", () => {
    // Both values are urls here, so the only thing separating them is that one
    // is a MangaDex TITLE. A chapter link is neither, and calling it the source
    // would send it to the resolver to fail for an unrelated reason.
    const { rows, errors } = parseSourceMapLines(`${SOURCE_A} https://mangadex.org/chapter/${ID_A}`);
    expect(rows).toEqual([]);
    expect(errors[0]!.reason).toContain("a chapter");
  });

  it("refuses a line with no publisher link", () => {
    const { rows, errors } = parseSourceMapLines(`${ID_A}`);
    expect(rows).toEqual([]);
    expect(errors[0]!.reason).toContain("no publisher link");
  });

  it("refuses a line whose other value is not a link at all", () => {
    const { rows, errors } = parseSourceMapLines(`kengan-omega ${ID_A}`);
    expect(rows).toEqual([]);
    expect(errors[0]!.reason).toContain("not an http(s) link");
  });

  it("refuses a third value rather than guessing which two were meant", () => {
    const { errors } = parseSourceMapLines(`${SOURCE_A} ${SOURCE_B} ${ID_A}`);
    expect(errors[0]!.reason).toContain("expected two values");
  });

  it("takes an empty paste as nothing to do, not as an error", () => {
    expect(parseSourceMapLines("")).toEqual({ rows: [], errors: [] });
    expect(parseSourceMapLines("\n\n  \n")).toEqual({ rows: [], errors: [] });
  });
});
