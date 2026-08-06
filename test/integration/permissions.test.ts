import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import { buildContext } from "../../src/core/api/context.js";
import { buildServer } from "../../src/core/api/server.js";
import { closeDb, dbReady, resetDb, testPrisma } from "./db.js";

/**
 * Permission tuning, end to end.
 *
 * The claims worth evidence here are the ones a reader would otherwise have to
 * take on trust: that a narrowed role really does refuse the request, that a
 * denial reaches a session which is already open, and that the gates keeping
 * this out of an API token's reach actually hold.
 */
describe.skipIf(!dbReady())("permission tuning", () => {
  const prisma = testPrisma();
  const config = loadConfig({
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    ADMIN_TOKEN: "test-admin-token-0123456789",
    LOG_LEVEL: "error",
  });
  const log = createLogger("test-permissions", "error");
  let app: FastifyInstance;
  const root = { authorization: "Bearer test-admin-token-0123456789" };
  const csrf = { "x-requested-with": "publoader-dash" };

  beforeEach(async () => {
    await resetDb(prisma);
    app = buildServer(buildContext(prisma, config, log));
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  /** An approved account with a password, plus a live session cookie for it. */
  async function accountWithSession(
    email: string,
    role: "ADMIN" | "CONTRIBUTOR" | "OWNER",
  ): Promise<{ id: string; cookie: string }> {
    const password = "correct-horse-battery-staple";
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/admin/users",
      headers: root,
      payload: { email, role },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().user.id as string;

    const pw = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${id}/password`,
      headers: root,
      payload: { password },
    });
    expect(pw.statusCode).toBe(200);

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/admin/session",
      payload: { email, password },
    });
    expect(login.statusCode).toBe(200);
    const setCookie = login.headers["set-cookie"];
    const raw = (Array.isArray(setCookie) ? setCookie[0] : setCookie) ?? "";
    return { id, cookie: raw.split(";")[0] ?? "" };
  }

  const asSession = (cookie: string) => ({ cookie, ...csrf });

  async function mintToken(scopes: string[]): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/tokens",
      headers: root,
      payload: { name: `t-${scopes.join("-")}`, scopes },
    });
    expect(res.statusCode).toBe(201);
    return res.json().token as string;
  }

  // ---- the catalogue ----

  it("describes every scope and where each role stands", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/permissions", headers: root });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scopes.length).toBeGreaterThan(0);
    for (const scope of body.scopes) expect(scope.description).toBeTruthy();

    const owner = body.roles.find((r: { role: string }) => r.role === "OWNER");
    expect(owner.scopes).toEqual(["*"]);
    expect(owner.tunable).toBe(false);
    const admin = body.roles.find((r: { role: string }) => r.role === "ADMIN");
    expect(admin.custom).toBe(false);
    expect(admin.scopes).not.toContain("users:admin");
  });

  // ---- role baselines ----

  it("narrows a role, and the narrowing reaches a session already open", async () => {
    const { cookie } = await accountWithSession("narrowed@example.com", "ADMIN");

    // Before: a plain ADMIN may look at the worker fleet.
    const before = await app.inject({
      method: "GET",
      url: "/api/v1/admin/workers",
      headers: asSession(cookie),
    });
    expect(before.statusCode).toBe(200);

    const changed = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/permissions/roles/ADMIN",
      headers: root,
      payload: { scopes: ["stats:read", "runs:read"] },
    });
    expect(changed.statusCode).toBe(200);

    // No re-login: the same cookie is now refused for workers and kept for runs.
    const after = await app.inject({
      method: "GET",
      url: "/api/v1/admin/workers",
      headers: asSession(cookie),
    });
    expect(after.statusCode).toBe(403);
    expect(after.json().error).toContain("workers:read");

    const runs = await app.inject({ method: "GET", url: "/api/v1/admin/runs", headers: asSession(cookie) });
    expect(runs.statusCode).toBe(200);
  });

  it("resets a role back to the shipped default", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/v1/admin/permissions/roles/CONTRIBUTOR",
      headers: root,
      payload: { scopes: ["stats:read"] },
    });
    const reset = await app.inject({
      method: "DELETE",
      url: "/api/v1/admin/permissions/roles/CONTRIBUTOR",
      headers: root,
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().scopes).toContain("tracked:append");

    // Already default: nothing to undo, and saying so beats a silent 200.
    const again = await app.inject({
      method: "DELETE",
      url: "/api/v1/admin/permissions/roles/CONTRIBUTOR",
      headers: root,
    });
    expect(again.statusCode).toBe(409);
  });

  it("refuses to touch the OWNER baseline", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/permissions/roles/OWNER",
      headers: root,
      payload: { scopes: ["stats:read"] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain("wildcard");
  });

  it("rejects unknown scopes rather than silently dropping them", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/permissions/roles/ADMIN",
      headers: root,
      payload: { scopes: ["runs:read", "run:write", "nonsense"] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().invalid.sort()).toEqual(["nonsense", "run:write"]);
  });

  // ---- per-account tuning ----

  it("grants one contributor a scope their role does not carry", async () => {
    const { id, cookie } = await accountWithSession("curator@example.com", "CONTRIBUTOR");

    const before = await app.inject({ method: "GET", url: "/api/v1/admin/runs", headers: asSession(cookie) });
    expect(before.statusCode).toBe(403);

    const granted = await app.inject({
      method: "PUT",
      url: `/api/v1/admin/users/${id}/permissions`,
      headers: root,
      payload: { extraScopes: ["runs:read"], deniedScopes: [] },
    });
    expect(granted.statusCode).toBe(200);
    expect(granted.json().effective).toContain("runs:read");

    const after = await app.inject({ method: "GET", url: "/api/v1/admin/runs", headers: asSession(cookie) });
    expect(after.statusCode).toBe(200);
  });

  it("denies one admin a scope their role does carry", async () => {
    const { id, cookie } = await accountWithSession("restricted@example.com", "ADMIN");

    const denied = await app.inject({
      method: "PUT",
      url: `/api/v1/admin/users/${id}/permissions`,
      headers: root,
      payload: { extraScopes: [], deniedScopes: ["workers:read"] },
    });
    expect(denied.statusCode).toBe(200);

    const workers = await app.inject({
      method: "GET",
      url: "/api/v1/admin/workers",
      headers: asSession(cookie),
    });
    expect(workers.statusCode).toBe(403);

    // Denying the read takes the write with it — a write would imply the read.
    const effective: string[] = denied.json().effective;
    expect(effective).not.toContain("workers:write");
    // And the rest of the role is untouched.
    expect(effective).toContain("runs:write");
  });

  it("reports the parts a permission set was built from", async () => {
    const { id } = await accountWithSession("explained@example.com", "CONTRIBUTOR");
    await app.inject({
      method: "PUT",
      url: `/api/v1/admin/users/${id}/permissions`,
      headers: root,
      payload: { extraScopes: ["runs:read"], deniedScopes: ["untracked:write"] },
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/admin/users/${id}/permissions`,
      headers: root,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.baseline).toContain("tracked:append");
    expect(body.extraScopes).toEqual(["runs:read"]);
    expect(body.deniedScopes).toEqual(["untracked:write"]);
    expect(body.effective).toContain("runs:read");
    expect(body.effective).not.toContain("untracked:write");
    expect(body.tunable).toBe(true);
  });

  it("refuses a scope that is both granted and denied", async () => {
    const { id } = await accountWithSession("contradiction@example.com", "ADMIN");
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/admin/users/${id}/permissions`,
      headers: root,
      payload: { extraScopes: ["runs:write"], deniedScopes: ["runs:write"] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().scopes).toEqual(["runs:write"]);
  });

  it("refuses to tune an owner, whose scopes are the wildcard regardless", async () => {
    const { id } = await accountWithSession("boss@example.com", "OWNER");
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/admin/users/${id}/permissions`,
      headers: root,
      payload: { extraScopes: [], deniedScopes: ["bundles:write"] },
    });
    expect(res.statusCode).toBe(409);
  });

  it("drops an account's tuning when it is promoted to owner", async () => {
    const { id } = await accountWithSession("promoted@example.com", "ADMIN");
    await app.inject({
      method: "PUT",
      url: `/api/v1/admin/users/${id}/permissions`,
      headers: root,
      payload: { extraScopes: [], deniedScopes: ["bundles:write"] },
    });
    const promoted = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${id}/role`,
      headers: root,
      payload: { role: "OWNER" },
    });
    expect(promoted.statusCode).toBe(200);

    // Stale denials must not lie in wait for a later demotion.
    const after = await app.inject({
      method: "GET",
      url: `/api/v1/admin/users/${id}/permissions`,
      headers: root,
    });
    expect(after.json().deniedScopes).toEqual([]);
  });

  // ---- who may do any of this ----

  it("lets a users:admin token read the role baselines but change nothing", async () => {
    const token = await mintToken(["users:admin"]);
    const headers = { authorization: `Bearer ${token}` };

    const read = await app.inject({ method: "GET", url: "/api/v1/admin/permissions", headers });
    expect(read.statusCode).toBe(200);

    // An api token is never OWNER, so it can never widen the role it sits in.
    const write = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/permissions/roles/ADMIN",
      headers,
      payload: { scopes: ["*"] },
    });
    expect(write.statusCode).toBe(403);
    expect(write.json().error).toContain("owner");
  });

  it("keeps a token without users:admin out entirely", async () => {
    const token = await mintToken(["runs:write", "stats:read"]);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admin/permissions",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("users:admin");
  });

  it("keeps a plain admin's session out of permission administration", async () => {
    const { cookie } = await accountWithSession("nosy@example.com", "ADMIN");
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admin/permissions",
      headers: asSession(cookie),
    });
    expect(res.statusCode).toBe(403);
  });

  it("cannot be used to grant an admin their way into permission administration", async () => {
    const { id, cookie } = await accountWithSession("ambitious@example.com", "ADMIN");
    // An owner may hand out `users:admin` — that is a real, deliberate grant.
    const granted = await app.inject({
      method: "PUT",
      url: `/api/v1/admin/users/${id}/permissions`,
      headers: root,
      payload: { extraScopes: ["users:admin"], deniedScopes: [] },
    });
    expect(granted.statusCode).toBe(200);

    // The scope is held, so the catalogue opens...
    const read = await app.inject({
      method: "GET",
      url: "/api/v1/admin/permissions",
      headers: asSession(cookie),
    });
    expect(read.statusCode).toBe(200);

    // ...but the role gate still stands between them and granting anything.
    const write = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/permissions/roles/ADMIN",
      headers: asSession(cookie),
      payload: { scopes: ["*"] },
    });
    expect(write.statusCode).toBe(403);
  });

  it("records every change in the audit log", async () => {
    const { id } = await accountWithSession("audited@example.com", "ADMIN");
    await app.inject({
      method: "PUT",
      url: "/api/v1/admin/permissions/roles/ADMIN",
      headers: root,
      payload: { scopes: ["stats:read"] },
    });
    await app.inject({
      method: "PUT",
      url: `/api/v1/admin/users/${id}/permissions`,
      headers: root,
      payload: { extraScopes: ["runs:read"], deniedScopes: [] },
    });

    const audit = await app.inject({ method: "GET", url: "/api/v1/admin/audit", headers: root });
    const actions = audit.json().events.map((e: { action: string }) => e.action);
    expect(actions).toContain("permissions.role");
    expect(actions).toContain("permissions.user");
  });
});
