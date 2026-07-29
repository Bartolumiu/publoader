import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
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
