import { describe, expect, it } from "vitest";
import { linkEvidence } from "../../src/core/md/titleService.js";

/**
 * Where a MangaDex entry may name a publisher's page, and what still does not
 * count as naming it.
 *
 * Publishers' pages are recorded inconsistently: an entry may put the page in
 * the official-English link field, in another `links` slot, or only in prose
 * ("Official English release: <url>"). All three are the catalogue saying "this
 * series is that page", and the auto-map read only the first — so it missed
 * matches whose evidence was already in the search response it had paid for.
 *
 * Widening WHERE it looks must not widen WHAT counts. The comparison is the
 * same in every case: host and path, so `www.`, a trailing slash and a deep
 * link into the series all read as the series, while another series on the same
 * host does not.
 */

const SERIES = "https://comikey.com/comics/kengan-omega";

const entry = (attributes: Record<string, unknown>) =>
  ({ attributes } as Parameters<typeof linkEvidence>[0]);

describe("where an entry names a series' own page", () => {
  it("reads the official English link, the strongest of the three", () => {
    expect(linkEvidence(entry({ links: { engtl: SERIES } }), SERIES)).toBe("engtl");
  });

  it("reads any other link field", () => {
    // The same claim in a less specific slot. Nothing about the url is weaker
    // for being filed under `raw`.
    expect(linkEvidence(entry({ links: { raw: SERIES } }), SERIES)).toBe("links");
    expect(linkEvidence(entry({ links: { amz: "https://amazon.example/x", bw: SERIES } }), SERIES)).toBe(
      "links",
    );
  });

  it("reads the url out of a description", () => {
    expect(
      linkEvidence(
        entry({ description: { en: `Official English release: ${SERIES}` } }),
        SERIES,
      ),
    ).toBe("description");
  });

  it("prefers the strongest evidence an entry offers", () => {
    // An entry with the page in `links.engtl` AND in its description is an
    // official-link match; recording it as a description match would understate
    // what is known about it.
    const both = entry({ links: { engtl: SERIES }, description: { en: SERIES } });
    expect(linkEvidence(both, SERIES)).toBe("engtl");

    const linkAndProse = entry({ links: { raw: SERIES }, description: { en: SERIES } });
    expect(linkEvidence(linkAndProse, SERIES)).toBe("links");
  });

  it("finds a url wrapped in markdown, brackets or a sentence", () => {
    // Descriptions are prose: the url arrives inside a link, in angle brackets,
    // or ending a sentence, and a trailing full stop must not fail the match.
    for (const text of [
      `[Read it here](${SERIES})`,
      `<${SERIES}>`,
      `Read it at ${SERIES}.`,
      `Official: ${SERIES}, weekly.`,
      `See ${SERIES};`,
    ]) {
      expect(linkEvidence(entry({ description: { en: text } }), SERIES), text).toBe("description");
    }
  });

  it("searches every language's description, not only English", () => {
    expect(linkEvidence(entry({ description: { pt_br: SERIES } }), SERIES)).toBe("description");
  });

  it("ignores http/https, www. and a trailing slash", () => {
    expect(linkEvidence(entry({ links: { engtl: "http://www.comikey.com/comics/kengan-omega/" } }), SERIES)).toBe(
      "engtl",
    );
  });

  it("counts a deep link into the series as the series", () => {
    expect(
      linkEvidence(entry({ links: { engtl: `${SERIES}/chapter-1` } }), SERIES),
    ).toBe("engtl");
  });
});

describe("what still does not count as naming it", () => {
  it("refuses a different series on the same host, in a link field", () => {
    expect(linkEvidence(entry({ links: { engtl: "https://comikey.com/comics/other" } }), SERIES)).toBeNull();
  });

  it("refuses a different series on the same host, in a description", () => {
    // The whole risk of reading prose: a description that links the
    // publisher's OTHER series must not map this one.
    expect(
      linkEvidence(
        entry({ description: { en: `Also read https://comikey.com/comics/something-else` } }),
        SERIES,
      ),
    ).toBeNull();
  });

  it("does not match a longer id that merely starts the same way", () => {
    // The segment boundary: /titles/1002 is not /titles/10028.
    const short = "https://mangaplus.shueisha.co.jp/titles/1002";
    expect(
      linkEvidence(entry({ links: { engtl: "https://mangaplus.shueisha.co.jp/titles/10028" } }), short),
    ).toBeNull();
  });

  it("says nothing about an entry that carries no links and no description", () => {
    expect(linkEvidence(entry({}), SERIES)).toBeNull();
    expect(linkEvidence(entry({ links: null, description: null }), SERIES)).toBeNull();
  });

  it("refuses to match on an unreadable series url", () => {
    expect(linkEvidence(entry({ links: { engtl: SERIES } }), "not a url")).toBeNull();
  });
});
