import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import { buildContext } from "../../src/core/api/context.js";
import { buildServer } from "../../src/core/api/server.js";
import type { GithubContentsClient } from "../../src/core/webhooks/repoContents.js";
import { closeDb, dbReady, resetDb, testPrisma } from "./db.js";

/**
 * `POST /api/v1/admin/maps/sync` end to end: real auth, real scopes, real
 * `tracked_manga` rows, and a GitHub that lives in this process.
 *
 * The unit tests cover what the job decides; what matters here is that the
 * route reaches the database the operator thinks it does, that the scope gate
 * holds (this endpoint commits to a git repository), and that a dry run really
 * is dry.
 */
const ADMIN = "test-admin-token-0123456789";
const MD_A = "aaaaaaaa-0000-4000-8000-000000000001";
const MD_B = "bbbbbbbb-0000-4000-8000-000000000002";

describe.skipIf(!dbReady())("admin series-map sync", () => {
  const prisma = testPrisma();
  const config = loadConfig({
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    ADMIN_TOKEN: ADMIN,
    LOG_LEVEL: "error",
    GITHUB_REPO_OWNER: "publoader",
    GITHUB_EXTENSIONS_REPOS: "publoader-extensions",
    GITHUB_TOKEN: "gh-token-for-tests",
  });
  const log = createLogger("test-map-sync-api", "silent");
  let app: FastifyInstance;
  let files: Map<string, string>;
  let writes: { path: string; text: string; message: string }[];

  beforeEach(async () => {
    await resetDb(prisma);
    files = new Map([["src/mangaplus/manga_id_map.json", `{"${MD_A}": ["100001"]}`]]);
    writes = [];
    const contents: GithubContentsClient = {
      async listDirs() {
        return ["mangaplus"];
      },
      async getFile(_cfg, _repo, path) {
        const text = files.get(path);
        return text === undefined ? null : { path, sha: "blob-sha", text };
      },
      async putFile(_cfg, _repo, req) {
        writes.push({ path: req.path, text: req.text, message: req.message });
        files.set(req.path, req.text);
        return { path: req.path, commit: "c".repeat(40) };
      },
    };
    const ctx = buildContext(prisma, config, log);
    ctx.mapSyncContents = contents;
    app = buildServer(ctx);
    await app.ready();

    await prisma.trackedManga.createMany({
      data: [
        { extension: "mangaplus", namespace: "", mangaId: "100001", mdMangaId: MD_A, source: "bundle-import" },
        { extension: "mangaplus", namespace: "", mangaId: "100002", mdMangaId: MD_B, source: "auto" },
      ],
    });
  });
  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  const sync = (body: Record<string, unknown> = {}, token = ADMIN) =>
    app.inject({
      method: "POST",
      url: "/api/v1/admin/maps/sync",
      headers: { authorization: `Bearer ${token}`, "x-actor": "tester@example.com" },
      payload: body,
    });

  it("commits the auto-created mapping the file never had", async () => {
    const res = await sync();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.written).toBe(1);
    expect(body.outcomes[0]).toMatchObject({
      extension: "mangaplus",
      status: "write",
      repo: "publoader-extensions",
      added: 1,
      removed: 0,
      mappings: 2,
    });
    expect(JSON.parse(writes[0]!.text)).toEqual({ [MD_A]: ["100001"], [MD_B]: ["100002"] });
  });

  it("is idempotent: the second run has nothing to say", async () => {
    await sync();
    const res = await sync();
    expect(res.json().outcomes[0].status).toBe("unchanged");
    expect(writes).toHaveLength(1);
  });

  it("writes nothing on a dry run", async () => {
    const res = await sync({ dryRun: true });
    expect(res.json().outcomes[0]).toMatchObject({ status: "write", detail: "would write" });
    expect(writes).toHaveLength(0);
  });

  it("audits a real run and its per-file write, but not a preview", async () => {
    await sync({ dryRun: true });
    expect(await prisma.auditEvent.count({ where: { action: { startsWith: "map_sync" } } })).toBe(0);

    await sync();
    const events = await prisma.auditEvent.findMany({
      where: { action: { startsWith: "map_sync" } },
      orderBy: { action: "asc" },
    });
    expect(events.map((e) => e.action)).toEqual(["map_sync.run", "map_sync.write"]);
    // Attributed to the caller, not to "scheduler": a manual sync is somebody's
    // decision and the audit trail has to name them.
    expect(events[1]).toMatchObject({
      actor: "admin:tester@example.com",
      subject: "mangaplus@publoader-extensions",
    });
  });

  it("limits the run to the named extensions", async () => {
    await prisma.trackedManga.create({
      data: { extension: "other", namespace: "", mangaId: "1", mdMangaId: MD_A, source: "auto" },
    });
    const res = await sync({ extensions: ["mangaplus"] });
    expect(res.json().outcomes.map((o: { extension: string }) => o.extension)).toEqual(["mangaplus"]);
  });

  it("refuses a caller without tracked:write, because this publishes to a repo", async () => {
    const minted = await app.inject({
      method: "POST",
      url: "/api/v1/admin/tokens",
      headers: { authorization: `Bearer ${ADMIN}` },
      payload: { name: "map-reader", scopes: ["tracked:read", "tracked:append"] },
    });
    expect(minted.statusCode).toBe(201);

    const res = await sync({ dryRun: true }, minted.json().token);
    expect(res.statusCode).toBe(403);
    expect(writes).toHaveLength(0);
  });
});
