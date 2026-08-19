import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MdClient } from "../../src/core/md/client.js";
import { isCarded } from "../../src/core/md/types.js";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";

/**
 * `MdClient.toChapter` rebuilds a MangaDex chapter into the shape the pipeline
 * codes against, and a field it forgets is a field no consumer can ever see.
 *
 * It forgot `pages`, and `pages` is the only thing that distinguishes a chapter
 * carrying one of our unavailable cards from a live external one: marking a
 * chapter unavailable REPOINTS its externalUrl at the publisher's manga page
 * rather than clearing it. Blind to the page count, duplicate detection keyed
 * every card of a series on that one shared url, called them duplicates of each
 * other, and hard-deleted all but the oldest — on every run, whatever the
 * removal mode said. The catalogue lost the cards the platform had just posted.
 *
 * So this asserts the round trip, not the mapper: a chapter goes in over the
 * wire and comes back out still answering `isCarded`.
 */
describe("MdClient chapter attributes", () => {
  const BASE = "https://md.test/api";
  let client: MdClient;

  const chapterEntity = (id: string, attributes: Record<string, unknown>) => ({
    id,
    type: "chapter",
    attributes,
    relationships: [{ id: "md-manga", type: "manga" }],
  });

  const stubChapters = (entities: unknown[]) => {
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/token")) {
        return new Response(
          JSON.stringify({
            access_token: "access",
            refresh_token: "refresh",
            expires_in: 900,
            token_type: "Bearer",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const body = href.includes("/chapter/")
        ? { result: "ok", data: entities[0] }
        : { result: "ok", data: entities, total: entities.length, limit: 100, offset: 0 };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
  };

  beforeEach(() => {
    const config = loadConfig({
      DATABASE_URL: "postgresql://unused/unused",
      MANGADEX_API_URL: BASE,
      MANGADEX_AUTH_URL: "https://auth.test/realms/mangadex/protocol/openid-connect",
      MANGADEX_USERNAME: "u",
      MANGADEX_PASSWORD: "p",
      MANGADEX_CLIENT_ID: "c",
      MANGADEX_CLIENT_SECRET: "s",
      MANGADEX_RATELIMIT_MS: "0",
      LOG_LEVEL: "error",
    });
    const prisma = {
      setting: {
        findMany: async () => [],
        upsert: async () => ({}),
        deleteMany: async () => ({ count: 0 }),
      },
    } as never;
    client = new MdClient(config, prisma, createLogger("md-attributes-test", "error"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the page count on a collection read", async () => {
    stubChapters([
      chapterEntity("carded", {
        translatedLanguage: "en",
        externalUrl: "https://pub.example/manga/42",
        version: 3,
        pages: 1,
      }),
    ]);

    const [chapter] = await client.chaptersByIds(["carded"]);
    expect(chapter?.attributes.pages).toBe(1);
    expect(chapter && isCarded(chapter)).toBe(true);
  });

  it("keeps the page count on a single-chapter read", async () => {
    stubChapters([
      chapterEntity("carded", {
        translatedLanguage: "en",
        externalUrl: "https://pub.example/manga/42",
        version: 3,
        pages: 1,
      }),
    ]);

    const detail = await client.chapterById("carded");
    expect(detail?.attributes.pages).toBe(1);
    expect(detail && isCarded(detail)).toBe(true);
  });

  it("reports a live external chapter as not carded", async () => {
    stubChapters([
      chapterEntity("live", {
        translatedLanguage: "en",
        externalUrl: "https://pub.example/chapter/7",
        version: 1,
        pages: 0,
      }),
    ]);

    const [chapter] = await client.chaptersByIds(["live"]);
    expect(chapter?.attributes.pages).toBe(0);
    expect(chapter && isCarded(chapter)).toBe(false);
  });

  /**
   * A chapter MangaDex is refusing to serve is not a chapter we carded. The two
   * were conflated once already; the page count is what separates them, and
   * `isUnavailable` must never stand in for it.
   */
  it("does not read MangaDex's own isUnavailable flag as a card", async () => {
    stubChapters([
      chapterEntity("hidden", {
        translatedLanguage: "en",
        externalUrl: "https://pub.example/chapter/9",
        version: 1,
        pages: 0,
        isUnavailable: true,
      }),
    ]);

    const [chapter] = await client.chaptersByIds(["hidden"]);
    expect(chapter?.attributes.isUnavailable).toBe(true);
    expect(chapter && isCarded(chapter)).toBe(false);
  });
});
