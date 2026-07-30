import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient, UntrackedManga } from "@prisma/client";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import { MdClient, MdRequestError } from "../../src/core/md/client.js";
import { TitleService, mangaEditPayload } from "../../src/core/md/titleService.js";
import type { MdApi, MdMangaDetail } from "../../src/core/md/types.js";

/**
 * Correcting a MangaDex title is the one write in this platform that lands on a
 * public catalogue and cannot be undone from here, so the tests below are about
 * what is NOT sent as much as what is:
 *
 *  - a field the operator did not change is absent from the payload, because
 *    MangaDex leaves absent fields alone and echoing them back would put this
 *    pipeline's idea of a title's description or tags over a human's;
 *  - a field that IS sent carries the merged value, because MangaDex replaces
 *    whatever is sent wholesale — the failure mode being a correction that
 *    silently deletes a title's other names or its AniList link;
 *  - the version travels with the write, because it is the only thing standing
 *    between two concurrent editors and a lost correction.
 */

const log = createLogger("test-title-service", "silent");

const title = (attrs: Partial<MdMangaDetail["attributes"]> = {}): MdMangaDetail => ({
  id: "6a1b2c3d-0000-4000-8000-000000000001",
  attributes: {
    title: { en: "Mangled Nmae" },
    altTitles: [],
    originalLanguage: "ja",
    status: "ongoing",
    contentRating: "safe",
    links: { raw: "https://example.com/series/1" },
    version: 4,
    ...attrs,
  },
});

describe("mangaEditPayload", () => {
  it("sends only the title when only the name was corrected", () => {
    const plan = mangaEditPayload(title(), {
      mangaName: "Correct Name",
      mangaLanguage: "en",
      mangaUrl: "https://example.com/series/1",
    });

    expect(plan.payload).toEqual({ title: { en: "Correct Name" } });
    // Everything else is absent, not echoed: originalLanguage, status,
    // contentRating, altTitles and links stay whatever MangaDex holds.
    expect(Object.keys(plan.payload)).toEqual(["title"]);
    expect(plan.changes.map((c) => c.field)).toEqual(["title"]);
    // The version is the client's to attach, so it is not in the payload.
    expect(plan.payload).not.toHaveProperty("version");
  });

  it("moves the name when the language was wrong, instead of leaving both", () => {
    const plan = mangaEditPayload(title({ title: { en: "Mangled Nmae" } }), {
      mangaName: "正しい名前",
      mangaLanguage: "ja",
      mangaUrl: "https://example.com/series/1",
    });

    // The mangled English name must not survive as an alternative title in a
    // language the series was never in.
    expect(plan.payload).toEqual({ title: { ja: "正しい名前" } });
    expect(plan.notes.join(" ")).toContain("Mangled Nmae");
    expect(plan.notes.join(" ")).toContain("replaced");
  });

  it("keeps other people's titles when the entry carries several", () => {
    const plan = mangaEditPayload(
      title({ title: { en: "Official English", ja: "日本語" } }),
      { mangaName: "Corrected English", mangaLanguage: "en", mangaUrl: "https://example.com/series/1" },
    );

    expect(plan.payload.title).toEqual({ en: "Corrected English", ja: "日本語" });
    expect(plan.notes.join(" ")).toContain("left as");
  });

  it("merges links rather than replacing them, so other links survive", () => {
    const plan = mangaEditPayload(
      title({ links: { raw: "https://example.com/old", al: "12345", mu: "abcde" } }),
      { mangaName: "Mangled Nmae", mangaLanguage: "en", mangaUrl: "https://example.com/new" },
    );

    expect(plan.payload).toEqual({
      links: { raw: "https://example.com/new", al: "12345", mu: "abcde" },
    });
    expect(plan.changes.map((c) => c.field)).toEqual(["links"]);
  });

  it("adds links.raw to a title that has none", () => {
    const plan = mangaEditPayload(title({ links: null }), {
      mangaName: "Mangled Nmae",
      mangaLanguage: "en",
      mangaUrl: "https://example.com/series/1",
    });
    expect(plan.payload).toEqual({ links: { raw: "https://example.com/series/1" } });
  });

  it("sends nothing at all when the title already matches the row", () => {
    const plan = mangaEditPayload(title(), {
      mangaName: "Mangled Nmae",
      mangaLanguage: "en",
      mangaUrl: "https://example.com/series/1",
    });
    expect(plan.changes).toEqual([]);
    expect(plan.payload).toEqual({});
  });

  it("never clears links.raw for a row with no url", () => {
    const plan = mangaEditPayload(title(), {
      mangaName: "Mangled Nmae",
      mangaLanguage: "en",
      mangaUrl: "",
    });
    expect(plan.payload).not.toHaveProperty("links");
  });
});

