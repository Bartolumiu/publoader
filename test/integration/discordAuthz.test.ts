import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import { buildContext, type AppContext } from "../../src/core/api/context.js";
import { buildServer } from "../../src/core/api/server.js";
import { closeDb, dbReady, resetDb, testPrisma } from "./db.js";

/**
 * The Discord bot's allowlists, as the control plane stores them.
 *
 * Three properties matter here beyond "the CRUD works". The lists are a
 * security boundary, so a token scoped elsewhere must be refused. They are
 * edited by humans pasting from Discord, so junk must be rejected loudly rather
 * than dropped. And every change must land in the audit log with both sides of
 * the diff, because "who let this account in?" is the question this data exists
 * to answer.
 */
describe.skipIf(!dbReady())("discord bot allowlists", () => {
  const prisma = testPrisma();
  const ADMIN_TOKEN = "test-admin-token-0123456789";
  const config = loadConfig({
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    ADMIN_TOKEN,
    LOG_LEVEL: "error",
  });
  const log = createLogger("test-discord-authz", "error");
  let app: FastifyInstance;
  let ctx: AppContext;
  const root = { authorization: `Bearer ${ADMIN_TOKEN}` };

  const GUILD = "900000000000000001";
  const CHANNEL = "800000000000000001";
  const USER = "700000000000000001";
  const ROLE = "600000000000000001";

  beforeEach(async () => {
    await resetDb(prisma);
    if (!app) {
      ctx = buildContext(prisma, config, log);
      app = buildServer(ctx);
      await app.ready();
    }
  });

  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  async function mint(scopes: string[]): Promise<{ authorization: string }> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/tokens",
      headers: root,
      payload: { name: `authz-${scopes.join("-")}-${Math.random().toString(36).slice(2, 7)}`, scopes },
    });
    expect(res.statusCode).toBe(201);
    return { authorization: `Bearer ${res.json().token}` };
  }

  const read = (headers: { authorization: string } = root) =>
    app.inject({ method: "GET", url: "/api/v1/admin/discord/authz", headers });

  const write = (payload: Record<string, unknown>, headers: { authorization: string } = root) =>
    app.inject({ method: "PUT", url: "/api/v1/admin/discord/authz", headers, payload });

  describe("reading", () => {
    it("reports an unconfigured deployment as unconfigured, not as locked down", async () => {
      // The difference matters: empty-and-stored means "nobody may write",
      // empty-and-unstored means "the bot is still on its .env".
      const res = await read();
      expect(res.statusCode).toBe(200);
      expect(res.json().configured).toBe(false);
      expect(res.json().entries).toEqual({ guilds: [], channels: [], adminUsers: [], adminRoles: [] });
    });

    it("says the stored lists are not in force yet, rather than judging them", async () => {
      // Warning "no channels are allowed" here would be a falsehood about a
      // deployment whose .env is perfectly well configured; the API cannot see
      // that file, the bot can.
      const warnings: string[] = (await read()).json().warnings;
      expect(warnings.join(" ")).toContain("still using the DISCORD_* variables");
      expect(warnings.join(" ")).not.toContain("No allowed channels");
    });

    it("names the misconfigurations that make every write fail, once lists are stored", async () => {
      await write({ guilds: [GUILD] });
      const warnings: string[] = (await read()).json().warnings;
      expect(warnings.join(" ")).toContain("No allowed channels");
      expect(warnings.join(" ")).toContain("No admin users or roles");
      expect(warnings.join(" ")).not.toContain("No guilds pinned");
    });
  });

  describe("scope containment", () => {
    it("refuses a token that does not hold users:admin", async () => {
      // These lists decide who can drive the bot; a runs:write token has no
      // business widening that.
      const weak = await mint(["runs:write", "stats:read"]);
      expect((await read(weak)).statusCode).toBe(403);
      expect((await write({ guilds: [GUILD] }, weak)).statusCode).toBe(403);
    });

    it("allows a users:admin token to both read and write", async () => {
      // The bot's own token can never be OWNER, so an owner gate here would
      // lock the bot out of administering itself. This is the deliberate
      // difference from the role-permission routes.
      const botToken = await mint(["users:admin"]);
      expect((await read(botToken)).statusCode).toBe(200);
      const res = await write({ adminUsers: [USER] }, botToken);
      expect(res.statusCode).toBe(200);
      expect(res.json().entries.adminUsers).toEqual([{ id: USER, label: "" }]);
    });

    it("refuses an unauthenticated caller", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/admin/discord/authz" });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("writing", () => {
    it("stores bare ids and labelled entries alike", async () => {
      const res = await write({
        guilds: [GUILD],
        channels: [{ id: CHANNEL, label: "#ops" }],
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().entries.guilds).toEqual([{ id: GUILD, label: "" }]);
      expect(res.json().entries.channels).toEqual([{ id: CHANNEL, label: "#ops" }]);
      expect(res.json().configured).toBe(true);
    });

    it("leaves lists the request did not mention alone", async () => {
      await write({ guilds: [GUILD], adminUsers: [USER] });
      const res = await write({ channels: [CHANNEL] });
      expect(res.json().entries.guilds).toEqual([{ id: GUILD, label: "" }]);
      expect(res.json().entries.adminUsers).toEqual([{ id: USER, label: "" }]);
    });

    it("empties a list when handed an empty array, which is how you revoke", async () => {
      await write({ adminUsers: [USER] });
      const res = await write({ adminUsers: [] });
      expect(res.json().entries.adminUsers).toEqual([]);
    });

    it("rejects junk loudly instead of dropping it", async () => {
      // A silently-ignored typo leaves an operator believing they granted
      // access that they did not.
      const res = await write({ adminUsers: ["<@700000000000000001>", "ardax"] });
      expect(res.statusCode).toBe(400);
      expect(res.json().rejected.adminUsers).toEqual(["<@700000000000000001>", "ardax"]);
      // And nothing was written.
      expect((await read()).json().configured).toBe(false);
    });

    it("exposes the plain id lists the bot consumes", async () => {
      const res = await write({
        guilds: [{ id: GUILD, label: "staff" }],
        adminRoles: [{ id: ROLE, label: "@staff" }],
      });
      expect(res.json().effective.guildIds).toEqual([GUILD]);
      expect(res.json().effective.adminRoleIds).toEqual([ROLE]);
    });
  });

  describe("audit trail", () => {
    it("records both sides of the change, not just that one happened", async () => {
      await write({ adminUsers: [USER] });
      await write({ adminUsers: [ROLE] });

      const events = await prisma.auditEvent.findMany({
        where: { action: "discord.authz.update" },
        orderBy: { createdAt: "asc" },
      });
      expect(events).toHaveLength(2);
      const second = events[1]?.detail as { adminUsers: { added: string[]; removed: string[] } };
      expect(second.adminUsers.added).toEqual([ROLE]);
      expect(second.adminUsers.removed).toEqual([USER]);
    });

    it("writes nothing when a save changes nothing", async () => {
      await write({ adminUsers: [USER] });
      await write({ adminUsers: [USER] });
      const events = await prisma.auditEvent.findMany({ where: { action: "discord.authz.update" } });
      expect(events).toHaveLength(1);
    });
  });

  describe("resetting", () => {
    it("clears the stored lists and reports the deployment as unconfigured again", async () => {
      await write({ guilds: [GUILD], adminUsers: [USER] });
      const res = await app.inject({ method: "DELETE", url: "/api/v1/admin/discord/authz", headers: root });
      expect(res.statusCode).toBe(200);
      expect(res.json().configured).toBe(false);
      expect(res.json().entries.guilds).toEqual([]);
      // Reading it back agrees: this is the way out of a lockout without psql.
      expect((await read()).json().configured).toBe(false);
    });

    it("is recorded, because it hands control back to the environment", async () => {
      await write({ adminUsers: [USER] });
      await app.inject({ method: "DELETE", url: "/api/v1/admin/discord/authz", headers: root });
      const events = await prisma.auditEvent.findMany({ where: { action: "discord.authz.reset" } });
      expect(events).toHaveLength(1);
    });
  });
});
