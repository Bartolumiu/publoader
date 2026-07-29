import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import { buildContext, type AppContext } from "../../src/core/api/context.js";
import { buildServer } from "../../src/core/api/server.js";
import { closeDb, dbReady, resetDb, testPrisma } from "./db.js";

/**
 * Dashboard accounts, sessions, and asset serving. The properties under test
 * are the ones that keep a browser-reachable admin surface safe: the cookie is
 * HttpOnly/SameSite=Strict and backed by a revocable row, cookie-authed writes
 * need a header no cross-site form can set, login is rate limited, role
 * boundaries hold, and the bearer audience is untouched.
 */
describe.skipIf(!dbReady())("dashboard sessions, accounts, and assets", () => {
  const prisma = testPrisma();
  const ADMIN_TOKEN = "test-admin-token-0123456789";
  const OWNER_EMAIL = "owner@example.com";
  const config = loadConfig({
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    ADMIN_TOKEN,
    SESSION_SECRET: "test-session-secret-0123456789abcdef",
    DASH_OWNER_EMAIL: OWNER_EMAIL,
    LOG_LEVEL: "error",
  });
  const log = createLogger("test-dashboard", "error");
  let app: FastifyInstance;
  let ctx: AppContext;

  const dash = { "x-requested-with": "publoader-dash" };
  const PASSWORD = "correct-horse-battery-staple";

  beforeEach(async () => {
    await resetDb(prisma);
    ctx = buildContext(prisma, config, log);
    app = buildServer(ctx);
    await app.ready();
    // Mirrors what services/api.ts does at startup.
    await ctx.adminUsers.ensureOwner(config.dashOwnerEmail);
  });
  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  const cookieFrom = (res: { cookies: { name: string; value: string }[] }): string => {
    const cookie = res.cookies.find((c) => c.name === "publoader_session");
    expect(cookie).toBeDefined();
    return `publoader_session=${cookie!.value}`;
  };

  /** Break-glass login: the admin token, bound to the seeded owner account. */
  async function loginWithToken(actor = "tester"): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/session",
      payload: { token: ADMIN_TOKEN, actor },
    });
    expect(res.statusCode).toBe(200);
    return cookieFrom(res);
  }

  const loginWithPassword = (email: string, password: string) =>
    app.inject({ method: "POST", url: "/api/v1/admin/session", payload: { email, password } });

  // ---- seeding & login methods ----

  it("seeds an approved owner account with no credentials", async () => {
    const owner = await prisma.adminUser.findUniqueOrThrow({ where: { email: OWNER_EMAIL } });
    expect(owner).toMatchObject({ role: "OWNER", approved: true, passwordHash: null, discordId: null });

    // Seeding is idempotent and repairs a demoted or unapproved owner.
    await prisma.adminUser.update({ where: { id: owner.id }, data: { role: "ADMIN", approved: false } });
    const repaired = await ctx.adminUsers.ensureOwner(OWNER_EMAIL);
    expect(repaired).toMatchObject({ id: owner.id, role: "OWNER", approved: true });
    expect(await prisma.adminUser.count()).toBe(1);
  });

  it("advertises only the login methods this deployment offers", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/session/methods" });
    expect(res.statusCode).toBe(200);
    // No DISCORD_CLIENT_ID in this config, so the button must stay hidden.
    expect(res.json()).toMatchObject({ discord: false, signups: false, password: true });
  });

  // ---- session lifecycle ----

  it("logs in with the admin token, authenticates reads and writes, and logs out", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/session",
      payload: { token: ADMIN_TOKEN, actor: "tester" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, actor: "tester", role: "OWNER", email: OWNER_EMAIL });

    const setCookie = String(res.headers["set-cookie"]);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");

    const cookie = cookieFrom(res);
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/stats", headers: { cookie } })).statusCode).toBe(200);

    const me = await app.inject({ method: "GET", url: "/api/v1/admin/session", headers: { cookie } });
    expect(me.json()).toMatchObject({ actor: "tester", role: "OWNER", hasPassword: false });

    const write = await app.inject({
      method: "POST",
      url: "/api/v1/admin/resume",
      headers: { cookie, ...dash },
      payload: {},
    });
    expect(write.statusCode).toBe(200);

    const out = await app.inject({ method: "DELETE", url: "/api/v1/admin/session", headers: { cookie, ...dash } });
    expect(out.statusCode).toBe(200);
    expect(String(out.headers["set-cookie"])).toContain("Max-Age=0");

    // Logout revokes the row, so the cookie is dead even if the browser keeps it.
    const after = await app.inject({ method: "GET", url: "/api/v1/admin/stats", headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it("round-trips an email + password login after the owner sets a password", async () => {
    const cookie = await loginWithToken();
    const owner = await prisma.adminUser.findUniqueOrThrow({ where: { email: OWNER_EMAIL } });

    const set = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${owner.id}/password`,
      headers: { cookie, ...dash },
      payload: { password: PASSWORD },
    });
    expect(set.statusCode).toBe(200);

    const login = await loginWithPassword(OWNER_EMAIL, PASSWORD);
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ role: "OWNER", email: OWNER_EMAIL });
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/admin/stats", headers: { cookie: cookieFrom(login) } }))
        .statusCode,
    ).toBe(200);

    const wrong = await loginWithPassword(OWNER_EMAIL, "not-the-password");
    expect(wrong.statusCode).toBe(401);
    // Same message whether the account exists or the password is wrong.
    expect(wrong.json().error).toBe("invalid email or password");
    const missing = await loginWithPassword("nobody@example.com", PASSWORD);
    expect(missing.json().error).toBe("invalid email or password");
  });

  it("rejects a correct password on an unapproved account", async () => {
    const user = await prisma.adminUser.create({
      data: { email: "pending@example.com", role: "ADMIN", approved: false },
    });
    await ctx.adminUsers.setPassword(user.id, PASSWORD);

    const login = await loginWithPassword("pending@example.com", PASSWORD);
    expect(login.statusCode).toBe(403);
    expect(login.json().error).toContain("awaiting approval");
    expect(await prisma.adminSession.count()).toBe(0);
  });

  it("revoking a session kills it immediately", async () => {
    const cookie = await loginWithToken();
    const session = await prisma.adminSession.findFirstOrThrow();

    const list = await app.inject({ method: "GET", url: "/api/v1/admin/sessions", headers: { cookie } });
    expect(list.json().sessions).toHaveLength(1);

    const revoke = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/sessions/${session.id}`,
      headers: { cookie, ...dash },
    });
    expect(revoke.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/stats", headers: { cookie } })).statusCode).toBe(401);
  });

  // ---- accounts and roles ----

  it("confines account administration to owners", async () => {
    const ownerCookie = await loginWithToken();

    const invited = await app.inject({
      method: "POST",
      url: "/api/v1/admin/users",
      headers: { cookie: ownerCookie, ...dash },
      payload: { email: "admin@example.com", role: "ADMIN" },
    });
    expect(invited.statusCode).toBe(201);
    const adminId = invited.json().user.id;
    // The hash must never appear in an API response.
    expect(invited.json().user.passwordHash).toBeUndefined();

    await ctx.adminUsers.setPassword(adminId, PASSWORD);
    const adminCookie = cookieFrom(await loginWithPassword("admin@example.com", PASSWORD));

    // An ADMIN has full control-plane authority...
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/admin/stats", headers: { cookie: adminCookie } })).statusCode,
    ).toBe(200);
    // ...but cannot see or change who else has it.
    for (const [method, url] of [
      ["GET", "/api/v1/admin/users"],
      ["GET", "/api/v1/admin/sessions"],
      ["GET", "/api/v1/admin/settings/signups"],
    ] as const) {
      const res = await app.inject({ method, url, headers: { cookie: adminCookie } });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("owner role required");
    }
    const escalate = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${adminId}/role`,
      headers: { cookie: adminCookie, ...dash },
      payload: { role: "OWNER" },
    });
    expect(escalate.statusCode).toBe(403);

    // An ADMIN may set their own password but not somebody else's.
    const owner = await prisma.adminUser.findUniqueOrThrow({ where: { email: OWNER_EMAIL } });
    const other = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${owner.id}/password`,
      headers: { cookie: adminCookie, ...dash },
      payload: { password: "another-long-password" },
    });
    expect(other.statusCode).toBe(403);
    const own = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${adminId}/password`,
      headers: { cookie: adminCookie, ...dash },
      payload: { password: "another-long-password" },
    });
    expect(own.statusCode).toBe(200);
  });

  it("refuses to remove the last owner and enforces the password policy", async () => {
    const cookie = await loginWithToken();
    const owner = await prisma.adminUser.findUniqueOrThrow({ where: { email: OWNER_EMAIL } });

    const demote = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${owner.id}/role`,
      headers: { cookie, ...dash },
      payload: { role: "ADMIN" },
    });
    expect(demote.statusCode).toBe(409);
    const remove = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/users/${owner.id}`,
      headers: { cookie, ...dash },
    });
    expect(remove.statusCode).toBe(409);
    expect(remove.json().error).toContain("last owner");

    const short = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${owner.id}/password`,
      headers: { cookie, ...dash },
      payload: { password: "short" },
    });
    expect(short.statusCode).toBe(400);
    expect(short.json().error).toContain("12 characters");
  });

  it("approves a pending account and toggles the signup gate", async () => {
    const cookie = await loginWithToken();
    const pending = await prisma.adminUser.create({
      data: { email: "new@example.com", role: "ADMIN", approved: false },
    });

    const approve = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${pending.id}/approve`,
      headers: { cookie, ...dash },
      payload: {},
    });
    expect(approve.statusCode).toBe(200);
    // Approving twice is a conflict, not a silent no-op.
    const again = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${pending.id}/approve`,
      headers: { cookie, ...dash },
      payload: {},
    });
    expect(again.statusCode).toBe(409);

    const before = await app.inject({ method: "GET", url: "/api/v1/admin/settings/signups", headers: { cookie } });
    expect(before.json()).toMatchObject({ enabled: false });
    const on = await app.inject({
      method: "POST",
      url: "/api/v1/admin/settings/signups",
      headers: { cookie, ...dash },
      payload: { enabled: true },
    });
    expect(on.json()).toMatchObject({ ok: true, enabled: true });
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/session/methods" })).json().signups).toBe(true);
  });

  // ---- CSRF, attribution, rate limits, forgery ----

  it("requires the CSRF header on cookie-authenticated writes but not on reads", async () => {
    const cookie = await loginWithToken();

    const noHeader = await app.inject({
      method: "POST",
      url: "/api/v1/admin/pause",
      headers: { cookie },
      payload: { minutes: 5 },
    });
    expect(noHeader.statusCode).toBe(403);
    expect(noHeader.json().error).toContain("x-requested-with");
    expect(await prisma.setting.count({ where: { key: "pause_until" } })).toBe(0);

    const wrongValue = await app.inject({
      method: "POST",
      url: "/api/v1/admin/pause",
      headers: { cookie, "x-requested-with": "XMLHttpRequest" },
      payload: { minutes: 5 },
    });
    expect(wrongValue.statusCode).toBe(403);

    const withHeader = await app.inject({
      method: "POST",
      url: "/api/v1/admin/pause",
      headers: { cookie, ...dash },
      payload: { minutes: 5 },
    });
    expect(withHeader.statusCode).toBe(200);
    expect(await prisma.setting.count({ where: { key: "pause_until" } })).toBe(1);

    const read = await app.inject({ method: "GET", url: "/api/v1/admin/audit", headers: { cookie } });
    expect(read.statusCode).toBe(200);
  });

  it("attributes audited actions to the logged-in operator without an x-actor header", async () => {
    const cookie = await loginWithToken("ardax");
    await app.inject({ method: "POST", url: "/api/v1/admin/resume", headers: { cookie, ...dash }, payload: {} });
    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { action: "platform.resume" },
      orderBy: { createdAt: "desc" },
    });
    expect(event.actor).toBe("user:ardax");
  });

  it("rejects a wrong token and rate limits repeated login attempts", async () => {
    const attempt = () =>
      app.inject({ method: "POST", url: "/api/v1/admin/session", payload: { token: "wrong-token", actor: "mallory" } });

    // Bucket capacity is 5; the sixth attempt inside the same minute is shed.
    for (let i = 0; i < 5; i++) {
      expect((await attempt()).statusCode).toBe(401);
    }
    expect((await attempt()).statusCode).toBe(429);
    expect(await prisma.auditEvent.count({ where: { action: "session.login.rejected" } })).toBe(5);
  });

  it("rejects forged, tampered, and expired session cookies", async () => {
    const cookie = await loginWithToken();
    const value = cookie.slice("publoader_session=".length);
    const dot = value.indexOf(".");
    const id = value.slice(0, dot);
    const secret = value.slice(dot + 1);

    for (const forged of [
      "publoader_session=not-a-cookie",
      `publoader_session=${id}.${"a".repeat(secret.length)}`,
      `publoader_session=00000000-0000-4000-8000-000000000000.${secret}`,
      // A session id alone is not a credential: only its hash is stored.
      `publoader_session=${id}.`,
    ]) {
      const res = await app.inject({ method: "GET", url: "/api/v1/admin/stats", headers: { cookie: forged } });
      expect(res.statusCode).toBe(401);
    }

    await prisma.adminSession.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/stats", headers: { cookie } })).statusCode).toBe(401);
  });

  it("marks the cookie Secure when the proxy reports https", async () => {
    const plain = await app.inject({
      method: "POST",
      url: "/api/v1/admin/session",
      payload: { token: ADMIN_TOKEN, actor: "tester" },
    });
    expect(String(plain.headers["set-cookie"])).not.toContain("Secure");

    const proxied = await app.inject({
      method: "POST",
      url: "/api/v1/admin/session",
      headers: { "x-forwarded-proto": "https" },
      payload: { token: ADMIN_TOKEN, actor: "tester" },
    });
    expect(String(proxied.headers["set-cookie"])).toContain("Secure");
  });

  it("leaves the bearer audience unchanged and treats it as owner", async () => {
    const bearer = { authorization: `Bearer ${ADMIN_TOKEN}` };

    // No CSRF header required: a bearer token is not attached automatically.
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/admin/resume", headers: bearer, payload: {} })).statusCode,
    ).toBe(200);
    // Owner-equivalent, so it reaches the account endpoints.
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/users", headers: bearer })).statusCode).toBe(200);

    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/admin/stats",
          headers: { authorization: "Bearer nope-nope-nope-nope" },
        })
      ).statusCode,
    ).toBe(401);

    // A bad bearer token must not fall through to a valid cookie.
    const cookie = await loginWithToken();
    const mixed = await app.inject({
      method: "GET",
      url: "/api/v1/admin/stats",
      headers: { cookie, authorization: "Bearer nope-nope-nope-nope" },
    });
    expect(mixed.statusCode).toBe(401);
  });

  // ---- assets ----

  it("serves the dashboard at the domain root and at /dash under a strict CSP", async () => {
    for (const url of ["/", "/dash"]) {
      const page = await app.inject({ method: "GET", url });
      expect(page.statusCode).toBe(200);
      expect(page.headers["content-type"]).toContain("text/html");
      expect(page.body).toContain("<title>publoader");
      expect(page.body).toContain("/dash/app.js");

      const csp = String(page.headers["content-security-policy"]);
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain("unsafe-inline");
      expect(page.headers["x-frame-options"]).toBe("DENY");
    }

    const script = await app.inject({ method: "GET", url: "/dash/app.js" });
    expect(script.statusCode).toBe(200);
    expect(script.headers["content-type"]).toContain("javascript");
    // No inline handlers and no innerHTML sink: the CSP would break the former,
    // and the latter is the XSS vector this dashboard avoids by rendering every
    // operator-supplied string with textContent.
    expect(script.body).not.toMatch(/\.innerHTML\s*=/);
    expect(script.body).not.toMatch(/\son[a-z]+\s*=\s*"/);

    const styles = await app.inject({ method: "GET", url: "/dash/style.css" });
    expect(styles.statusCode).toBe(200);
    expect(styles.headers["content-type"]).toContain("text/css");
  });

  it("names every operator section it can render in the no-script fallback", async () => {
    // Every view is built client-side, so a browser with scripting off sees only
    // the shell. The <noscript> block is what tells that operator which sections
    // exist — and it is derived from nothing, so it goes stale silently.
    //
    // The tab labels are read out of the served app.js rather than hard-coded
    // here: the point is that the two halves agree, and pinning the list in the
    // test would just move the staleness rather than catch it.
    const page = await app.inject({ method: "GET", url: "/dash" });
    const script = await app.inject({ method: "GET", url: "/dash/app.js" });

    const registry = /const TABS = \[(.*?)\n\];/s.exec(script.body);
    expect(registry, "app.js should declare a TABS registry").not.toBeNull();
    const labels = [...registry![1]!.matchAll(/^\s*\["[a-z]+", "([^"]+)"/gm)].map((m) => m[1]!);
    expect(labels.length).toBeGreaterThanOrEqual(10);

    for (const label of labels) {
      expect(page.body, `the noscript fallback should name the ${label} section`).toContain(label);
    }

    // Credential minting and account administration need the OWNER role, not a
    // scope — a wildcard api token holds users:admin but is never OWNER.
    expect(script.body).toContain('["tokens", "Tokens", { owner: true }]');
    expect(script.body).toContain('["users", "Users", { owner: true }]');

    // A tab with no endpoint wired to it renders an empty panel; these are the
    // calls behind the sections this dashboard grew for queue and session triage.
    for (const call of [
      "/whoami",
      "/upload-tasks",
      "/upload-tasks/requeue-stale",
      "/mangadex/auth",
      "/mangadex/auth/clear",
      "/tokens/scopes",
    ]) {
      expect(script.body, `${call} should be called by the dashboard`).toContain(call);
    }
  });

  it("does not let the root mount shadow the internal endpoints", async () => {
    expect((await app.inject({ method: "GET", url: "/healthz" })).json()).toMatchObject({ ok: true });
    // /metrics is served only on the internal METRICS_PORT: the public
    // hostname forwards every path, so it must not exist here.
    expect((await app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(404);
    // There is no root-level wildcard, so an unknown top-level path still 404s.
    expect((await app.inject({ method: "GET", url: "/not-a-page" })).statusCode).toBe(404);

    // The wildcard under /dash indexes a fixed in-memory map by basename, so no
    // path the client can spell reaches the filesystem.
    for (const url of ["/dash/%2e%2e/%2e%2e/package.json", "/dash/nested/path/style.css", "/dash/dashboard.ts"]) {
      const res = await app.inject({ method: "GET", url });
      expect([200, 404]).toContain(res.statusCode);
      expect(res.body).not.toContain("publoader-platform");
      expect(res.body).not.toContain("registerDashboardRoutes");
    }
  });
});