// ---------------------------------------------------------------- MdClient

/** A JWT whose only useful claim is a future `exp`, so no auth call is made. */
const usableToken = (): string =>
  [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 900 })).toString("base64url"),
    "signature",
  ].join(".");

function client(): MdClient {
  const config = loadConfig({
    DATABASE_URL: "postgresql://unused",
    MANGADEX_API_URL: "https://api.mangadex.test",
    // No pacing: this suite makes real calls to a stubbed fetch, and the gate
    // would otherwise add two seconds per request.
    MANGADEX_RATELIMIT_MS: "0",
    LOG_LEVEL: "error",
  });
  const prisma = {
    setting: {
      findMany: async () => [{ key: "mdauth_access", value: usableToken() }],
      upsert: async () => undefined,
      deleteMany: async () => undefined,
    },
  } as unknown as PrismaClient;
  return new MdClient(config, prisma, log);
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("MdClient.editManga", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PUTs the changed fields plus the version MangaDex currently holds", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { result: "ok", data: { id: "abc", attributes: { version: 5 } } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const edited = await client().editManga("abc", { title: { en: "Correct Name" } }, 4);
    expect(edited).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.mangadex.test/manga/abc");
    expect(init.method).toBe("PUT");
    // The version is sent as read, not incremented: MangaDex bumps it itself,
    // and sending 5 here would be rejected as stale.
    expect(JSON.parse(String(init.body))).toEqual({ title: { en: "Correct Name" }, version: 4 });
  });

  it("reports a stale version instead of retrying it", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(409, { result: "error", errors: [{ detail: "version 4 is stale; current is 6" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const err = await client()
      .editManga("abc", { title: { en: "Correct Name" } }, 4)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MdRequestError);
    expect((err as MdRequestError).status).toBe(409);
    // One attempt only. Replaying the same stale version cannot succeed, and a
    // blind retry against a public catalogue is worse than an error message.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads a title with the attributes an edit needs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          result: "ok",
          data: {
            id: "abc",
            attributes: {
              title: { en: "Name" },
              altTitles: [{ ja: "名前" }],
              originalLanguage: "ja",
              status: "completed",
              contentRating: "suggestive",
              links: { raw: "https://example.com/1" },
              version: 7,
            },
          },
        }),
      ),
    );

    const manga = await client().mangaById("abc");
    expect(manga).toMatchObject({
      id: "abc",
      attributes: {
        title: { en: "Name" },
        originalLanguage: "ja",
        status: "completed",
        contentRating: "suggestive",
        links: { raw: "https://example.com/1" },
        version: 7,
      },
    });
  });

  it("returns null for a title MangaDex does not have", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(404, { result: "error" })));
    expect(await client().mangaById("gone")).toBeNull();
  });
});

// ------------------------------------------------------ TitleService.apply

