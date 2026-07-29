import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import AdmZip from "adm-zip";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import { buildContext, type AppContext } from "../../src/core/api/context.js";
import { buildServer } from "../../src/core/api/server.js";
import { closeDb, dbReady, resetDb, testPrisma } from "./db.js";

/**
 * Operational triage endpoints: upload-task queues, MangaDex session state, and
 * the merged error feed.
 *
 * Two properties matter beyond "the happy path works". First, scope
 * containment: these routes reach the upload pipeline and the platform's own
 * MangaDex credential state, so a token scoped elsewhere must be refused.
 * Second, a LEASED upload task belongs to a live uploader process — the API
 * must refuse to touch it rather than race that process.
 */
describe.skipIf(!dbReady())("operational triage endpoints", () => {
  const prisma = testPrisma();
  const ADMIN_TOKEN = "test-admin-token-0123456789";
  const config = loadConfig({
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    ADMIN_TOKEN,
    LOG_LEVEL: "error",
  });
  const log = createLogger("test-ops", "error");
  let app: FastifyInstance;
  let ctx: AppContext;
  const root = { authorization: `Bearer ${ADMIN_TOKEN}` };

  beforeEach(async () => {
    await resetDb(prisma);
    await prisma.apiToken.deleteMany({});
    ctx = buildContext(prisma, config, log);
    app = buildServer(ctx);
    await app.ready();
    // buildServer already calls registerOpsRoutes; asserting that here means a
    // dropped wiring fails once, loudly, instead of as eleven 404s.
    expect(app.hasRoute({ method: "GET", url: "/api/v1/admin/upload-tasks" })).toBe(true);
  });
  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  /** A scoped `pa_…` credential carrying exactly `scopes`. */
  async function mint(scopes: string[]): Promise<Record<string, string>> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/tokens",
      headers: root,
      payload: { name: `ops-${scopes.join("-")}`, scopes },
    });
    expect(res.statusCode).toBe(201);
    return { authorization: `Bearer ${res.json().token}` };
  }

  const task = (overrides: Record<string, unknown> = {}) =>
    prisma.uploadTask.create({
      data: {
        kind: "UPLOAD",
        dedupeKey: `chapter-${Math.random().toString(36).slice(2)}|1|en`,
        chapter: { chapterNumber: "1", chapterLanguage: "en" },
        ...overrides,
      },
    });

  /** A run + one job, so job-shaped rows in the error feed have a parent. */
  async function job(overrides: Record<string, unknown> = {}) {
    const key = Math.random().toString(36).slice(2);
    const run = await prisma.run.create({
      data: {
        idempotencyKey: `run-${key}`,
        extension: "opstest",
        extensionVersion: "1.0.0",
        bundleSha256: "a".repeat(64),
        kind: "FORCE",
      },
    });
    return prisma.job.create({
      data: {
        idempotencyKey: `job-${key}`,
        runId: run.id,
        extension: "opstest",
        extensionVersion: "1.0.0",
        bundleSha256: "a".repeat(64),
        kind: "FORCE",
        ...overrides,
      },
    });
  }

  /** An unsigned JWT whose only interesting claim is `exp`. */
  const jwtWithExp = (expSeconds: number): string =>
    [
      Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
      Buffer.from(JSON.stringify({ exp: expSeconds, sub: "publoader" })).toString("base64url"),
      "not-a-real-signature",
    ].join(".");

  // ---- upload-task queues ----

  it("lists upload tasks with a depth summary and honours the filters", async () => {
    await task({ state: "PENDING" });
    await task({ state: "DEAD_LETTER", kind: "EDIT", lastError: "md said no", attempt: 5 });
    await task({ state: "DONE", kind: "DELETE" });

    const all = await app.inject({ method: "GET", url: "/api/v1/admin/upload-tasks", headers: root });
    expect(all.statusCode).toBe(200);
    expect(all.json().tasks).toHaveLength(3);
    expect(all.json().counts).toEqual(
      expect.arrayContaining([
        { kind: "UPLOAD", state: "PENDING", count: 1 },
        { kind: "EDIT", state: "DEAD_LETTER", count: 1 },
        { kind: "DELETE", state: "DONE", count: 1 },
      ]),
    );
    // The chapter payload is worker-supplied and large; triage never needs it.
    expect(all.json().tasks[0].chapter).toBeUndefined();

    const filtered = await app.inject({
      method: "GET",
      url: "/api/v1/admin/upload-tasks?kind=EDIT&state=DEAD_LETTER",
      headers: root,
    });
    expect(filtered.json().tasks).toHaveLength(1);
    expect(filtered.json().tasks[0]).toMatchObject({ kind: "EDIT", lastError: "md said no", attempt: 5 });
    // Counts stay global so the filter cannot hide a queue that is backing up.
    expect(filtered.json().counts).toHaveLength(3);

    const badFilter = await app.inject({
      method: "GET",
      url: "/api/v1/admin/upload-tasks?state=NOPE",
      headers: root,
    });
    expect(badFilter.statusCode).toBe(400);
  });

  it("retries a dead-lettered task with a fresh attempt budget", async () => {
    const dead = await task({ state: "DEAD_LETTER", attempt: 5, lastError: "timed out" });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admin/upload-tasks/${dead.id}/retry`,
      headers: root,
    });
    expect(res.statusCode).toBe(200);

    const after = await prisma.uploadTask.findUniqueOrThrow({ where: { id: dead.id } });
    expect(after).toMatchObject({ state: "PENDING", attempt: 0, leaseId: null });
    expect(after.notBefore.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await prisma.auditEvent.count({ where: { action: "upload_task.retry" } })).toBe(1);

    // Retrying it again is a conflict, not a silent no-op: it is already queued.
    const again = await app.inject({
      method: "POST",
      url: `/api/v1/admin/upload-tasks/${dead.id}/retry`,
      headers: root,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toContain("PENDING");

    const unknown = await app.inject({
      method: "POST",
      url: "/api/v1/admin/upload-tasks/00000000-0000-4000-8000-000000000000/retry",
      headers: root,
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("cancels a pending task and records why the row is DONE", async () => {
    const pending = await task({ state: "PENDING" });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admin/upload-tasks/${pending.id}/cancel`,
      headers: root,
    });
    expect(res.statusCode).toBe(200);

    const after = await prisma.uploadTask.findUniqueOrThrow({ where: { id: pending.id } });
    expect(after.state).toBe("DONE");
    // DONE alone is indistinguishable from a successful upload, so the reason
    // has to be on the row.
    expect(after.lastError).toContain("cancelled by operator");
    expect(after.lastError).toContain("never sent to MangaDex");

    const again = await app.inject({
      method: "POST",
      url: `/api/v1/admin/upload-tasks/${pending.id}/cancel`,
      headers: root,
    });
    expect(again.statusCode).toBe(409);
  });

  it("refuses to cancel a LEASED task, because an uploader owns it", async () => {
    const leased = await task({
      state: "LEASED",
      leaseId: "11111111-1111-4111-8111-111111111111",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });

    const cancel = await app.inject({
      method: "POST",
      url: `/api/v1/admin/upload-tasks/${leased.id}/cancel`,
      headers: root,
    });
    expect(cancel.statusCode).toBe(409);
    expect(cancel.json().error).toContain("LEASED");

    const retry = await app.inject({
      method: "POST",
      url: `/api/v1/admin/upload-tasks/${leased.id}/retry`,
      headers: root,
    });
    expect(retry.statusCode).toBe(409);

    // Untouched: no half-applied change from either refusal.
    expect(await prisma.uploadTask.findUniqueOrThrow({ where: { id: leased.id } })).toMatchObject({
      state: "LEASED",
      leaseId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("requeues only leases that have actually expired", async () => {
    const stale = await task({
      state: "LEASED",
      leaseId: "22222222-2222-4222-8222-222222222222",
      leaseExpiresAt: new Date(Date.now() - 60_000),
    });
    const live = await task({
      state: "LEASED",
      leaseId: "33333333-3333-4333-8333-333333333333",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/upload-tasks/requeue-stale",
      headers: root,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, requeued: 1 });

    expect((await prisma.uploadTask.findUniqueOrThrow({ where: { id: stale.id } })).state).toBe("PENDING");
    expect((await prisma.uploadTask.findUniqueOrThrow({ where: { id: live.id } })).state).toBe("LEASED");
  });

  // ---- MangaDex session visibility ----

  it("reports MangaDex session state without ever returning the tokens", async () => {
    const empty = await app.inject({ method: "GET", url: "/api/v1/admin/mangadex/auth", headers: root });
    expect(empty.json()).toMatchObject({
      hasAccess: false,
      hasRefresh: false,
      expiresAt: null,
      expired: false,
      expiresInSeconds: null,
    });

    const access = jwtWithExp(Math.floor(Date.now() / 1000) + 900);
    await ctx.settings.setSetting("mdauth_access", access);
    await ctx.settings.setSetting("mdauth_refresh", "refresh-token-value");

    const live = await app.inject({ method: "GET", url: "/api/v1/admin/mangadex/auth", headers: root });
    expect(live.json()).toMatchObject({ hasAccess: true, hasRefresh: true, expired: false });
    expect(live.json().expiresInSeconds).toBeGreaterThan(800);
    expect(live.body).not.toContain(access);
    expect(live.body).not.toContain("refresh-token-value");

    await ctx.settings.setSetting("mdauth_access", jwtWithExp(Math.floor(Date.now() / 1000) - 60));
    const stale = await app.inject({ method: "GET", url: "/api/v1/admin/mangadex/auth", headers: root });
    expect(stale.json()).toMatchObject({ expired: true });
    expect(stale.json().expiresInSeconds).toBeLessThan(0);

    // An unparseable token is reported as unknown expiry, not as expired: it may
    // still work, and calling it dead would send an operator to clear a good
    // session.
    await ctx.settings.setSetting("mdauth_access", "not-a-jwt");
    const opaque = await app.inject({ method: "GET", url: "/api/v1/admin/mangadex/auth", headers: root });
    expect(opaque.json()).toMatchObject({ hasAccess: true, expiresAt: null, expired: false });
  });

  it("clears the saved MangaDex session and audits it", async () => {
    await ctx.settings.setSetting("mdauth_access", jwtWithExp(Math.floor(Date.now() / 1000) + 60));
    await ctx.settings.setSetting("mdauth_refresh", "refresh-token-value");

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/mangadex/auth/clear",
      headers: root,
    });
    expect(res.statusCode).toBe(200);
    expect(await ctx.settings.getSetting("mdauth_access")).toBeNull();
    expect(await ctx.settings.getSetting("mdauth_refresh")).toBeNull();
    expect(await prisma.auditEvent.count({ where: { action: "mangadex_auth.clear" } })).toBe(1);
  });

  // ---- merged error feed ----

  it("merges dead-lettered jobs, failed upload tasks, and quarantine into one feed", async () => {
    const dead = await job({
      state: "DEAD_LETTER",
      errorClass: "PERMANENT",
      lastError: "extension threw",
      segmentIndex: 1,
      segmentTotal: 4,
    });
    const failed = await task({ state: "FAILED", kind: "DELETE", lastError: "md 503" });
    const healthy = await job({ state: "SUCCEEDED" });
    await prisma.resultSubmission.create({
      data: {
        idempotencyKey: `sub-${healthy.id}`,
        jobId: healthy.id,
        attempt: 1,
        leaseId: "44444444-4444-4444-8444-444444444444",
        workerId: "deadbeef-0000-4000-8000-000000000000",
        envelope: {},
        state: "QUARANTINED",
        rejectReason: "host not in allowed_hosts",
      },
    });

    const res = await app.inject({ method: "GET", url: "/api/v1/admin/errors", headers: root });
    expect(res.statusCode).toBe(200);
    const errors = res.json().errors as { at: string; kind: string; subject: string; message: string; id: string }[];
    expect(errors).toHaveLength(3);

    const byKind = Object.fromEntries(errors.map((e) => [e.kind, e]));
    expect(byKind["job:DEAD_LETTER"]).toMatchObject({ id: dead.id });
    expect(byKind["job:DEAD_LETTER"]!.subject).toBe("opstest · segment 2/4");
    expect(byKind["job:DEAD_LETTER"]!.message).toContain("[PERMANENT] extension threw");
    expect(byKind["upload-task:FAILED"]).toMatchObject({ id: failed.id, message: "md 503" });
    expect(byKind["submission:QUARANTINED"]!.message).toBe("host not in allowed_hosts");
    expect(byKind["submission:QUARANTINED"]!.subject).toContain("deadbeef");

    // Newest first, and the limit trims the merged list rather than each source.
    const timestamps = errors.map((e) => Date.parse(e.at));
    expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));
    const trimmed = await app.inject({ method: "GET", url: "/api/v1/admin/errors?limit=1", headers: root });
    expect(trimmed.json().errors).toHaveLength(1);
  });

  // ---- scope containment ----

  it("confines each endpoint to the scope it declares", async () => {
    const stats = await mint(["stats:read"]);
    const runsRead = await mint(["runs:read"]);
    const runsWrite = await mint(["runs:write"]);
    const settings = await mint(["settings:write"]);
    const pending = await task({ state: "PENDING" });

    // A monitoring credential reaches none of this.
    for (const url of ["/api/v1/admin/upload-tasks", "/api/v1/admin/errors", "/api/v1/admin/mangadex/auth"]) {
      const res = await app.inject({ method: "GET", url, headers: stats });
      expect(res.statusCode, `${url} should be forbidden for stats:read`).toBe(403);
      expect(res.json().error).toMatch(/^missing scope: /);
    }

    // runs:read sees the queues but cannot change them.
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/admin/upload-tasks", headers: runsRead })).statusCode,
    ).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/errors", headers: runsRead })).statusCode).toBe(200);
    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/admin/upload-tasks/${pending.id}/cancel`,
      headers: runsRead,
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe("missing scope: runs:write");
    expect((await prisma.uploadTask.findUniqueOrThrow({ where: { id: pending.id } })).state).toBe("PENDING");

    // runs:write may act on the queues, and write implies read.
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/admin/upload-tasks", headers: runsWrite })).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/admin/upload-tasks/requeue-stale",
          headers: runsWrite,
        })
      ).statusCode,
    ).toBe(200);
    // ...but not on the MangaDex credential state.
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/admin/mangadex/auth", headers: runsWrite })).statusCode,
    ).toBe(403);

    // settings:write is the mirror image.
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/admin/mangadex/auth", headers: settings })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/admin/upload-tasks", headers: settings })).statusCode,
    ).toBe(403);
  });

  it("keeps the worker audience out and names the acting token in the audit log", async () => {
    const dead = await task({ state: "DEAD_LETTER", attempt: 5 });
    const headers = await mint(["runs:write"]);

    await app.inject({
      method: "POST",
      url: `/api/v1/admin/upload-tasks/${dead.id}/retry`,
      headers,
    });
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { action: "upload_task.retry" } });
    expect(event.actor).toBe("token:ops-runs:write");

    // A worker credential is rejected by audience, before any scope check.
    const worker = await app.inject({
      method: "GET",
      url: "/api/v1/admin/upload-tasks",
      headers: { authorization: "Bearer pw_not-a-real-worker-token" },
    });
    expect(worker.statusCode).toBe(401);
  });

  // ---- identity, schema, search, preflight ----

  it("tells each principal what it is and what it may do", async () => {
    const asRoot = await app.inject({ method: "GET", url: "/api/v1/admin/whoami", headers: root });
    expect(asRoot.statusCode).toBe(200);
    expect(asRoot.json()).toMatchObject({
      kind: "root",
      name: "root",
      role: "OWNER",
      scopes: ["*"],
      csrfHeader: "x-requested-with",
    });

    // A token reports its own scopes and is never OWNER — which is what the
    // dashboard needs in order to hide what the server would refuse.
    const headers = await mint(["runs:read", "stats:read"]);
    const asToken = await app.inject({ method: "GET", url: "/api/v1/admin/whoami", headers });
    expect(asToken.json()).toMatchObject({ kind: "api-token", role: "ADMIN" });
    expect(asToken.json().scopes.sort()).toEqual(["runs:read", "stats:read"]);
    // No secret is disclosed: the answer is about authority, not credentials.
    expect(asToken.body).not.toContain("pa_");

    // A cookie session reports the account's role, and its scopes come from that
    // role rather than from a stored list.
    await ctx.adminUsers.ensureOwner("owner@example.com");
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/admin/session",
      payload: { token: ADMIN_TOKEN, actor: "ardax" },
    });
    const cookie = `publoader_session=${login.cookies.find((c) => c.name === "publoader_session")!.value}`;
    const asSession = await app.inject({ method: "GET", url: "/api/v1/admin/whoami", headers: { cookie } });
    expect(asSession.json()).toMatchObject({
      kind: "session",
      name: "user:ardax",
      role: "OWNER",
      scopes: ["*"],
    });

    const contributor = await ctx.adminUsers.invite("curator@example.com", "CONTRIBUTOR");
    await ctx.adminUsers.setPassword(contributor.id, "correct-horse-battery-staple");
    const asContributor = await app.inject({
      method: "POST",
      url: "/api/v1/admin/session",
      payload: { email: "curator@example.com", password: "correct-horse-battery-staple" },
    });
    const contributorCookie = `publoader_session=${asContributor.cookies.find((c) => c.name === "publoader_session")!.value}`;
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/admin/whoami",
      headers: { cookie: contributorCookie },
    });
    expect(me.json()).toMatchObject({ kind: "session", role: "CONTRIBUTOR" });
    // The narrow set is the point: the SPA hides what these scopes cannot reach.
    expect(me.json().scopes).toContain("tracked:append");
    expect(me.json().scopes).not.toContain("tracked:write");
    expect(me.json().scopes).not.toContain("runs:write");
    expect(me.json().scopes).not.toContain("*");

    // Authentication is still required — "who am I" is not a public question.
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/whoami" })).statusCode).toBe(401);
  });

  it("reports the migration state of the database it is actually connected to", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/schema", headers: root });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // globalSetup runs `prisma migrate deploy`, so this database is by
    // construction fully migrated with a real history table.
    expect(body).toMatchObject({ historyAvailable: true, current: true, pending: [], failed: [] });
    expect(body.onDisk.length).toBeGreaterThan(0);
    expect(body.applied.map((m: { name: string }) => m.name)).toEqual(expect.arrayContaining(body.onDisk));
    expect(body.applied.every((m: { failed: boolean }) => !m.failed)).toBe(true);

    // Reading migration names is a settings:read question, not an open one.
    const stats = await mint(["stats:read"]);
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/schema", headers: stats })).statusCode).toBe(403);
  });

  it("searches the audit log by needle, actor, action, and time window", async () => {
    await ctx.audit.record("user:ardax", "platform.pause", undefined, { minutes: 5 });
    await ctx.audit.record("token:discord-bot", "run.trigger", "mangaplus", { kind: "FORCE" });
    await ctx.audit.record("user:ardax", "worker.revoke", "worker-7");

    const all = await app.inject({ method: "GET", url: "/api/v1/admin/audit/search", headers: root });
    expect(all.statusCode).toBe(200);
    expect(all.json().total).toBe(3);
    // Newest first.
    expect(all.json().events[0].action).toBe("worker.revoke");

    const byActor = await app.inject({
      method: "GET",
      url: "/api/v1/admin/audit/search?actor=ardax",
      headers: root,
    });
    expect(byActor.json().total).toBe(2);

    const byAction = await app.inject({
      method: "GET",
      url: "/api/v1/admin/audit/search?action=worker.",
      headers: root,
    });
    expect(byAction.json().total).toBe(1);

    // The needle reaches the detail JSON, which is where the useful specifics
    // live (a manga id, a kind, a scope list).
    const byDetail = await app.inject({
      method: "GET",
      url: "/api/v1/admin/audit/search?q=mangaplus",
      headers: root,
    });
    expect(byDetail.json().total).toBe(1);
    expect(byDetail.json().events[0].actor).toBe("token:discord-bot");

    // A `%` in the needle is data for the parameter binder, not a syntax error.
    const wildcard = await app.inject({
      method: "GET",
      url: `/api/v1/admin/audit/search?q=${encodeURIComponent("100% not here")}`,
      headers: root,
    });
    expect(wildcard.statusCode).toBe(200);
    expect(wildcard.json().total).toBe(0);

    // Total counts the whole match set, so paging can say "1 of 3".
    const paged = await app.inject({
      method: "GET",
      url: "/api/v1/admin/audit/search?limit=1&offset=1",
      headers: root,
    });
    expect(paged.json().total).toBe(3);
    expect(paged.json().events).toHaveLength(1);

    const future = await app.inject({
      method: "GET",
      url: `/api/v1/admin/audit/search?since=${new Date(Date.now() + 60_000).toISOString()}`,
      headers: root,
    });
    expect(future.json().total).toBe(0);

    const runsOnly = await mint(["runs:write"]);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/admin/audit/search", headers: runsOnly })).statusCode,
    ).toBe(403);
  });

  it("preflights a bundle zip without publishing it", async () => {
    const manifest = {
      name: "opstest",
      version: "1.0.0",
      publoader_api: "^2.0.0",
      runtime: "node",
      entrypoint: "index.mjs",
      mangadex_group_id: "4f1de6a2-f0c5-4ac5-bce5-02c7dbb67deb",
      languages: ["en"],
      allowed_hosts: ["example.com"],
    };
    const zipWith = (files: Record<string, string>): Buffer => {
      const zip = new AdmZip();
      for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content));
      return zip.toBuffer();
    };
    const post = (payload: Buffer, headers: Record<string, string>) =>
      app.inject({
        method: "POST",
        url: "/api/v1/admin/bundles/inspect",
        headers: { ...headers, "content-type": "application/zip" },
        payload,
      });

    const good = await post(
      zipWith({ "manifest.json": JSON.stringify(manifest), "index.mjs": "export default () => ({});\n" }),
      root,
    );
    expect(good.statusCode).toBe(200);
    expect(good.json()).toMatchObject({
      ok: true,
      errors: [],
      manifest: { name: "opstest", version: "1.0.0", entrypoint: "index.mjs" },
      currentlyPublished: null,
    });

    // Nothing was published — that is the whole point of a preflight.
    expect(await prisma.bundle.count()).toBe(0);

    const missingEntrypoint = await post(zipWith({ "manifest.json": JSON.stringify(manifest) }), root);
    expect(missingEntrypoint.statusCode).toBe(422);
    expect(missingEntrypoint.json().errors[0]).toContain("index.mjs");

    const noManifest = await post(zipWith({ "index.mjs": "export default () => ({});\n" }), root);
    expect(noManifest.statusCode).toBe(422);
    expect(noManifest.json().errors[0]).toContain("manifest.json");

    const badManifest = await post(zipWith({ "manifest.json": "{not json" }), root);
    expect(badManifest.statusCode).toBe(422);
    expect(badManifest.json().errors[0]).toContain("not valid JSON");

    // A schema-invalid manifest is reported field by field. "languages: array
    // must contain at least 1 element" is actionable; "validation failed" is not.
    const schemaInvalid = await post(
      zipWith({
        "manifest.json": JSON.stringify({ ...manifest, languages: [], mangadex_group_id: "not-a-uuid" }),
        "index.mjs": "export default () => ({});\n",
      }),
      root,
    );
    expect(schemaInvalid.statusCode).toBe(422);
    expect(schemaInvalid.json().ok).toBe(false);
    const fields = schemaInvalid.json().errors.join("\n");
    expect(fields).toContain("languages");
    expect(fields).toContain("mangadex_group_id");

    // An empty entrypoint is a real publishing failure that a file listing alone
    // would not catch — the file is present and useless.
    const emptyEntrypoint = await post(
      zipWith({ "manifest.json": JSON.stringify(manifest), "index.mjs": "   \n" }),
      root,
    );
    expect(emptyEntrypoint.statusCode).toBe(422);
    expect(emptyEntrypoint.json().errors[0]).toContain("empty");

    // Python bundles are refused outright: the runtime was removed, and the
    // preflight has to say so before an operator uploads 40 MiB of it.
    const python = await post(
      zipWith({
        "manifest.json": JSON.stringify({
          ...manifest,
          publoader_api: "^1.0.0",
          runtime: "python",
          entrypoint: "extension.py",
        }),
        "extension.py": "class Extension: pass\n",
      }),
      root,
    );
    expect(python.statusCode).toBe(422);
    expect(python.json().errors.join("\n")).toContain("python bundles are no longer accepted");

    // Nothing above published anything, including the valid one.
    expect(await prisma.bundle.count()).toBe(0);

    // A read scope is enough to preflight; it changes nothing.
    const reader = await mint(["bundles:read"]);
    expect(
      (
        await post(
          zipWith({ "manifest.json": JSON.stringify(manifest), "index.mjs": "export default () => ({});\n" }),
          reader,
        )
      ).statusCode,
    ).toBe(200);
    const outsider = await mint(["runs:write"]);
    expect((await post(zipWith({ "manifest.json": "{}" }), outsider)).statusCode).toBe(403);
  });

  it("gathers one extension's runs, jobs, and curation counts into one answer", async () => {
    const dead = await job({ state: "DEAD_LETTER", lastError: "boom", errorClass: "PERMANENT" });
    await prisma.trackedManga.create({
      data: { extension: "opstest", mangaId: "ext-1", mdMangaId: "9a1b1c1d-0000-4000-8000-000000000000" },
    });
    await prisma.untrackedManga.create({
      data: {
        extension: "opstest",
        mangaId: "ext-2",
        mangaName: "Something New",
        mangaLanguage: "en",
        mangaUrl: "https://example.com/2",
        state: "NEW",
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admin/extensions/opstest/activity",
      headers: root,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.extension).toBe("opstest");
    expect(body.jobs.map((j: { id: string }) => j.id)).toContain(dead.id);
    expect(body.runs).toHaveLength(1);
    expect(body.tracked).toBe(1);
    expect(body.untracked).toMatchObject({ NEW: 1 });
    // No bundle was published for it, which is a real state and not an error.
    expect(body.bundle).toBeNull();

    const bad = await app.inject({
      method: "GET",
      url: "/api/v1/admin/extensions/Not-A-Name/activity",
      headers: root,
    });
    expect(bad.statusCode).toBe(400);
  });

  it("merges every source into the activity feed, newest first", async () => {
    await job({ state: "DEAD_LETTER", lastError: "job died" });
    await task({ state: "FAILED", lastError: "task failed" });
    await ctx.audit.record("user:ardax", "platform.pause", undefined, { minutes: 5 });

    const res = await app.inject({ method: "GET", url: "/api/v1/admin/activity", headers: root });
    expect(res.statusCode).toBe(200);
    const rows = res.json().activity as { at: string; severity: string; source: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(new Set(rows.map((r) => r.source))).toEqual(new Set(["run", "job", "upload-task", "audit"]));
    // Severity is decided server-side so the UI filter is a predicate, not a guess.
    expect(rows.filter((r) => r.severity === "error").length).toBeGreaterThanOrEqual(2);
    const timestamps = rows.map((r) => Date.parse(r.at));
    expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));
  });

  it("keeps a database dump out of reach of every token, however broadly scoped", async () => {
    // A dump contains every operator password hash, every token hash, and the
    // saved MangaDex session in plaintext — so taking one is a credential-theft
    // primitive, not a read. It must sit at the same bar as account
    // administration: OWNER role AND users:admin, which together exclude api
    // tokens by construction (adminAuthHook never gives one the OWNER role).
    for (const scopes of [["*"], ["users:admin"], ["settings:write"]]) {
      const headers = await mint(scopes);
      const res = await app.inject({ method: "GET", url: "/api/v1/admin/backup", headers });
      expect(res.statusCode, `a ${scopes.join(",")} token must not reach /backup`).toBe(403);
    }
    expect(await prisma.auditEvent.count({ where: { action: "database.backup" } })).toBe(0);

    // The break-glass credential is owner-equivalent, so it gets past the guard.
    // Whether the dump then runs depends on pg_dump being installed, which the
    // runtime image deliberately omits — 503 with a fix is the correct answer
    // there, and either outcome proves authorization passed.
    const allowed = await app.inject({ method: "GET", url: "/api/v1/admin/backup", headers: root });
    expect([200, 503]).toContain(allowed.statusCode);
    if (allowed.statusCode === 503) {
      expect(allowed.json().error).toContain("pg_dump");
    }
  });

  it("requires the CSRF header on cookie-authenticated queue writes", async () => {
    await ctx.adminUsers.ensureOwner("owner@example.com");
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/admin/session",
      payload: { token: ADMIN_TOKEN, actor: "tester" },
    });
    const sessionCookie = login.cookies.find((c) => c.name === "publoader_session")!;
    const cookie = `publoader_session=${sessionCookie.value}`;
    const pending = await task({ state: "PENDING" });

    const bare = await app.inject({
      method: "POST",
      url: `/api/v1/admin/upload-tasks/${pending.id}/cancel`,
      headers: { cookie },
    });
    expect(bare.statusCode).toBe(403);
    expect(bare.json().error).toContain("x-requested-with");
    expect((await prisma.uploadTask.findUniqueOrThrow({ where: { id: pending.id } })).state).toBe("PENDING");

    const dashed = await app.inject({
      method: "POST",
      url: `/api/v1/admin/upload-tasks/${pending.id}/cancel`,
      headers: { cookie, "x-requested-with": "publoader-dash" },
    });
    expect(dashed.statusCode).toBe(200);
  });
});
