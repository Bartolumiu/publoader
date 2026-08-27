import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MdClient, MdRequestError, optimisticLockVersion } from "../../src/core/md/client.js";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";

/**
 * MangaDex's optimistic lock, and the reason the unavailable-chapter flow used
 * to dead-end on it.
 *
 * The flow writes three versioned times against one chapter: open an edit
 * session, commit the card, repoint `externalUrl`. Each write carries the
 * version a *read* reported, and a read can lag the writes — MangaDex serves
 * chapter GETs from a cache, and an UNAVAILABLE task that failed after
 * committing is retried against that warm cache. The number it re-reads is the
 * pre-commit one, so its next write is rejected:
 *
 *   409 "The optimistic lock failed, version 2 was expected, but is actually 3"
 *
 * and the retry rejects identically, forever. The rejection names the real
 * version, so the fix is to replay the write with it.
 */
describe("MangaDex version conflicts", () => {
  const BASE = "https://md.test/api";

  const lockError = (expected: number, actual: number) =>
    new Response(
      JSON.stringify({
        result: "error",
        errors: [
          {
            id: "1eda4276-94fc-5629-bbc2-727731fef831",
            status: 409,
            title: "optimistic_lock_exception",
            detail: `The optimistic lock failed, version ${expected} was expected, but is actually ${actual}`,
            context: null,
          },
        ],
      }),
      { status: 409, headers: { "content-type": "application/json" } },
    );

  describe("optimisticLockVersion", () => {
    it("reads the current version out of a 409 body", () => {
      const err = new MdRequestError("PUT failed", 409, {
        errors: [
          {
            title: "optimistic_lock_exception",
            detail: "The optimistic lock failed, version 2 was expected, but is actually 3",
          },
        ],
      });
      expect(optimisticLockVersion(err)).toBe(3);
    });

    it("falls back to the message when the body did not parse", () => {
      const err = new MdRequestError(
        'PUT https://md.test/api/chapter/c1 failed; 409: {"errors":[{"title":"optimistic_lock_exception","detail":"The optimistic lock failed, version 7 was expected, but is actually 9"',
        409,
        null,
      );
      expect(optimisticLockVersion(err)).toBe(9);
    });

    it("ignores a 409 that is not a version conflict", () => {
      const err = new MdRequestError("POST failed", 409, {
        errors: [{ title: "upload_session_exists", detail: "A session already exists" }],
      });
      expect(optimisticLockVersion(err)).toBeNull();
    });

    it("ignores non-409 errors and non-errors", () => {
      expect(optimisticLockVersion(new MdRequestError("nope", 400, null))).toBeNull();
      expect(optimisticLockVersion(new Error("nope"))).toBeNull();
      expect(optimisticLockVersion(null)).toBeNull();
    });
  });

  describe("client replays the write", () => {
    let client: MdClient;
    let sent: { url: string; body: unknown }[];
    let respond: (url: string, attempt: number) => Response;

    beforeEach(() => {
      sent = [];
      vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
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
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        sent.push({ url: href, body });
        return respond(href, sent.length);
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
      const prisma = {
        setting: {
          findMany: async () => [],
          upsert: async () => ({}),
          deleteMany: async () => ({ count: 0 }),
        },
      } as never;
      client = new MdClient(config, prisma, createLogger("md-version-test", "error"));
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const ok = (data: unknown) =>
      new Response(JSON.stringify({ result: "ok", data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    it("opens the edit session with the version MangaDex reports", async () => {
      respond = (_url, attempt) =>
        attempt === 1 ? lockError(2, 3) : ok({ id: "session-1", type: "upload_session" });

      // `fileIds` is empty because this response carries no relationships; a
      // real edit session lists one `upload_session_file` per existing page.
      await expect(client.beginEditSession("chapter-1", 2)).resolves.toEqual({
        id: "session-1",
        fileIds: [],
      });
      expect(sent.map((call) => (call.body as { version: number }).version)).toEqual([2, 3]);
    });

    it("repoints externalUrl with the version MangaDex reports", async () => {
      respond = (_url, attempt) =>
        attempt === 1 ? lockError(2, 3) : ok({ id: "chapter-1", type: "chapter" });

      const payload = { chapter: "12", externalUrl: null, version: 2 };
      await expect(client.editChapter("chapter-1", payload)).resolves.toBe(true);
      expect(sent).toHaveLength(2);
      expect(sent[1]?.body).toEqual({ ...payload, version: 3 });
      // The caller's payload is not mutated; only the replay carries the bump.
      expect(payload.version).toBe(2);
    });

    it("edits a title with the version MangaDex reports", async () => {
      respond = (_url, attempt) =>
        attempt === 1 ? lockError(4, 5) : ok({ id: "manga-1", type: "manga" });

      await expect(client.editManga("manga-1", { title: { en: "x" } }, 4)).resolves.toBe(true);
      expect((sent[1]?.body as { version: number }).version).toBe(5);
    });

    it("gives up after one replay rather than chasing a moving version", async () => {
      // A second conflict means something outside this flow is writing; replaying
      // a body built from a stale read over it is what the lock is there to stop.
      respond = (_url, attempt) => lockError(2, 2 + attempt);

      await expect(client.beginEditSession("chapter-1", 2)).rejects.toThrow(
        /optimistic_lock_exception/,
      );
      expect(sent).toHaveLength(2);
    });

    it("does not replay a 409 that is not a version conflict", async () => {
      respond = () =>
        new Response(
          JSON.stringify({
            result: "error",
            errors: [{ status: 409, title: "upload_session_exists", detail: "already open" }],
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        );

      await expect(client.beginEditSession("chapter-1", 2)).rejects.toThrow(/409/);
      expect(sent).toHaveLength(1);
    });
  });
});
