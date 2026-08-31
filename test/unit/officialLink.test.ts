import { describe, expect, it } from "vitest";
import { normaliseOfficialLink } from "../../src/core/md/officialLink.js";

/**
 * The comparison the auto-map pass rests on.
 *
 * Every one of these differences was seen on the live catalogue: MangaDex
 * editors and publishers record the same page with and without the trailing
 * slash, with and without `www.`, and on either scheme. Treating those as
 * different urls throws away most real matches; treating genuinely different
 * paths as the same maps chapters onto someone else's title. So this function
 * has to be exactly as loose as that list and no looser.
 */
describe("normaliseOfficialLink", () => {
  const same = (a: string, b: string) =>
    expect(normaliseOfficialLink(a)).toBe(normaliseOfficialLink(b));

  it("ignores a trailing slash", () => {
    same("https://comikey.com/comics/kengan-omega-manga/10/", "https://comikey.com/comics/kengan-omega-manga/10");
  });

  it("ignores repeated trailing slashes", () => {
    same("https://example.com/series/1///", "https://example.com/series/1");
  });

  it("ignores www. and the scheme", () => {
    same("http://www.omoi.com/series/10-dance", "https://omoi.com/series/10-dance");
  });

  it("ignores host case", () => {
    same("https://Example.COM/series/1", "https://example.com/series/1");
  });

  it("ignores a fragment, which never identifies a series", () => {
    same("https://example.com/series/1#chapter-3", "https://example.com/series/1");
  });

  it("keeps the path exactly, so a different series is a different link", () => {
    // The near-miss that matters: same site, different title id.
    expect(normaliseOfficialLink("https://kmanga.kodansha.com/title/10001")).not.toBe(
      normaliseOfficialLink("https://kmanga.kodansha.com/title/10002"),
    );
  });

  it("keeps path case, which some sources use to identify a series", () => {
    expect(normaliseOfficialLink("https://example.com/Series/A")).not.toBe(
      normaliseOfficialLink("https://example.com/series/a"),
    );
  });

  it("keeps the query string", () => {
    expect(normaliseOfficialLink("https://example.com/read?id=7")).not.toBe(
      normaliseOfficialLink("https://example.com/read?id=8"),
    );
  });

  it("rejects anything that is not an http(s) url", () => {
    // Two unparseable links must never compare equal to each other.
    for (const bad of ["", "   ", "not a url", "javascript:alert(1)", "ftp://example.com/x"]) {
      expect(normaliseOfficialLink(bad), bad).toBeNull();
    }
    expect(normaliseOfficialLink(null)).toBeNull();
    expect(normaliseOfficialLink(undefined)).toBeNull();
  });

  it("trims surrounding whitespace rather than failing on it", () => {
    same("  https://example.com/series/1  ", "https://example.com/series/1");
  });
});
