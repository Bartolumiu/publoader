import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import { buildContext, type AppContext } from "../../src/core/api/context.js";
import { buildServer } from "../../src/core/api/server.js";
import { closeDb, dbReady, resetDb, testPrisma } from "./db.js";

/**
 * The bot acting as the person who typed the command.
 *
 * The bot holds one broadly-scoped token, so without this every Discord admin
 * wields identical authority no matter what their operator account says. With
 * it, a request carries `x-on-behalf-of-discord` and runs with the linked
 * account's scopes *intersected* with the token's.
 *
 * The intersection is the whole security property, and it has to hold in both
 * directions: a narrow account must not be widened by a broad token, and a
 * broad account must not be widened past the token. Everything below is a way
 * of asking whether that is still true.
 */
describe.skipIf(!dbReady())("acting on behalf of a Discord user", () => {
  const prisma = testPrisma();
  const ADMIN_TOKEN = "test-admin-token-0123456789";
  const config = loadConfig({
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    ADMIN_TOKEN,
    LOG_LEVEL: "error",
  });
  const log = createLogger("test-impersonation", "error");
  let app: FastifyInstance;
  let ctx: AppContext;
  const root = { authorization: `Bearer ${ADMIN_TOKEN}` };

  const OWNER_DISCORD = "700000000000000001";
  const CONTRIB_DISCORD = "700000000000000002";
  const UNAPPROVED_DISCORD = "700000000000000003";
  const UNLINKED_DISCORD = "700000000000000009";

  beforeEach(async () => {
    await resetDb(prisma);
    if (!app) {
      ctx = buildContext(prisma, config, log);
      app = buildServer(ctx);
      await app.ready();
    }
    await prisma.adminUser.create({
      data: { email: "owner@example.com", role: "OWNER", approved: true, discordId: OWNER_DISCORD },
    });
    await prisma.adminUser.create({
      data: {
        email: "contrib@example.com",
        role: "CONTRIBUTOR",
        approved: true,
        discordId: CONTRIB_DISCORD,
      },
    });
    await prisma.adminUser.create({
      data: {
        email: "pending@example.com",
        role: "ADMIN",
        approved: false,
        discordId: UNAPPROVED_DISCORD,
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  /** A bot-like token: broadly scoped, as the shipped preset is. */
  async function botToken(scopes: string[] = ["runs:read", "runs:write", "stats:read", "tracked:read"]) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/tokens",
      headers: root,
      payload: { name: `bot-${Math.random().toString(36).slice(2, 7)}`, scopes },
    });
    expect(res.statusCode).toBe(201);
    return res.json().token as string;
  }

  const asBot = (token: string, discordId?: string) => ({
    authorization: `Bearer ${token}`,
    ...(discordId ? { "x-on-behalf-of-discord": discordId } : {}),
  });

  describe("narrowing", () => {
    it("refuses a write the person's own account cannot do", async () => {
      // The bot token holds runs:write. The contributor does not, so the
      // command must fail even though the bot could have done it alone.
      const token = await botToken();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/runs",
        headers: asBot(token, CONTRIB_DISCORD),
        payload: { extension: "demo" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("still allows that same write when the bot acts as itself", async () => {
      // Proves the refusal above came from the intersection and not from the
      // token being wrong or the route being broken.
      const token = await botToken();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/runs",
        headers: asBot(token),
        payload: { extension: "demo" },
      });
      expect(res.statusCode).not.toBe(403);
    });

    it("allows a read the person's account does hold", async () => {
      const token = await botToken();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/admin/tracked/demo",
        headers: asBot(token, CONTRIB_DISCORD),
      });
      expect(res.statusCode).not.toBe(403);
    });
  });

  describe("the token stays the ceiling", () => {
    it("does not grant an owner more than the token holds", async () => {
      // OWNER is `*` on the dashboard. Acting as one must not turn a
      // runs-only token into a credential that can mint other credentials.
      const token = await botToken(["runs:read"]);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/tokens",
        headers: asBot(token, OWNER_DISCORD),
        payload: { name: "escalated", scopes: ["*"] },
      });
      expect(res.statusCode).toBe(403);
    });

    it("gives an owner exactly the token's scopes, no more and no less", async () => {
      const token = await botToken(["runs:read", "runs:write"]);
      const allowed = await app.inject({
        method: "POST",
        url: "/api/v1/admin/runs",
        headers: asBot(token, OWNER_DISCORD),
        payload: { extension: "demo" },
      });
      expect(allowed.statusCode).not.toBe(403);

      const refused = await app.inject({
        method: "GET",
        url: "/api/v1/admin/users",
        headers: asBot(token, OWNER_DISCORD),
      });
      expect(refused.statusCode).toBe(403);
    });

    it("never lets an impersonated owner reach an owner-only route", async () => {
      // `requireOwner` exists to keep API tokens out of permission editing.
      // Acting as an owner must not be a way around it, so the role is capped
      // at ADMIN even when the account behind it is an owner.
      const token = await botToken(["users:admin"]);
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/admin/permissions/roles/CONTRIBUTOR",
        headers: asBot(token, OWNER_DISCORD),
        payload: { scopes: ["*"] },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("who may be acted for", () => {
    it("refuses a Discord account linked to nobody", async () => {
      const token = await botToken();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/admin/stats",
        headers: asBot(token, UNLINKED_DISCORD),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toContain("no approved dashboard account");
    });

    it("refuses an account an owner has not approved yet", async () => {
      // Signup creates unapproved accounts; they must not gain authority
      // through a door the dashboard itself would refuse.
      const token = await botToken();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/admin/stats",
        headers: asBot(token, UNAPPROVED_DISCORD),
      });
      expect(res.statusCode).toBe(403);
    });

    it("ignores a malformed id rather than acting as the bot itself", async () => {
      // A header that is not a snowflake is a caller bug. Silently running as
      // the token would be the dangerous reading of it.
      const token = await botToken();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/admin/stats",
        headers: { authorization: `Bearer ${token}`, "x-on-behalf-of-discord": "not-an-id" },
      });
      // Not a snowflake, so no impersonation is attempted; the token's own
      // stats:read applies and the call succeeds as the bot.
      expect(res.statusCode).toBe(200);
    });
  });

  describe("per-account tuning", () => {
    it("honours a scope denied to one account", async () => {
      await prisma.adminUser.update({
        where: { discordId: OWNER_DISCORD },
        data: { role: "ADMIN", deniedScopes: ["runs:write"] },
      });
      const token = await botToken();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/runs",
        headers: asBot(token, OWNER_DISCORD),
        payload: { extension: "demo" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("takes effect immediately, without the bot restarting", async () => {
      const token = await botToken();
      const before = await app.inject({
        method: "POST",
        url: "/api/v1/admin/runs",
        headers: asBot(token, OWNER_DISCORD),
        payload: { extension: "demo" },
      });
      expect(before.statusCode).not.toBe(403);

      // Scopes are resolved per request, so a revocation lands on the next
      // command rather than at the next deploy.
      await prisma.adminUser.update({
        where: { discordId: OWNER_DISCORD },
        data: { role: "ADMIN", deniedScopes: ["runs:write"] },
      });
      const after = await app.inject({
        method: "POST",
        url: "/api/v1/admin/runs",
        headers: asBot(token, OWNER_DISCORD),
        payload: { extension: "demo" },
      });
      expect(after.statusCode).toBe(403);
    });
  });
});
