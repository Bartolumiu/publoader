import { describe, expect, it } from "vitest";
import { linkIdentity } from "../../src/core/processor/dedupe.js";

describe("linkIdentity", () => {
  it("treats a link and the same link with utm_source as one link", () => {
    // The regression. Comikey's own uploads carry ?utm_source=mgd and ours do
    // not; 154 pairs of the same chapter keyed apart on those fifteen
    // characters and the duplicate scan reported none of them.
    expect(linkIdentity("https://comikey.com/read/girl-crush-manga/DvJlXD/chapter-1/?utm_source=mgd")).toBe(
      linkIdentity("https://comikey.com/read/girl-crush-manga/DvJlXD/chapter-1/"),
    );
  });

  it("drops every utm_ parameter, not only utm_source", () => {
    expect(
      linkIdentity("https://example.com/c/1?utm_source=a&utm_medium=b&utm_campaign=c&utm_id=d"),
    ).toBe("https://example.com/c/1");
  });

  it("keeps a parameter the publisher might actually need", () => {
    // The reason this strips tracking rather than the whole query: a page or a
    // language in there distinguishes two real chapters, and collapsing them
    // into one bucket ends in deleting one of them.
    expect(linkIdentity("https://example.com/c?page=2&utm_source=x")).toBe(
      "https://example.com/c?page=2",
    );
    expect(linkIdentity("https://example.com/c?lang=es")).not.toBe("https://example.com/c");
  });

  it("leaves a bare ? behind when the query empties out", () => {
    // Without this the normalised form still differs by one character.
    expect(linkIdentity("https://example.com/c/1/?utm_source=x")).not.toContain("?");
  });

  it("does not confuse two different chapters", () => {
    expect(linkIdentity("https://comikey.com/read/x/AAA/chapter-1/")).not.toBe(
      linkIdentity("https://comikey.com/read/x/BBB/chapter-2/"),
    );
  });

  it("passes an unparseable link through untouched", () => {
    expect(linkIdentity("not a url")).toBe("not a url");
  });

  it("ignores the fragment", () => {
    expect(linkIdentity("https://example.com/c/1#page-3")).toBe("https://example.com/c/1");
  });
});