const row = (overrides: Partial<UntrackedManga> = {}): UntrackedManga =>
  ({
    id: "11111111-1111-4111-8111-111111111111",
    extension: "opstest",
    mangaId: "ext-1",
    mangaName: "Correct Name",
    mangaLanguage: "en",
    mangaUrl: "https://example.com/series/1",
    state: "TRACKED",
    mdMangaId: "6a1b2c3d-0000-4000-8000-000000000001",
    attempts: 0,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as UntrackedManga;

function service(
  untracked: UntrackedManga,
  md: Partial<MdApi>,
): {
  titles: TitleService;
  audits: { action: string; actor: string; subject: string | null }[];
  saved: Partial<UntrackedManga>[];
} {
  const audits: { action: string; actor: string; subject: string | null }[] = [];
  const saved: Partial<UntrackedManga>[] = [];
  let current = untracked;
  const prisma = {
    untrackedManga: {
      findUnique: async () => current,
      update: async ({ data }: { data: Partial<UntrackedManga> }) => {
        saved.push(data);
        current = { ...current, ...data };
        return current;
      },
    },
    auditEvent: {
      create: async ({ data }: { data: { action: string; actor: string; subject: string | null } }) => {
        audits.push(data);
        return data;
      },
    },
  } as unknown as PrismaClient;
  const notifier = { send: vi.fn(async () => undefined) };
  return {
    titles: new TitleService(prisma, md as MdApi, notifier, log),
    audits,
    saved,
  };
}

describe("TitleService.applyToMangaDex", () => {
  it("edits with the version it just read, and audits the change", async () => {
    const editManga = vi.fn(async () => true);
    const { titles, audits, saved } = service(row(), {
      mangaById: async () => title(),
      editManga,
    });

    const result = await titles.applyToMangaDex(row().id, "user:ardax");

    expect(result).toMatchObject({
      ok: true,
      applied: true,
      titleUrl: "https://mangadex.org/title/6a1b2c3d-0000-4000-8000-000000000001",
    });
    expect(editManga).toHaveBeenCalledWith(
      "6a1b2c3d-0000-4000-8000-000000000001",
      { title: { en: "Correct Name" } },
      4,
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor: "user:ardax", action: "untracked.mangadex_apply" });
    // A row that has just been reconciled has no outstanding MangaDex error,
    // and records WHEN and BY WHOM it was applied. Those two columns are what
    // `GET /untracked/:id` reads back, so they are the point of this write —
    // deriving the same fact by scanning the audit log made a routine read
    // depend on how long logs are kept.
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ lastError: null, mdAppliedBy: "user:ardax" });
    expect(saved[0]!.mdAppliedAt).toBeInstanceOf(Date);
  });

  it("does not call MangaDex when the title already matches", async () => {
    const editManga = vi.fn(async () => true);
    const { titles, audits } = service(row({ mangaName: "Mangled Nmae" }), {
      mangaById: async () => title(),
      editManga,
    });

    const result = await titles.applyToMangaDex(row().id, "user:ardax");
    expect(result).toMatchObject({ ok: true, applied: false });
    expect(editManga).not.toHaveBeenCalled();
    // Nothing happened, so nothing is claimed to have happened.
    expect(audits).toEqual([]);
  });

  it("reports a version conflict as its own failure and records nothing", async () => {
    const { titles, audits, saved } = service(row(), {
      mangaById: async () => title(),
      editManga: async () => {
        throw new MdRequestError("PUT failed — 409: version 4 is stale", 409);
      },
    });

    const result = await titles.applyToMangaDex(row().id, "user:ardax");
    expect(result).toMatchObject({ ok: false, reason: "version-conflict" });
    expect(result.ok ? "" : result.error).toContain("changed since it was read");
    expect(audits).toEqual([]);
    // The failure is left on the row, so the queue view shows it without the
    // operator having to remember the toast.
    expect(saved[0]?.lastError).toContain("409");
  });

  it("separates a MangaDex refusal from a conflict", async () => {
    const { titles } = service(row(), {
      mangaById: async () => title(),
      editManga: async () => {
        throw new MdRequestError("PUT failed — 400: title is too long", 400);
      },
    });
    const result = await titles.applyToMangaDex(row().id, "user:ardax");
    expect(result).toMatchObject({ ok: false, reason: "rejected" });
  });

  it("refuses a row with no MangaDex title and one that is mid-creation", async () => {
    const noTitle = service(row({ mdMangaId: null, state: "NEW" }), { mangaById: async () => title() });
    expect(await noTitle.titles.applyToMangaDex(row().id, "user:ardax")).toMatchObject({
      ok: false,
      reason: "no-md-title",
    });

    const creating = service(row({ state: "CREATING" }), { mangaById: async () => title() });
    expect(await creating.titles.applyToMangaDex(row().id, "user:ardax")).toMatchObject({
      ok: false,
      reason: "creating",
    });
  });

  it("says so when the title is gone from MangaDex", async () => {
    const { titles } = service(row(), { mangaById: async () => null });
    const result = await titles.applyToMangaDex(row().id, "user:ardax");
    expect(result).toMatchObject({ ok: false, reason: "title-missing" });
  });
});
