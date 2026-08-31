import { describe, expect, it } from "vitest";
import { parseMdTitleId } from "../../src/core/md/titleId.js";

/**
 * Reading a title id out of what an operator has in hand.
 *
 * The mapping surfaces all funnel through this, so the cases below are the
 * pastes that actually happen: a URL out of the address bar, a URL out of a
 * Discord message, a uuid copied with the quotes around it, and the near
 * misses that must be refused loudly rather than mapped onto the wrong title.
 */

const ID = "8f3e1a94-1234-4c56-89ab-0123456789ab";

describe("parseMdTitleId", () => {
  it("takes a bare uuid, in any case and with any amount of whitespace", () => {
    expect(parseMdTitleId(ID)).toEqual({ id: ID });
    expect(parseMdTitleId(`  ${ID.toUpperCase()}\n`)).toEqual({ id: ID });
  });

  it("takes a title link with the slug the browser adds", () => {
    expect(parseMdTitleId(`https://mangadex.org/title/${ID}/some-series-name`)).toEqual({ id: ID });
  });

  it("takes the link shapes a browser and an API hand back", () => {
    for (const value of [
      `https://mangadex.org/title/${ID}`,
      `http://mangadex.org/title/${ID}`,
      `https://www.mangadex.org/title/${ID}/`,
      `mangadex.org/title/${ID}`,
      `https://mangadex.org/title/${ID}?tab=chapters`,
      `https://mangadex.org/title/${ID}/slug#comments`,
      // Pre-2021 spelling; still what old bookmarks and some API links carry.
      `https://mangadex.org/manga/${ID}`,
      `https://api.mangadex.org/manga/${ID}`,
      `https://canary.mangadex.org/title/${ID}`,
    ]) {
      expect(parseMdTitleId(value), value).toEqual({ id: ID });
    }
  });

  it("unwraps the punctuation a paste drags along", () => {
    // <> is Discord's embed suppression, so it arrives on anything copied out
    // of a channel; the quotes come from copying out of JSON or prose.
    expect(parseMdTitleId(`<https://mangadex.org/title/${ID}>`)).toEqual({ id: ID });
    expect(parseMdTitleId(`"${ID}"`)).toEqual({ id: ID });
    expect(parseMdTitleId(`the title is https://mangadex.org/title/${ID}.`.split(" ").pop()!)).toEqual({ id: ID });
  });

  it("refuses a chapter link by name; it is a uuid on mangadex.org and would map cleanly onto nothing", () => {
    const result = parseMdTitleId(`https://mangadex.org/chapter/${ID}/1`);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("a chapter");
  });

  it("names the other MangaDex link kinds rather than saying invalid uuid", () => {
    expect(parseMdTitleId(`https://mangadex.org/group/${ID}`)).toEqual({
      error: expect.stringContaining("a scanlation group"),
    });
    expect(parseMdTitleId(`https://mangadex.org/list/${ID}`)).toEqual({
      error: expect.stringContaining("a custom list"),
    });
  });

  it("refuses a legacy numeric id, and says where the new one is", () => {
    const result = parseMdTitleId("https://mangadex.org/title/47190/solo-leveling");
    expect((result as { error: string }).error).toContain("pre-2021");
  });

  it("refuses a publisher link, which is the paste that would map to the wrong thing", () => {
    const result = parseMdTitleId("https://comikey.com/read/some-series/");
    expect((result as { error: string }).error).toContain("comikey.com is not MangaDex");
  });

  it("refuses a truncated uuid instead of accepting a prefix", () => {
    expect(parseMdTitleId(ID.slice(0, 30))).toHaveProperty("error");
  });

  it("refuses non-strings and blanks", () => {
    expect(parseMdTitleId(null)).toHaveProperty("error");
    expect(parseMdTitleId("   ")).toHaveProperty("error");
  });
});
