import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import { buildContext, type AppContext } from "../../src/core/api/context.js";
import { buildServer } from "../../src/core/api/server.js";
import { closeDb, dbReady, resetDb, testPrisma } from "./db.js";

/**
 * Linking Discord onto an account that already has a password.
 *
 * The login flow can only attach Discord to an existing account when Discord's
 * *verified* email happens to equal the operator's — which leaves everyone
 * whose Discord address differs with no way to hold both credentials. This is
 * that path, and the session is the authorisation, so the addresses need not
 * match.
 *
 * The properties under test are the ones that make that safe: the round-trip is
 * bound to the account that started it, a Discord identity cannot be attached
 * to two accounts, and unlinking cannot strand an account with no way in.
 */
describe.skipIf(!dbReady())("linking a Discord account", () => {
  const prisma = testPrisma();
  const config = loadConfig({
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    ADMIN_TOKEN: "test-admin-token-0123456789",
    DASH_PUBLIC_URL: "https://publoader.test",
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_CLIENT_SECRET: "client-secret",
    SESSION_SECRET: "session-secret-that-is-long-enough-x",
    RESEND_API_KEY: "",
    LOG_LEVEL: "error",
  });
  const log = createLogger("test-discord-link", "error");
  const root = { authorization: "Bearer test-admin-token-0123456789" };

  let app: FastifyInstance;
  let ctx: AppContext;

  beforeEach(async () => {
    await resetDb(prisma);
    ctx = buildContext(prisma, config, log);
    app = buildServer(ctx);
    await app.ready();
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  /** Stand in for Discord's token and identity endpoints. */
  const stubDiscord = (identity: { id: string; username: string; email?: string; verified?: boolean }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/oauth2/token")) {
          return new Response(JSON.stringify({ access_token: "at_1", token_type: "Bearer" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify(identity), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
  };

  /** An approved account with a password, and a live session cookie for it. */
  const signedInAccount = async (email: string) => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/admin/users",
      headers: root,
      payload: { email, role: "ADMIN" },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().user.id;
    await ctx.adminUsers.setPassword(id, "a-long-enough-password");

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/admin/session",
      payload: { email, password: "a-long-enough-password" },
    });
    expect(login.statusCode).toBe(200);
    return { id, cookie: String(login.headers["set-cookie"]).split(";")[0]! };
  };

  /** Walk the redirect to Discord and hand back what the callback needs. */
  const beginLink = async (cookie: string) => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admin/oauth/discord/link",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(302);
    const state = new URL(res.headers.location as string).searchParams.get("state")!;
    const stateCookie = String(res.headers["set-cookie"]).split(";")[0]!;
    return { state, stateCookie };
  };

  const callback = (state: string, cookies: string[]) =>
    app.inject({
      method: "GET",
      url: `/api/v1/admin/oauth/discord/callback?code=auth-code&state=${encodeURIComponent(state)}`,
      headers: { cookie: cookies.join("; ") },
    });

  it("attaches Discord to the signed-in account even when the addresses differ", async () => {
    const { id, cookie } = await signedInAccount("ops@example.com");
    const { state, stateCookie } = await beginLink(cookie);
    // Deliberately a different address: the session is the authorisation here.
    stubDiscord({ id: "d-1", username: "ardax", email: "someone-else@example.com", verified: true });

    const res = await callback(state, [cookie, stateCookie]);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Discord linked");

    const user = await ctx.adminUsers.byId(id);
    expect(user?.discordId).toBe("d-1");
    expect(user?.discordUsername).toBe("ardax");
  });

  it("lets that account sign in both ways afterwards", async () => {
    const { cookie } = await signedInAccount("ops@example.com");
    const { state, stateCookie } = await beginLink(cookie);
    stubDiscord({ id: "d-1", username: "ardax", email: "someone-else@example.com", verified: true });
    await callback(state, [cookie, stateCookie]);

    // 1. Discord, via the login flow — matched on the linked id, not the email.
    const start = await app.inject({ method: "GET", url: "/api/v1/admin/oauth/discord/start" });
    const loginState = new URL(start.headers.location as string).searchParams.get("state")!;
    const loginStateCookie = String(start.headers["set-cookie"]).split(";")[0]!;
    const viaDiscord = await callback(loginState, [loginStateCookie]);
    expect(viaDiscord.statusCode).toBe(302);
    expect(String(viaDiscord.headers["set-cookie"])).toContain("publoader_session=");

    // 2. Email and password, unchanged.
    const viaPassword = await app.inject({
      method: "POST",
      url: "/api/v1/admin/session",
      payload: { email: "ops@example.com", password: "a-long-enough-password" },
    });
    expect(viaPassword.statusCode).toBe(200);
  });

  it("refuses a Discord identity that is already on another account", async () => {
    const first = await signedInAccount("one@example.com");
    const begun = await beginLink(first.cookie);
    stubDiscord({ id: "d-1", username: "ardax", email: "d@example.com", verified: true });
    expect((await callback(begun.state, [first.cookie, begun.stateCookie])).statusCode).toBe(200);

    const second = await signedInAccount("two@example.com");
    const again = await beginLink(second.cookie);
    const res = await callback(again.state, [second.cookie, again.stateCookie]);

    expect(res.statusCode).toBe(409);
    expect(res.body).toContain("already attached");
    expect((await ctx.adminUsers.byId(second.id))?.discordId).toBeNull();
  });

  it("will not start a link without a session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/oauth/discord/link" });
    expect(res.statusCode).toBe(401);
  });

  it("will not finish a link whose session has gone", async () => {
    const { id, cookie } = await signedInAccount("ops@example.com");
    const { state, stateCookie } = await beginLink(cookie);
    stubDiscord({ id: "d-1", username: "ardax", email: "d@example.com", verified: true });

    // The state cookie is signed and still valid; the session is not present.
    const res = await callback(state, [stateCookie]);
    expect(res.statusCode).toBe(401);
    expect((await ctx.adminUsers.byId(id))?.discordId).toBeNull();
  });

  it("will not let a login round-trip be finished as a link", async () => {
    const { id, cookie } = await signedInAccount("ops@example.com");
    // State minted by the LOGIN entry point, replayed with a session present.
    const start = await app.inject({ method: "GET", url: "/api/v1/admin/oauth/discord/start" });
    const state = new URL(start.headers.location as string).searchParams.get("state")!;
    const stateCookie = String(start.headers["set-cookie"]).split(";")[0]!;
    stubDiscord({ id: "d-1", username: "ardax", email: "other@example.com", verified: false });

    const res = await callback(state, [cookie, stateCookie]);
    // Treated as the login it claimed to be — and an unverified email cannot
    // claim an account, so nothing is linked to anyone.
    expect(res.statusCode).toBe(403);
    expect((await ctx.adminUsers.byId(id))?.discordId).toBeNull();
  });

  // ---- unlinking ----

  it("unlinks on request, leaving the password behind", async () => {
    const { id, cookie } = await signedInAccount("ops@example.com");
    const { state, stateCookie } = await beginLink(cookie);
    stubDiscord({ id: "d-1", username: "ardax", email: "d@example.com", verified: true });
    await callback(state, [cookie, stateCookie]);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/users/${id}/discord`,
      headers: { cookie, "x-requested-with": "publoader-dash" },
    });
    expect(res.statusCode).toBe(200);
    expect((await ctx.adminUsers.byId(id))?.discordId).toBeNull();

    // The Discord identity is free to attach elsewhere now.
    const other = await signedInAccount("two@example.com");
    const again = await beginLink(other.cookie);
    expect((await callback(again.state, [other.cookie, again.stateCookie])).statusCode).toBe(200);
  });

  it("refuses to unlink the only way into an account", async () => {
    // Discord-only, and no mailer configured: removing this strands the account.
    const user = await ctx.adminUsers.createFromDiscord({
      email: "discord-only@example.com",
      discordId: "d-9",
      discordUsername: "solo",
    });
    await ctx.adminUsers.approve(user.id);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/users/${user.id}/discord`,
      headers: root,
    });
    expect(res.statusCode).toBe(409);
    expect((await ctx.adminUsers.byId(user.id))?.discordId).toBe("d-9");
  });

  it("will not let one operator unlink another's Discord", async () => {
    const victim = await signedInAccount("victim@example.com");
    const begun = await beginLink(victim.cookie);
    stubDiscord({ id: "d-1", username: "ardax", email: "d@example.com", verified: true });
    await callback(begun.state, [victim.cookie, begun.stateCookie]);

    const attacker = await signedInAccount("nosy@example.com");
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/users/${victim.id}/discord`,
      headers: { cookie: attacker.cookie, "x-requested-with": "publoader-dash" },
    });
    expect(res.statusCode).toBe(403);
    expect((await ctx.adminUsers.byId(victim.id))?.discordId).toBe("d-1");
  });
});
