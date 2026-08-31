import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import { buildContext, type AppContext } from "../../src/core/api/context.js";
import { buildServer } from "../../src/core/api/server.js";
import { TitleService } from "../../src/core/md/titleService.js";
import type { MdApi, MdMangaDetail } from "../../src/core/md/types.js";
import { closeDb, dbReady, resetDb, testPrisma } from "./db.js";

/**
 * Resolving a publisher link to an extension and one of its series.
 *
 * The question this answers is the one that made mapping a job for whoever
 * already knew the catalogue: an operator arrives with a URL, and needs the two
 * facts a mapping takes — which extension covers that site, and what that
 * extension calls the series. Neither is guessable from the page.
 *
 * Every case below is about how strong the evidence is, because the failure
 * that matters is not "could not tell": it is a confident wrong answer, which
 * maps a live series onto someone else's title.
 */
describe.skipIf(!dbReady())("resolving a publisher link to a tracked series", () => {
  const prisma = testPrisma();
  const ADMIN_TOKEN = "test-admin-token-0123456789";
  const config = loadConfig({
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    ADMIN_TOKEN,
    LOG_LEVEL: "error",
  });
  const log = createLogger("test-source-links", "error");
  let app: FastifyInstance;
  let ctx: AppContext;
  const root = { authorization: `Bearer ${ADMIN_TOKEN}` };

  const TITLE_ID = "5f5f5f5f-0000-4000-8000-000000000001";
  const OTHER_TITLE = "5f5f5f5f-0000-4000-8000-000000000002";

  /** A MangaDex that holds the two titles these tests map onto, and nothing else. */
  const titles = new Map<string, MdMangaDetail>();
  const detail = (id: string): MdMangaDetail => ({
    id,
    attributes: {
      title: { en: `Title ${id.slice(-1)}` },
      altTitles: [],
      originalLanguage: "ja",
      status: "ongoing",
      contentRating: "safe",
      links: {},
      version: 1,
    },
  });

  beforeEach(async () => {
    await resetDb(prisma);
    ctx = buildContext(prisma, config, log);
    titles.clear();
    titles.set(TITLE_ID, detail(TITLE_ID));
    titles.set(OTHER_TITLE, detail(OTHER_TITLE));
    const md: Partial<MdApi> = {
      mangaById: async (id: string) => titles.get(id) ?? null,
      searchManga: async () => [],
    };
    ctx.titleService = new TitleService(prisma, md as MdApi, { send: async () => undefined }, log);
    app = buildServer(ctx);
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  /** A published bundle is what makes an extension claim a host. */
  const publish = (extension: string, hosts: string[]) =>
    prisma.bundle.create({
      data: {
        extension,
        version: "1.0.0",
        sha256: Math.random().toString(36).slice(2).padEnd(64, "0"),
        archive: Buffer.from("not-a-real-zip"),
        manifest: {
          name: extension,
          version: "1.0.0",
          publoader_api: "^2.0.0",
          runtime: "node",
          entrypoint: "index.mjs",
          class_name: "Extension",
          mangadex_group_id: "4f1de6a2-f0c5-4ac5-bce5-02c7dbb67deb",
          languages: ["en"],
          allowed_hosts: hosts,
        },
      },
    });

  const queued = (overrides: Record<string, unknown> = {}) =>
    prisma.untrackedManga.create({
      data: {
        extension: "comikey",
        mangaId: `id-${Math.random().toString(36).slice(2)}`,
        mangaName: "A Series",
        mangaLanguage: "en",
        mangaUrl: "https://comikey.com/comics/a-series",
        state: "NEW",
        ...overrides,
      },
    });

  /**
   * Enough worked examples for a rule to be believed. The learner needs five
   * that agree, so this is what "this extension puts the id last" looks like.
   */
  const teachTheRule = async (extension = "comikey") => {
    for (let i = 0; i < 6; i += 1) {
      await queued({
        extension,
        mangaId: `series-${i}`,
        mangaUrl: `https://${extension}.com/comics/series-${i}`,
      });
    }
  };

  const resolve = async (url: string) => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/admin/source/resolve?url=${encodeURIComponent(url)}`,
      headers: root,
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  it("recognises the exact page a queue row came from, however the link is written", async () => {
    await publish("comikey", ["comikey.com"]);
    const row = await queued({ mangaId: "kengan-omega", mangaUrl: "https://comikey.com/comics/kengan-omega/" });

    // The four spellings of one page. `manga_url` is stored as the extension
    // reported it, so a paste that differs only in these ways must still hit.
    for (const url of [
      "https://comikey.com/comics/kengan-omega/",
      "https://comikey.com/comics/kengan-omega",
      "http://www.comikey.com/comics/kengan-omega",
      "https://www.comikey.com/comics/kengan-omega/",
    ]) {
      const body = await resolve(url);
      expect(body.match, url).toMatchObject({
        extension: "comikey",
        mangaId: "kengan-omega",
        via: "queue",
      });
      // The row itself comes back, because mapping this link should also close
      // the queue entry it came from.
      expect(body.match.untracked.id).toBe(row.id);
      expect(body.match.untracked.mangaName).toBe("A Series");
    }
  });

  it("reads an id it already holds out of a link it has never seen", async () => {
    await publish("mangaplus", ["mangaplus.shueisha.co.jp"]);
    await prisma.trackedManga.create({
      data: { extension: "mangaplus", mangaId: "100001", mdMangaId: TITLE_ID },
    });

    // A deep link, from a share button rather than the series page itself.
    const body = await resolve("https://mangaplus.shueisha.co.jp/titles/100001?lang=en");
    expect(body.match).toMatchObject({ extension: "mangaplus", mangaId: "100001", via: "known-id" });
    // Already mapped, and saying so is the difference between adding a mapping
    // and silently repointing a live one.
    expect(body.match.tracked).toMatchObject({ mdMangaId: TITLE_ID });
  });

  it("will not read an id out of a longer number that merely contains it", async () => {
    await publish("mangaplus", ["mangaplus.shueisha.co.jp"]);
    await prisma.trackedManga.create({
      data: { extension: "mangaplus", mangaId: "100001", mdMangaId: TITLE_ID },
    });

    // `/titles/1000012` is a different series. Matching on a segment boundary
    // is the whole reason this is safe.
    const body = await resolve("https://mangaplus.shueisha.co.jp/titles/1000012");
    expect(body.match?.mangaId ?? null).not.toBe("100001");
  });

  it("learns where an extension puts its ids, and reaches a series nothing here has seen", async () => {
    await publish("comikey", ["comikey.com"]);
    await teachTheRule();

    const body = await resolve("https://comikey.com/comics/brand-new-series");
    expect(body.match).toMatchObject({
      extension: "comikey",
      mangaId: "brand-new-series",
      via: "rule",
    });
    // The measurement is reported, because a rule is evidence an operator may
    // want to weigh rather than a fact.
    expect(body.match.rule.samples).toBeGreaterThanOrEqual(5);
    expect(body.match.tracked).toBeNull();
  });

  it("names the extension even when it cannot name the series", async () => {
    await publish("comikey", ["comikey.com"]);

    // No rows at all, so nothing to learn from and nothing to match: the host
    // is still worth answering with.
    const body = await resolve("https://comikey.com/comics/unknown-thing");
    expect(body.match).toMatchObject({ extension: "comikey", mangaId: null, via: "host" });
  });

  it("refuses to guess when two extensions serve the same host", async () => {
    await publish("comikey", ["comikey.com"]);
    await publish("comikey_jp", ["comikey.com"]);

    const body = await resolve("https://comikey.com/comics/whatever");
    expect(body.match).toBeNull();
    expect(body.candidates).toEqual(["comikey", "comikey_jp"]);
    expect(body.reason).toContain("comikey_jp");
  });

  it("says so plainly when no published extension covers the site", async () => {
    await publish("comikey", ["comikey.com"]);

    const body = await resolve("https://some-other-publisher.example/series/1");
    expect(body.match).toBeNull();
    expect(body.reason).toContain("allowed_hosts");
  });

  it("refuses anything that is not a publisher link", async () => {
    const body = await resolve("not a url at all");
    expect(body.match).toBeNull();
    expect(body.reason).toContain("http");
  });

  // ---- mapping straight from the two links ----

  const mapFrom = (payload: Record<string, unknown>, headers = root) =>
    app.inject({ method: "POST", url: "/api/v1/admin/source/map", headers, payload });

  it("maps from the publisher link and the MangaDex link, and closes the queue row", async () => {
    await publish("comikey", ["comikey.com"]);
    const row = await queued({ mangaId: "kengan-omega", mangaUrl: "https://comikey.com/comics/kengan-omega" });

    const res = await mapFrom({
      url: "https://comikey.com/comics/kengan-omega/",
      // Both halves as links: neither id is typed by hand anywhere in this flow.
      mdMangaId: `https://mangadex.org/title/${TITLE_ID}/kengan-omega`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      changed: true,
      outcome: "added",
      extension: "comikey",
      mangaId: "kengan-omega",
      mdMangaId: TITLE_ID,
    });

    const mapping = await prisma.trackedManga.findFirstOrThrow({ where: { mangaId: "kengan-omega" } });
    expect(mapping.mdMangaId).toBe(TITLE_ID);
    // The row it came from is closed: a row left NEW behind a mapping is a
    // series that gets offered for creation all over again.
    const after = await prisma.untrackedManga.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.state).toBe("TRACKED");
    expect(after.mdMangaId).toBe(TITLE_ID);
  });

  it("writes nothing on a dry run, and says what it would have done", async () => {
    await publish("comikey", ["comikey.com"]);
    await queued({ mangaId: "kengan-omega", mangaUrl: "https://comikey.com/comics/kengan-omega" });

    const res = await mapFrom({
      url: "https://comikey.com/comics/kengan-omega",
      mdMangaId: TITLE_ID,
      dryRun: true,
    });
    expect(res.json()).toMatchObject({ dryRun: true, outcome: "added", mangaId: "kengan-omega" });
    expect(await prisma.trackedManga.count()).toBe(0);
    expect((await prisma.untrackedManga.findFirstOrThrow()).state).toBe("NEW");
  });

  it("refuses a MangaDex title that does not exist, rather than wiring uploads to nothing", async () => {
    await publish("mangaplus", ["mangaplus.shueisha.co.jp"]);
    await prisma.trackedManga.create({
      data: { extension: "mangaplus", mangaId: "100001", mdMangaId: TITLE_ID },
    });

    const res = await mapFrom({
      url: "https://mangaplus.shueisha.co.jp/titles/100001",
      mdMangaId: "5f5f5f5f-0000-4000-8000-00000000dead",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("MangaDex has no title");
  });

  it("reports a link it cannot pin to one series without writing anything", async () => {
    await publish("comikey", ["comikey.com"]);

    const res = await mapFrom({ url: "https://comikey.com/comics/who-knows", mdMangaId: TITLE_ID });
    expect(res.statusCode).toBe(409);
    // The half-answer is the useful part: the operator finishes it by naming
    // the id, rather than starting over somewhere else.
    expect(res.json().resolution.match).toMatchObject({ extension: "comikey", via: "host" });
    expect(await prisma.trackedManga.count()).toBe(0);
  });

  it("takes an operator's id for a link the resolver could not read", async () => {
    await publish("comikey", ["comikey.com"]);

    const res = await mapFrom({
      url: "https://comikey.com/comics/who-knows",
      mdMangaId: TITLE_ID,
      mangaId: "typed-by-hand",
    });
    expect(res.statusCode).toBe(200);
    const mapping = await prisma.trackedManga.findFirstOrThrow();
    expect(mapping).toMatchObject({ extension: "comikey", mangaId: "typed-by-hand", mdMangaId: TITLE_ID });
  });

  it("treats a link onto an already-mapped series as the repoint it is", async () => {
    await publish("mangaplus", ["mangaplus.shueisha.co.jp"]);
    await prisma.trackedManga.create({
      data: { extension: "mangaplus", mangaId: "100001", mdMangaId: TITLE_ID },
    });

    const res = await mapFrom({
      url: "https://mangaplus.shueisha.co.jp/titles/100001",
      mdMangaId: OTHER_TITLE,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      outcome: "repointed",
      previousMdMangaId: TITLE_ID,
      mdMangaId: OTHER_TITLE,
    });
  });

  it("reports the same mapping twice as nothing to do", async () => {
    await publish("mangaplus", ["mangaplus.shueisha.co.jp"]);
    await prisma.trackedManga.create({
      data: { extension: "mangaplus", mangaId: "100001", mdMangaId: TITLE_ID },
    });

    const res = await mapFrom({ url: "https://mangaplus.shueisha.co.jp/titles/100001", mdMangaId: TITLE_ID });
    expect(res.json()).toMatchObject({ ok: true, changed: false, outcome: "unchanged" });
  });
});
