import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import AdmZip from "adm-zip";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import { buildContext, type AppContext } from "../../src/core/api/context.js";
import { buildServer } from "../../src/core/api/server.js";
import { MdRequestError } from "../../src/core/md/client.js";
import { TitleService } from "../../src/core/md/titleService.js";
import type { MdApi, MdMangaDetail } from "../../src/core/md/types.js";
import { closeDb, dbReady, resetDb, testPrisma } from "./db.js";

/**
 * Operational triage endpoints: upload-task queues, MangaDex session state, and
 * the merged error feed.
 *
 * Two properties matter beyond "the happy path works". First, scope
 * containment: these routes reach the upload pipeline and the platform's own
 * MangaDex credential state, so a token scoped elsewhere must be refused.
 * Second, a LEASED upload task belongs to a live uploader process; the API
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
  let md: MdStub;
  const root = { authorization: `Bearer ${ADMIN_TOKEN}` };

  /**
   * A MangaDex stand-in for the untracked-series routes. Not the dev mock over
   * HTTP: these tests are about what the API does with what MangaDex says,
 * including saying nothing, or refusing an edit as stale, and driving those
   * answers is exactly what a stub is for. The mock at docker/dev/mock-md covers
   * the wire format for the e2e stack.
   */
  interface MdStub extends Partial<MdApi> {
    titles: Map<string, MdMangaDetail>;
    edits: { mangaId: string; payload: Record<string, unknown>; version: number }[];
    drafts: Record<string, unknown>[];
    /** Thrown by the next editManga call, then cleared. */
    failEditWith?: Error;
    /** Thrown by every mangaById call, standing in for a MangaDex outage. */
    failReadWith?: Error;
  }

  function mdStub(): MdStub {
    const stub: MdStub = { titles: new Map(), edits: [], drafts: [] };
    stub.mangaById = async (mangaId: string) => {
      if (stub.failReadWith) throw stub.failReadWith;
      return stub.titles.get(mangaId) ?? null;
    };
    stub.editManga = async (mangaId, payload, version) => {
      if (stub.failEditWith) {
        const err = stub.failEditWith;
        stub.failEditWith = undefined;
        throw err;
      }
      stub.edits.push({ mangaId, payload, version });
      const existing = stub.titles.get(mangaId);
      if (existing) {
        stub.titles.set(mangaId, {
          id: mangaId,
          attributes: {
            ...existing.attributes,
            ...(payload.title ? { title: payload.title as Record<string, string> } : {}),
            ...(payload.links ? { links: payload.links as Record<string, string> } : {}),
            version: existing.attributes.version + 1,
          },
        });
      }
      return true;
    };
    stub.searchManga = async () => [];
    stub.createMangaDraft = async (payload) => {
      stub.drafts.push(payload);
      const id = `9c9c9c9c-0000-4000-8000-${String(stub.drafts.length).padStart(12, "0")}`;
      stub.titles.set(id, {
        id,
        attributes: {
          title: payload.title,
          altTitles: [],
          originalLanguage: payload.originalLanguage,
          status: payload.status,
          contentRating: payload.contentRating,
          links: payload.links ?? {},
          version: 1,
        },
      });
      return { id, version: 1 };
    };
    stub.commitMangaDraft = async () => true;
    return stub;
  }

  /** A MangaDex title the stub will serve, with one name and one raw link. */
  const seedTitle = (id: string, titles: Record<string, string>, raw?: string): MdMangaDetail => {
    const detail: MdMangaDetail = {
      id,
      attributes: {
        title: titles,
        altTitles: [],
        originalLanguage: "ja",
        status: "ongoing",
        contentRating: "safe",
        links: raw ? { raw } : {},
        version: 3,
      },
    };
    md.titles.set(id, detail);
    return detail;
  };

  /** A published bundle, so the routes can read the extension's manifest. */
  const bundle = async (overrides: Record<string, unknown> = {}) =>
    prisma.bundle.create({
      data: {
        extension: "opstest",
        version: "1.0.0",
        sha256: `${Math.random().toString(36).slice(2).padEnd(64, "0")}`,
        archive: Buffer.from("not-a-real-zip"),
        manifest: {
          name: "opstest",
          version: "1.0.0",
          publoader_api: "^2.0.0",
          runtime: "node",
          entrypoint: "index.mjs",
          class_name: "Extension",
          mangadex_group_id: "4f1de6a2-f0c5-4ac5-bce5-02c7dbb67deb",
          languages: ["en"],
          allowed_hosts: ["example.com"],
          auto_create_titles: false,
          title_defaults: { originalLanguage: "ja", contentRating: "safe", status: "ongoing" },
        },
        ...overrides,
      },
    });

  const untracked = (overrides: Record<string, unknown> = {}) =>
    prisma.untrackedManga.create({
      data: {
        extension: "opstest",
        mangaId: `ext-${Math.random().toString(36).slice(2)}`,
        mangaName: "Mangled Nmae",
        mangaLanguage: "en",
        mangaUrl: "https://example.com/series/1",
        state: "NEW",
        ...overrides,
      },
    });

  /** A logged-in dashboard session for `role`, plus the CSRF header writes need. */
  async function session(role: "OWNER" | "ADMIN" | "CONTRIBUTOR"): Promise<Record<string, string>> {
    const email = `${role.toLowerCase()}@example.com`;
    let cookie: string;
    if (role === "OWNER") {
      await ctx.adminUsers.ensureOwner(email);
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/admin/session",
        payload: { token: ADMIN_TOKEN, actor: "owner" },
      });
      cookie = login.cookies.find((c) => c.name === "publoader_session")!.value;
    } else {
      const user = await ctx.adminUsers.invite(email, role);
      await ctx.adminUsers.setPassword(user.id, "correct-horse-battery-staple");
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/admin/session",
        payload: { email, password: "correct-horse-battery-staple" },
      });
      expect(login.statusCode, `${role} login`).toBe(200);
      cookie = login.cookies.find((c) => c.name === "publoader_session")!.value;
    }
    return { cookie: `publoader_session=${cookie}`, "x-requested-with": "publoader-dash" };
  }

  beforeEach(async () => {
    await resetDb(prisma);
    await prisma.apiToken.deleteMany({});
    ctx = buildContext(prisma, config, log);
    // The API only holds a title service where it holds MangaDex credentials
    // (see services/api.ts); the untracked-correction routes are 503 without it,
    // so the tests that exercise them install one.
    md = mdStub();
    ctx.titleService = new TitleService(prisma, md as MdApi, { send: async () => undefined }, log);
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

  it("names the lease holder in the feed, falling back to an id for a worker that is gone", async () => {
    // An operator reads "server", not "0523b7e8"; the id is meaningless to
    // them and identical-looking across every worker they run.
    const known = await prisma.worker.create({
      data: {
        id: "11111111-1111-4111-8111-111111111111",
        name: "server",
        tokenHash: `hash-${Date.now()}`,
      },
    });
    const named = await job({ state: "SUCCEEDED" });
    const orphaned = await job({ state: "SUCCEEDED" });
    for (const [jobRow, workerId] of [
      [named, known.id],
      // No workers row: a revoked worker still has to be identifiable.
      [orphaned, "deadbeef-0000-4000-8000-000000000000"],
    ] as const) {
      await prisma.resultSubmission.create({
        data: {
          idempotencyKey: `sub-${jobRow.id}`,
          jobId: jobRow.id,
          attempt: 1,
          leaseId: "44444444-4444-4444-8444-444444444444",
          workerId,
          envelope: {},
          state: "QUARANTINED",
          rejectReason: "host not in allowed_hosts",
        },
      });
    }

    const res = await app.inject({ method: "GET", url: "/api/v1/admin/errors", headers: root });
    expect(res.statusCode).toBe(200);
    const subjects = (res.json().errors as { subject: string }[]).map((e) => e.subject);

    expect(subjects).toContainEqual(`worker server · job ${named.id}`);
    expect(subjects).toContainEqual(`worker deadbeef · job ${orphaned.id}`);
  });

  // ---- clearing the error feed ----

  /** The three sources at once, so a feed assertion covers all of them. */
  async function threeFailures() {
    const dead = await job({ state: "DEAD_LETTER", errorClass: "PERMANENT", lastError: "extension threw" });
    const failed = await task({ state: "FAILED", kind: "DELETE", lastError: "md 503" });
    const healthy = await job({ state: "SUCCEEDED" });
    const submission = await prisma.resultSubmission.create({
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
    return { dead, failed, healthy, submission };
  }

  const feed = async (query = "") => {
    const res = await app.inject({ method: "GET", url: `/api/v1/admin/errors${query}`, headers: root });
    expect(res.statusCode).toBe(200);
    return res.json() as {
      errors: { id: string; kind: string; source: string; cleared?: { by: string; note: string | null } }[];
      clearedHidden: number;
    };
  };

  it("hides a cleared failure from the feed, still lists it on request, and audits who cleared it", async () => {
    const { dead, failed, submission } = await threeFailures();
    expect((await feed()).errors).toHaveLength(3);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/errors/clear",
      headers: root,
      payload: { refs: [{ source: "job", id: dead.id }], note: "upstream fixed in 1.4.2" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, cleared: 1, skipped: [] });

    // Gone from the default feed, which is a to-do list, but counted, so an
    // empty list can never be mistaken for "nothing ever failed".
    const outstanding = await feed();
    expect(outstanding.errors.map((e) => e.id).sort()).toEqual([failed.id, submission.id].sort());
    expect(outstanding.clearedHidden).toBe(1);

    // Still there when asked for, annotated with who dealt with it and why.
    const withCleared = await feed("?cleared=with");
    expect(withCleared.errors).toHaveLength(3);
    expect(withCleared.errors.find((e) => e.id === dead.id)!.cleared).toMatchObject({
      by: "admin:root",
      note: "upstream fixed in 1.4.2",
    });

    const onlyCleared = await feed("?cleared=only");
    expect(onlyCleared.errors.map((e) => e.id)).toEqual([dead.id]);

    // The row itself is untouched: clearing is a view filter, not a transition.
    expect((await prisma.job.findUniqueOrThrow({ where: { id: dead.id } })).state).toBe("DEAD_LETTER");

    // One audit row per subject, so "who decided this was fine" is answerable by
    // subject lookup rather than only by reading a summary.
    const audited = await prisma.auditEvent.findMany({ where: { action: "errors.clear" } });
    expect(audited).toHaveLength(1);
    expect(audited[0]!.subject).toBe(`job:${dead.id}`);

    // And the badge count follows the same rule as the feed.
    const stats = await app.inject({ method: "GET", url: "/api/v1/admin/stats", headers: root });
    expect(stats.json().errorsOutstanding).toMatchObject({ total: 2, jobs: 0, uploadTasks: 1, submissions: 1 });
  });

  it("brings a cleared failure back when the same row fails again", async () => {
    const { dead } = await threeFailures();
    const clearedAgainst = dead.updatedAt;

    await app.inject({
      method: "POST",
      url: "/api/v1/admin/errors/clear",
      headers: root,
      payload: { refs: [{ source: "job", id: dead.id }] },
    });
    expect((await feed()).errors.map((e) => e.id)).not.toContain(dead.id);

    // A retry that dead-letters again touches the row, moving its timestamp past
    // the acknowledgement. Set explicitly rather than by sleeping: the two writes
    // can otherwise land in the same millisecond and the test would be a
    // coin flip.
    await prisma.job.update({
      where: { id: dead.id },
      data: { lastError: "failed again", updatedAt: new Date(clearedAgainst.getTime() + 5_000) },
    });

    const again = await feed();
    expect(again.errors.map((e) => e.id)).toContain(dead.id);
    // Back as NEW work, not as something already dealt with.
    expect(again.errors.find((e) => e.id === dead.id)!.cleared).toBeUndefined();
  });

  it("clears everything at once, and restores by id prefix", async () => {
    const { dead, failed, submission } = await threeFailures();

    const cleared = await app.inject({
      method: "POST",
      url: "/api/v1/admin/errors/clear",
      headers: root,
      payload: { all: true },
    });
    expect(cleared.json()).toMatchObject({ ok: true, cleared: 3 });
    expect((await feed()).errors).toHaveLength(0);
    expect((await feed()).clearedHidden).toBe(3);

    // A prefix is what an operator can actually copy off a truncated table.
    const restored = await app.inject({
      method: "POST",
      url: "/api/v1/admin/errors/restore",
      headers: root,
      payload: { ids: [failed.id.slice(0, 8)] },
    });
    expect(restored.json()).toMatchObject({ ok: true, restored: 1 });
    expect((await feed()).errors.map((e) => e.id)).toEqual([failed.id]);

    const all = await app.inject({
      method: "POST",
      url: "/api/v1/admin/errors/restore",
      headers: root,
      payload: { all: true },
    });
    expect(all.json()).toMatchObject({ restored: 2 });
    expect((await feed()).errors.map((e) => e.id).sort()).toEqual([dead.id, failed.id, submission.id].sort());
  });

  it("refuses to acknowledge anything that is not currently failing", async () => {
    const { dead, healthy } = await threeFailures();

    // Acknowledging a healthy row would silence its NEXT failure, so this is a
    // 404 with a reason rather than a write.
    const healthyClear = await app.inject({
      method: "POST",
      url: "/api/v1/admin/errors/clear",
      headers: root,
      payload: { ids: [healthy.id] },
    });
    expect(healthyClear.statusCode).toBe(404);
    expect(healthyClear.json().skipped[0].reason).toMatch(/nothing currently failing/);
    expect(await prisma.clearedError.count()).toBe(0);

    // Too short to be a deliberate prefix.
    const tooShort = await app.inject({
      method: "POST",
      url: "/api/v1/admin/errors/clear",
      headers: root,
      payload: { ids: [dead.id.slice(0, 2)] },
    });
    expect(tooShort.statusCode).toBe(404);
    expect(tooShort.json().skipped[0].reason).toMatch(/at least 4 characters/);

    // Right id, wrong source: the source is a claim about what failed and is
    // checked, not ignored.
    const wrongSource = await app.inject({
      method: "POST",
      url: "/api/v1/admin/errors/clear",
      headers: root,
      payload: { refs: [{ source: "upload-task", id: dead.id }] },
    });
    expect(wrongSource.statusCode).toBe(404);
    expect(wrongSource.json().skipped[0].reason).toMatch(/no upload-task/);

    // And nothing at all is not a request.
    const empty = await app.inject({
      method: "POST",
      url: "/api/v1/admin/errors/clear",
      headers: root,
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
  });

  it("drops acknowledgements whose row has gone, so the filter cannot grow forever", async () => {
    const { dead, failed } = await threeFailures();
    await app.inject({
      method: "POST",
      url: "/api/v1/admin/errors/clear",
      headers: root,
      payload: { all: true },
    });
    expect(await prisma.clearedError.count()).toBe(3);

    // Upload tasks are deleted once drained; the acknowledgement must not outlive
    // its subject.
    await prisma.uploadTask.delete({ where: { id: failed.id } });
    await app.inject({
      method: "POST",
      url: "/api/v1/admin/errors/clear",
      headers: root,
      payload: { refs: [{ source: "job", id: dead.id }] },
    });
    expect(await prisma.clearedError.count()).toBe(2);
    expect(await prisma.clearedError.findFirst({ where: { subjectId: failed.id } })).toBeNull();
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

    // Reading the failure feed and deciding a failure has been dealt with are
    // different privileges: clearing changes what the next operator sees.
    for (const url of ["/api/v1/admin/errors/clear", "/api/v1/admin/errors/restore"]) {
      const res = await app.inject({ method: "POST", url, headers: runsRead, payload: { all: true } });
      expect(res.statusCode, `${url} should need runs:write`).toBe(403);
      expect(res.json().error).toBe("missing scope: runs:write");
    }
    expect(await prisma.clearedError.count()).toBe(0);

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

    // A token reports its own scopes and is never OWNER; which is what the
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

    // Authentication is still required; "who am I" is not a public question.
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

    // Nothing was published; that is the whole point of a preflight.
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
    // would not catch; the file is present and useless.
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
    // saved MangaDex session in plaintext; so taking one is a credential-theft
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
    // runtime image deliberately omits; 503 with a fix is the correct answer
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

  // ---- automatic mapping by MangaDex's official English link ----

  const LINKED_ID = "6a6a6a6a-0000-4000-8000-000000000001";
  const RIVAL_ID = "6a6a6a6a-0000-4000-8000-000000000002";

  /** A search hit carrying an official English link. */
  const linked = (id: string, title: string, engtl: string | null) => ({
    id,
    attributes: {
      title: { en: title },
      altTitles: [],
      originalLanguage: "ja",
      links: (engtl ? { engtl } : {}) as Record<string, string>,
    },
  });

  const mapped = (mangaId: string) =>
    prisma.trackedManga.findUnique({
      where: {
        extension_namespace_mangaId: { extension: "opstest", namespace: "", mangaId },
      },
    });

  it("maps a series MangaDex lists under this publisher's own url", async () => {
    const row = await untracked({ mangaUrl: "https://example.com/series/1" });
    md.searchManga = async () => [linked(LINKED_ID, "Mangled Nmae", "https://example.com/series/1")];

    const report = await ctx.titleService!.autoMapByOfficialLink({ dryRun: false });
    expect(report.mapped).toHaveLength(1);
    expect(report.ambiguous).toBe(0);

    expect(await prisma.untrackedManga.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      state: "TRACKED",
      mdMangaId: LINKED_ID,
    });
    // Marked as automatic, because nobody looked at it: this is the mapping an
    // operator needs to find first if a series is wired to the wrong title.
    expect(await mapped(row.mangaId)).toMatchObject({
      mdMangaId: LINKED_ID,
      source: "auto:official-link",
    });
    // The whole point is that no title gets created for a series that has one.
    expect(md.drafts).toHaveLength(0);
  });

  it("matches across a trailing slash, www. and the scheme", async () => {
    // MangaDex editors and publishers write the same page differently; all of
    // these are the same series and were measured on the live catalogue.
    const row = await untracked({ mangaUrl: "https://example.com/series/1" });
    md.searchManga = async () => [linked(LINKED_ID, "Mangled Nmae", "http://www.example.com/series/1/")];

    const report = await ctx.titleService!.autoMapByOfficialLink({ dryRun: false });
    expect(report.mapped).toHaveLength(1);
    expect(await mapped(row.mangaId)).toMatchObject({ mdMangaId: LINKED_ID });
  });

  it("refuses a link on the same site but a different series", async () => {
    // The dangerous near-miss, and a real one: K MANGA rows on the live queue
    // turn up MangaDex titles whose engtl is kmanga.kodansha.com/title/<other>.
    // A host-level match would map them onto the wrong title.
    const row = await untracked({ mangaUrl: "https://example.com/series/1" });
    md.searchManga = async () => [linked(LINKED_ID, "Mangled Nmae", "https://example.com/series/999")];

    const report = await ctx.titleService!.autoMapByOfficialLink({ dryRun: false });
    expect(report.mapped).toHaveLength(0);
    expect(report.unmatched).toBe(1);
    expect(await mapped(row.mangaId)).toBeNull();
    expect((await prisma.untrackedManga.findUniqueOrThrow({ where: { id: row.id } })).state).toBe("NEW");
  });

  it("leaves two titles sharing one link for a human", async () => {
    const row = await untracked({ mangaUrl: "https://example.com/series/1" });
    md.searchManga = async () => [
      linked(LINKED_ID, "Mangled Nmae", "https://example.com/series/1"),
      linked(RIVAL_ID, "Mangled Nmae (2)", "https://example.com/series/1"),
    ];

    const report = await ctx.titleService!.autoMapByOfficialLink({ dryRun: false });
    expect(report.ambiguous).toBe(1);
    expect(report.mapped).toHaveLength(0);
    // Guessing between them is exactly the mistake this pass exists to avoid.
    expect(await mapped(row.mangaId)).toBeNull();
  });

  it("moves past an unmatched row on a dry run too, so pressing again finds more", async () => {
    // The bug this replaces: a preview recorded nothing, so it re-read the
    // same rows every time. At a hit rate near one in twenty that means the
    // operator sees zero, presses again, and sees the same zero — with
    // thousands of unchecked rows sitting behind them.
    await untracked({ mangaId: "ext-a", mangaUrl: "https://example.com/series/a" });
    await untracked({ mangaId: "ext-b", mangaUrl: "https://example.com/series/b" });
    const seen: string[] = [];
    md.searchManga = async (title: string) => {
      seen.push(title);
      return [];
    };

    const first = await ctx.titleService!.autoMapByOfficialLink({ dryRun: true, limit: 1 });
    const second = await ctx.titleService!.autoMapByOfficialLink({ dryRun: true, limit: 1 });

    expect(first.considered).toBe(1);
    expect(second.considered).toBe(1);
    // Two presses, two different rows.
    expect(seen).toHaveLength(2);
    // And it says how much is left, so a zero does not read as broken.
    expect(first.remaining).toBe(1);
    expect(second.remaining).toBe(0);
  });

  it("keeps an unacted match on a dry run, so the other button can still map it", async () => {
    const row = await untracked({ mangaUrl: "https://example.com/series/1" });
    md.searchManga = async () => [linked(LINKED_ID, "Mangled Nmae", "https://example.com/series/1")];

    const report = await ctx.titleService!.autoMapByOfficialLink({ dryRun: true });
    expect(report.mapped).toHaveLength(1);
    expect(await mapped(row.mangaId)).toBeNull();
    const after = await prisma.untrackedManga.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.state).toBe("NEW");
    expect(after.officialLinkCheckedAt).toBeNull();
  });

  it("does not search the same unmatched row twice", async () => {
    await untracked({ mangaUrl: "https://example.com/series/1" });
    let searches = 0;
    md.searchManga = async () => {
      searches++;
      return [];
    };

    await ctx.titleService!.autoMapByOfficialLink({ dryRun: false });
    await ctx.titleService!.autoMapByOfficialLink({ dryRun: false });
    // Re-searching every miss on every tick is ~2,400 calls a pass at the
    // current queue depth; the checked-at column is what stops that.
    expect(searches).toBe(1);
  });

  it("runs for extensions that never opted into auto-created titles", async () => {
    // auto_create_titles gates publishing to a public catalogue. Mapping
    // publishes nothing, so it must not share that gate — none of the sources
    // this was built for set the flag, and gating it would mean it never ran.
    // The bundle helper's manifest already has auto_create_titles: false.
    await bundle();
    const row = await untracked({ mangaUrl: "https://example.com/series/1" });
    md.searchManga = async () => [linked(LINKED_ID, "Mangled Nmae", "https://example.com/series/1")];

    await ctx.titleService!.tick();
    expect(await mapped(row.mangaId)).toMatchObject({ source: "auto:official-link" });
    expect(md.drafts).toHaveLength(0);
  });

  // ---- mapping an untracked series onto a title that already exists ----

  const MATCH_ID = "5f5f5f5f-0000-4000-8000-000000000001";
  const OTHER_ID = "5f5f5f5f-0000-4000-8000-000000000002";

  /** A search hit, in the shape searchManga returns. */
  const hit = (id: string, title: string, altTitles: Record<string, string>[] = []) => ({
    id,
    attributes: { title: { en: title }, altTitles, originalLanguage: "ja" },
  });

  /** A title MangaDex will admit to holding, so a map can be accepted. */
  function liveTitle(id: string, title: string): void {
    md.titles.set(id, {
      id,
      attributes: {
        title: { en: title },
        altTitles: [],
        originalLanguage: "ja",
        status: "ongoing",
        contentRating: "safe",
        links: {},
        version: 1,
      },
    });
  }

  it("searches MangaDex and flags the candidate matching the scraped name", async () => {
    md.searchManga = async () => [
      hit(MATCH_ID, "Mangled Nmae"),
      hit(OTHER_ID, "Something Else", [{ en: "Also Else" }, { ja: "Also Else" }]),
    ];

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admin/mangadex/search?q=Mangled%20Nmae",
      headers: root,
    });
    expect(res.statusCode).toBe(200);

    const results = res.json().results as {
      id: string;
      title: string;
      altTitles: string[];
      url: string;
      likely: boolean;
    }[];
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      id: MATCH_ID,
      title: "Mangled Nmae",
      url: `https://mangadex.org/title/${MATCH_ID}`,
      likely: true,
    });
    // The operator sees which one the auto-create path would have called a
    // duplicate, rather than that judgement staying hidden in the service.
    expect(results[1]!.likely).toBe(false);
    // Alt titles are de-duplicated across languages; the shown title is not
    // repeated back as one of them.
    expect(results[1]!.altTitles).toEqual(["Also Else"]);
  });

  it("maps a series onto an existing title, tracking it without creating one", async () => {
    const row = await untracked();
    liveTitle(MATCH_ID, "The Real Title");

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admin/untracked/${row.id}/map`,
      headers: root,
      payload: { mdMangaId: MATCH_ID },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, mdMangaId: MATCH_ID });

    // The map is what unblocks uploads, so it is the part that must be there.
    expect(
      await prisma.trackedManga.findUniqueOrThrow({
        where: {
          extension_namespace_mangaId: {
            extension: "opstest",
            namespace: "",
            mangaId: row.mangaId,
          },
        },
      }),
    ).toMatchObject({ mdMangaId: MATCH_ID });
    expect(
      await prisma.untrackedManga.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({ state: "TRACKED", mdMangaId: MATCH_ID, lastError: null });
    // The whole point: no second title for a series that already had one.
    expect(md.drafts).toHaveLength(0);
    await prisma.auditEvent.findFirstOrThrow({ where: { action: "untracked.map" } });
  });

  it("refuses a title id MangaDex does not have, rather than mapping to nothing", async () => {
    const row = await untracked();

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admin/untracked/${row.id}/map`,
      headers: root,
      payload: { mdMangaId: OTHER_ID },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("MangaDex has no title");
    // A typo must leave the queue untouched, not half-map the row.
    expect((await prisma.untrackedManga.findUniqueOrThrow({ where: { id: row.id } })).state).toBe("NEW");
    expect(await prisma.trackedManga.count()).toBe(0);
  });

  it("refuses to repoint a series that is already mapped somewhere else", async () => {
    const row = await untracked();
    liveTitle(MATCH_ID, "The Real Title");
    await prisma.trackedManga.create({
      data: { extension: "opstest", namespace: "", mangaId: row.mangaId, mdMangaId: OTHER_ID, source: "test" },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admin/untracked/${row.id}/map`,
      headers: root,
      payload: { mdMangaId: MATCH_ID },
    });
    // Repointing edits existing curation; it belongs in the tracked map, where
    // it is explicit, not behind a one-click button in a triage queue.
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("already mapped");
    expect(
      await prisma.trackedManga.findFirstOrThrow({ where: { mangaId: row.mangaId } }),
    ).toMatchObject({ mdMangaId: OTHER_ID });
  });

  it("finds one series in the queue by name, id or extension", async () => {
    const wanted = await untracked({ mangaName: "Findable Series", mangaId: "ext-needle-1" });
    await untracked({ mangaName: "Something Unrelated", mangaId: "ext-haystack-1" });

    const byName = await app.inject({ method: "GET", url: "/api/v1/admin/untracked?q=findable", headers: root });
    expect(byName.statusCode).toBe(200);
    expect((byName.json().untracked as { id: string }[]).map((r) => r.id)).toEqual([wanted.id]);

    // The external id is how these rows get referred to in practice.
    const byId = await app.inject({ method: "GET", url: "/api/v1/admin/untracked?q=needle", headers: root });
    expect((byId.json().untracked as { id: string }[]).map((r) => r.id)).toEqual([wanted.id]);

    // A search that matches nothing is an empty list, not every row.
    const none = await app.inject({ method: "GET", url: "/api/v1/admin/untracked?q=zzzznope", headers: root });
    expect(none.json().untracked).toEqual([]);
  });

  // ---- correcting an untracked series ----

  /**
   * The property under test throughout: a correction is two separate acts. The
   * local row is a contributor's to fix; the MangaDex entry it created is a
   * public catalogue record that only an admin may change, and only explicitly.
   */
  const MD_ID = "6a1b2c3d-0000-4000-8000-000000000001";

  it("returns the row, the live MangaDex title, and what an apply would send", async () => {
    await bundle();
    const row = await untracked({ state: "TRACKED", mdMangaId: MD_ID });
    seedTitle(MD_ID, { en: "Mangled Nmae" }, "https://example.com/moved");

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/admin/untracked/${row.id}`,
      headers: root,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.untracked).toMatchObject({ id: row.id, mangaName: "Mangled Nmae", mangaLanguage: "en" });
    // The MangaDex half is read live, so the operator edits against the entry as
    // it is now rather than against what the extension scraped.
    expect(body.mangadex).toMatchObject({
      id: MD_ID,
      titleUrl: `https://mangadex.org/title/${MD_ID}`,
      titles: { en: "Mangled Nmae" },
      originalLanguage: "ja",
      status: "ongoing",
      contentRating: "safe",
      links: { raw: "https://example.com/moved" },
      version: 3,
    });
    expect(body.mangadexError).toBeNull();
    // The row's URL and the entry's raw link disagree, and the diff says so
    // before anything is sent.
    expect(body.pendingChanges.map((c: { field: string }) => c.field)).toEqual(["links"]);
    expect(body.extension).toMatchObject({ allowedHosts: ["example.com"], languages: ["en"] });
    expect(body).toMatchObject({
      editable: true,
      canApplyToMangaDex: true,
      applyBlockedReason: null,
      appliedToMangaDex: null,
      languageValidation: "allowlist",
    });

    const unknown = await app.inject({
      method: "GET",
      url: "/api/v1/admin/untracked/00000000-0000-4000-8000-000000000000",
      headers: root,
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("still answers when the MangaDex read fails", async () => {
    const row = await untracked({ state: "TRACKED", mdMangaId: MD_ID });
    md.failReadWith = new MdRequestError("GET /manga failed; 503: upstream down", 503);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/admin/untracked/${row.id}`,
      headers: root,
    });
    // Correcting the local row does not need MangaDex, so a MangaDex outage must
    // not make the row unreadable.
    expect(res.statusCode).toBe(200);
    expect(res.json().untracked.id).toBe(row.id);
    expect(res.json().mangadex).toBeNull();
    expect(res.json().mangadexError).toContain("503");
    expect(res.json().pendingChanges).toEqual([]);
  });

  it("corrects the row, and refuses every value that would escape unchecked", async () => {
    await bundle();
    const row = await untracked();
    const patch = (payload: Record<string, unknown>) =>
      app.inject({ method: "PATCH", url: `/api/v1/admin/untracked/${row.id}`, headers: root, payload });

    const badLanguage = await patch({ mangaLanguage: "klingon" });
    expect(badLanguage.statusCode).toBe(400);
    expect(badLanguage.json().error).toContain("not a language MangaDex accepts");

    // This URL becomes links.raw on a public MangaDex entry and a clickable link
    // in Discord, so it is held to the extension's own allowlist.
    const badHost = await patch({ mangaUrl: "https://evil.test/series/1" });
    expect(badHost.statusCode).toBe(400);
    expect(badHost.json().error).toContain("allowed_hosts");
    expect(badHost.json().allowedHosts).toEqual(["example.com"]);

    const badScheme = await patch({ mangaUrl: "javascript:alert(1)" });
    expect(badScheme.statusCode).toBe(400);

    const blankName = await patch({ mangaName: "   " });
    expect(blankName.statusCode).toBe(400);

    // A misspelled field must not read as a successful edit that changed nothing.
    expect((await patch({ mangaNmae: "Correct Name" })).statusCode).toBe(400);
    expect((await patch({})).statusCode).toBe(400);

    // Nothing above touched the row.
    expect(await prisma.untrackedManga.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      mangaName: "Mangled Nmae",
      mangaLanguage: "en",
      mangaUrl: "https://example.com/series/1",
    });

    const good = await patch({
      mangaName: "  Correct Name  ",
      mangaLanguage: "JA",
      mangaUrl: "https://example.com/series/2",
    });
    expect(good.statusCode).toBe(200);
    expect(good.json().changed.sort()).toEqual(["mangaLanguage", "mangaName", "mangaUrl"]);
    // A language the extension does not declare is legitimate (a series' name in
    // its original language) but unusual, so it is reported and not refused.
    expect(good.json().warnings.join(" ")).toContain("not in opstest's manifest languages");
    // No title exists yet, so there is nothing to reconcile on MangaDex.
    expect(good.json().mangadexNeedsApply).toBe(false);

    const after = await prisma.untrackedManga.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({
      mangaName: "Correct Name",
      mangaLanguage: "ja",
      mangaUrl: "https://example.com/series/2",
    });

    const event = await prisma.auditEvent.findFirstOrThrow({ where: { action: "untracked.edit" } });
    expect(event.subject).toBe(row.id);
    expect(event.detail).toMatchObject({
      before: { mangaName: "Mangled Nmae", mangaLanguage: "en" },
      after: { mangaName: "Correct Name", mangaLanguage: "ja" },
    });
  });

  it("refuses to edit a row while a title creation is in flight", async () => {
    await bundle();
    const row = await untracked({ state: "CREATING" });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/untracked/${row.id}`,
      headers: root,
      payload: { mangaName: "Correct Name" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("CREATING");
    expect((await prisma.untrackedManga.findUniqueOrThrow({ where: { id: row.id } })).mangaName).toBe(
      "Mangled Nmae",
    );

    // The dashboard learns the same thing without having to try.
    const view = await app.inject({
      method: "GET",
      url: `/api/v1/admin/untracked/${row.id}`,
      headers: root,
    });
    expect(view.json().editable).toBe(false);
  });

  it("refuses an apply on a row that has no MangaDex title", async () => {
    const row = await untracked();

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admin/untracked/${row.id}/apply-to-mangadex`,
      headers: root,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe("no-md-title");
    expect(res.json().error).toContain("approve");
    expect(md.edits).toEqual([]);
  });

  it("lets a contributor correct the row but not the MangaDex title", async () => {
    await bundle();
    const row = await untracked({ state: "TRACKED", mdMangaId: MD_ID });
    seedTitle(MD_ID, { en: "Mangled Nmae" }, "https://example.com/series/1");
    const contributor = await session("CONTRIBUTOR");

    // Fixing the local row is exactly the job the CONTRIBUTOR role exists for.
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/untracked/${row.id}`,
      headers: contributor,
      payload: { mangaName: "Correct Name" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().mangadexNeedsApply).toBe(true);

    // Changing the public catalogue entry is not, even though the same scope
    // allowed the edit above.
    const apply = await app.inject({
      method: "POST",
      url: `/api/v1/admin/untracked/${row.id}/apply-to-mangadex`,
      headers: contributor,
    });
    expect(apply.statusCode).toBe(403);
    expect(apply.json().error).toContain("ADMIN role");
    expect(apply.json().requiredRole).toBe("ADMIN");
    expect(md.edits).toEqual([]);

    // ...and the reason is on the row, so the UI disables the control with an
    // explanation instead of letting them find out from the 403.
    const view = await app.inject({
      method: "GET",
      url: `/api/v1/admin/untracked/${row.id}`,
      headers: contributor,
    });
    expect(view.json().canApplyToMangaDex).toBe(false);
    expect(view.json().applyBlockedReason).toContain("ADMIN role");
    expect(view.json().pendingChanges.map((c: { field: string }) => c.field)).toEqual(["title"]);

    const admin = await session("ADMIN");
    const allowed = await app.inject({
      method: "POST",
      url: `/api/v1/admin/untracked/${row.id}/apply-to-mangadex`,
      headers: admin,
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ applied: true, mdMangaId: MD_ID });
    expect(md.edits).toHaveLength(1);
  });

  it("applies the correction to MangaDex and records both steps in the audit trail", async () => {
    await bundle();
    const row = await untracked({ state: "TRACKED", mdMangaId: MD_ID });
    seedTitle(MD_ID, { en: "Mangled Nmae" }, "https://example.com/series/1");

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/untracked/${row.id}`,
      headers: root,
      payload: { mangaName: "Correct Name" },
    });
    expect(patch.statusCode).toBe(200);
    // The row and the entry now disagree, and only an explicit apply reconciles
    // them: correcting a row never writes to MangaDex on its own.
    expect(patch.json().mangadexNeedsApply).toBe(true);
    expect(md.edits).toEqual([]);

    const apply = await app.inject({
      method: "POST",
      url: `/api/v1/admin/untracked/${row.id}/apply-to-mangadex`,
      headers: root,
    });
    expect(apply.statusCode).toBe(200);
    expect(apply.json()).toMatchObject({
      ok: true,
      applied: true,
      mdMangaId: MD_ID,
      titleUrl: `https://mangadex.org/title/${MD_ID}`,
    });

    expect(md.edits).toHaveLength(1);
    // The version read in the same request is what the write carries, and only
    // the changed field is sent; the entry's links, status and content rating
    // are not this platform's to restate.
    expect(md.edits[0]).toMatchObject({ mangaId: MD_ID, version: 3, payload: { title: { en: "Correct Name" } } });
    expect(md.edits[0]!.payload).not.toHaveProperty("links");

    const actions = await prisma.auditEvent.findMany({ where: { subject: row.id } });
    expect(new Set(actions.map((a) => a.action))).toEqual(
      new Set(["untracked.edit", "untracked.mangadex_apply"]),
    );
    const applied = actions.find((a) => a.action === "untracked.mangadex_apply")!;
    expect(applied.actor).toBe("admin:root");
    expect(applied.detail).toMatchObject({ mdMangaId: MD_ID, version: 3 });

    // Applying again sends nothing: the entry already says what the row says.
    const again = await app.inject({
      method: "POST",
      url: `/api/v1/admin/untracked/${row.id}/apply-to-mangadex`,
      headers: root,
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().applied).toBe(false);
    expect(md.edits).toHaveLength(1);

    const view = await app.inject({
      method: "GET",
      url: `/api/v1/admin/untracked/${row.id}`,
      headers: root,
    });
    expect(view.json().appliedToMangaDex).toMatchObject({ actor: "admin:root" });
    expect(view.json().pendingChanges).toEqual([]);
  });

  it("refuses a curator token, which holds untracked:write but is not a vetted human", async () => {
    // The hole this closes: the gate used to refuse only the CONTRIBUTOR role,
    // and `adminAuthHook` assigns every api token `adminRole = "ADMIN"`: meaning
    // "not owner-equivalent", not "vetted human". So the `curator` preset, which
    // carries untracked:write precisely so a community curator can work this
    // queue, cleared a gate whose stated purpose is to stop that very person
    // from editing a public catalogue. A leaked curator token could have rewritten
    // MangaDex titles under the platform's shared account.
    await bundle();
    const row = await untracked({ state: "TRACKED", mdMangaId: MD_ID });
    seedTitle(MD_ID, { en: "Mangled Nmae" }, "https://example.com/series/1");
    const curator = await mint(["untracked:write", "untracked:read", "extensions:read"]);

    // The token can still do its actual job: correcting the local row.
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/untracked/${row.id}`,
      headers: curator,
      payload: { mangaName: "Correct Name" },
    });
    expect(patch.statusCode).toBe(200);

    const apply = await app.inject({
      method: "POST",
      url: `/api/v1/admin/untracked/${row.id}/apply-to-mangadex`,
      headers: curator,
    });
    expect(apply.statusCode).toBe(403);
    expect(apply.json().error).toContain("api tokens");
    expect(md.edits, "MangaDex was edited by an api token").toEqual([]);

    // The GET agrees with the POST, so the dashboard never offers a button that
    // then 403s. These two checks live in different functions and drifted apart
    // once already.
    const view = await app.inject({
      method: "GET",
      url: `/api/v1/admin/untracked/${row.id}`,
      headers: curator,
    });
    expect(view.json().applyBlockedReason).toContain("api tokens");
  });

  it("refuses a role outside the allow-list, rather than granting it by default", async () => {
    // The gate is an allow-list because a deny-list on a role enum grants every
    // role that does not exist yet, and CONTRIBUTOR was itself added to AdminRole
    // after the fact. Asserted through the real OWNER/ADMIN paths: those two must
    // pass and nothing else may, so adding a fourth role cannot silently inherit
    // the right to edit a public catalogue.
    await bundle();
    for (const role of ["OWNER", "ADMIN"] as const) {
      const row = await untracked({ state: "TRACKED", mdMangaId: MD_ID, mangaName: `Fix ${role}` });
      seedTitle(MD_ID, { en: "Mangled Nmae" }, "https://example.com/series/1");
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/admin/untracked/${row.id}/apply-to-mangadex`,
        headers: await session(role),
      });
      expect(res.statusCode, `${role} should be allowed to apply`).toBe(200);
    }

    const row = await untracked({ state: "TRACKED", mdMangaId: MD_ID, mangaName: "Fix contributor" });
    const refused = await app.inject({
      method: "POST",
      url: `/api/v1/admin/untracked/${row.id}/apply-to-mangadex`,
      headers: await session("CONTRIBUTOR"),
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().requiredRole).toBe("ADMIN");
  });

  it("reports a version conflict rather than overwriting the other edit", async () => {
    const row = await untracked({ state: "TRACKED", mdMangaId: MD_ID, mangaName: "Correct Name" });
    seedTitle(MD_ID, { en: "Mangled Nmae" }, "https://example.com/series/1");
    md.failEditWith = new MdRequestError("PUT /manga failed; 409: version 3 is stale", 409);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admin/untracked/${row.id}/apply-to-mangadex`,
      headers: root,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe("version-conflict");
    expect(res.json().error).toContain("changed since it was read");

    // Nothing is claimed to have happened, and the failure is on the row where
    // the queue view shows it.
    expect(await prisma.auditEvent.count({ where: { action: "untracked.mangadex_apply" } })).toBe(0);
    expect(
      (await prisma.untrackedManga.findUniqueOrThrow({ where: { id: row.id } })).lastError,
    ).toContain("409");
  });

  it("creates the MangaDex title from the corrected values, not the scraped ones", async () => {
    await bundle();
    const row = await untracked();

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/untracked/${row.id}`,
      headers: root,
      payload: {
        mangaName: "Correct Name",
        mangaLanguage: "ja",
        mangaUrl: "https://example.com/series/9",
      },
    });
    expect(patch.statusCode).toBe(200);

    const approve = await app.inject({
      method: "POST",
      url: `/api/v1/admin/untracked/${row.id}/approve`,
      headers: root,
    });
    expect(approve.statusCode).toBe(200);

    // The whole point of correcting before approving: the title MangaDex is
    // asked to create is the corrected one.
    expect(md.drafts).toHaveLength(1);
    expect(md.drafts[0]).toMatchObject({
      title: { ja: "Correct Name" },
      links: { raw: "https://example.com/series/9" },
    });
    const after = await prisma.untrackedManga.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.state).toBe("TRACKED");
    expect(after.mdMangaId).toBe(approve.json().mdMangaId);
  });

  it("confines the correction routes to the untracked scopes", async () => {
    await bundle();
    const row = await untracked({ state: "TRACKED", mdMangaId: MD_ID });
    seedTitle(MD_ID, { en: "Mangled Nmae" });
    const stats = await mint(["stats:read"]);
    const reader = await mint(["untracked:read"]);

    const url = `/api/v1/admin/untracked/${row.id}`;
    expect((await app.inject({ method: "GET", url, headers: stats })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url, headers: reader })).statusCode).toBe(200);

    const patch = await app.inject({
      method: "PATCH",
      url,
      headers: reader,
      payload: { mangaName: "Correct Name" },
    });
    expect(patch.statusCode).toBe(403);
    expect(patch.json().error).toBe("missing scope: untracked:write");

    const apply = await app.inject({ method: "POST", url: `${url}/apply-to-mangadex`, headers: reader });
    expect(apply.statusCode).toBe(403);
    expect(md.edits).toEqual([]);

    // A read credential is told why the button it cannot use is disabled, too.
    const view = await app.inject({ method: "GET", url, headers: reader });
    expect(view.json().applyBlockedReason).toBe("missing scope: untracked:write");
  });
});
