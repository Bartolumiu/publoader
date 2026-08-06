import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MdClient } from "../../src/core/md/client.js";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";

/**
 * Every MangaDex call must be built on the configured base URL.
 *
 * This exists because of a real bug: `searchManga` passed the bare route
 * `"manga"` where every sibling passed `` `${mdApiUrl}/manga` ``. `buildUrl`
 * does `new URL(base)`, which throws on a relative string; so the call threw
 * every single time. It sat inside `TitleService.createOne`'s try block, so the
 * throw was recorded as a *create failure*: auto-creating a MangaDex title was
 * broken outright, and the duplicate-title guard it was added to provide had
 * never once run. Nothing caught it because the only test that touched
 * `searchManga` stubbed it out.
 *
 * So this test is deliberately not about `searchManga`. It drives every read
 * method through a stubbed `fetch` and asserts the URL is absolute and on the
 * configured host; the class of mistake, not the instance, because the next
 * method added is as likely to forget the base as that one was.
 */
describe("MdClient request URLs", () => {
  const BASE = "https://md.test/api";
  const requested: string[] = [];
  let client: MdClient;

  const emptyCollection = () =>
    new Response(JSON.stringify({ result: "ok", data: [], total: 0, limit: 100, offset: 0 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  beforeEach(() => {
    requested.length = 0;
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const href = String(url);
      // Reads are authenticated, so the client logs in first; answer the token
      // endpoint and keep it out of the asserted list, which is about the API
      // base rather than the auth base.
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
      requested.push(href);
      return emptyCollection();
    });

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
    // The token cache is the only database the client touches on a read.
    const prisma = {
      setting: {
        findMany: async () => [],
        upsert: async () => ({}),
        deleteMany: async () => ({ count: 0 }),
      },
    } as never;
    client = new MdClient(config, prisma, createLogger("md-url-test", "error"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const reads: [string, () => Promise<unknown>][] = [
    ["chaptersForManga", () => client.chaptersForManga("manga-1", "group-1")],
    ["chaptersByIds", () => client.chaptersByIds(["chapter-1"])],
    ["mangaByIds", () => client.mangaByIds(["manga-1"])],
    ["searchManga", () => client.searchManga("some title")],
    ["mangaById", () => client.mangaById("manga-1")],
    ["mangaAggregate", () => client.mangaAggregate("manga-1", "group-1")],
    ["currentUploadSession", () => client.currentUploadSession()],
  ];

  for (const [name, call] of reads) {
    it(`${name} builds an absolute URL on the configured base`, async () => {
      // A relative route throws inside buildUrl rather than returning a bad
      // URL, so "did not throw" is itself part of the assertion.
      await expect(call()).resolves.not.toThrow();
      expect(requested.length, `${name} made no request`).toBeGreaterThan(0);
      for (const url of requested) {
        expect(url.startsWith(`${BASE}/`), `${name} requested ${url}`).toBe(true);
        // Would be true of a relative URL resolved against some other origin.
        expect(() => new URL(url)).not.toThrow();
      }
    });
  }

  it("sends the search term as a query parameter rather than a path segment", async () => {
    await client.searchManga("Chainsaw Man");
    const url = new URL(requested[0]!);
    expect(url.pathname).toBe("/api/manga");
    expect(url.searchParams.get("title")).toBe("Chainsaw Man");
  });
});
