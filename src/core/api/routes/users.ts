import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AdminUser } from "@prisma/client";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { adminAuthHook, requireOwner, requireScope } from "../auth.js";
import { sessionAuthenticator } from "../session.js";
import { MIN_PASSWORD_LENGTH, toPublicUser } from "../../store/adminUsers.js";

/**
 * Account administration: who can reach the dashboard, with what role, and
 * which of their sessions are live.
 *
 * Everything here is OWNER-only except setting your own password — an ADMIN
 * has full control-plane authority but cannot grant it to anybody else.
 *
 * Three roles, and the gap between the first two is much smaller than the gap
 * to the third: OWNER and ADMIN differ only in account administration, while
 * CONTRIBUTOR is a genuinely confined role (see `scopesForRole`) that can
 * curate the series map and work the untracked queue and nothing else. That is
 * the role to hand someone outside the operator group — an ADMIN can publish
 * bundles, which is code execution on every worker.
 */
const ASSIGNABLE_ROLES = ["OWNER", "ADMIN", "CONTRIBUTOR"] as const;

export function registerUserRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.register(async (scope) => {
    scope.addHook(
      "preHandler",
      adminAuthHook({
        adminToken: ctx.config.adminToken,
        session: sessionAuthenticator(ctx),
        apiTokens: ctx.apiTokens,
      }),
    );
    scope.addHook("preHandler", async (req, reply) => {
      if (!ctx.adminLimiter.allow(req.ip)) {
        await reply.code(429).send({ error: "rate limited" });
      }
    });

    const actor = (req: FastifyRequest) =>
      `admin:${(req.headers["x-actor"] as string | undefined)?.slice(0, 64) ?? req.adminActor ?? "unknown"}`;
    // Account administration needs BOTH the owner role and the users:admin
    // scope: role keeps API tokens out entirely (they are never OWNER), scope
    // keeps a future non-owner principal from inheriting it by accident.
    const owner = { preHandler: [requireOwner, requireScope("users:admin")] };

    /**
     * Mail a sign-in link, reporting rather than throwing.
     *
     * Sending is a side effect of an account action, and the account action is
     * the one that must not be lost: an invite whose mail bounced is still an
     * invite an owner can re-send. So the failure travels back in the response
     * body — `emailed: false` plus a reason — instead of failing the request.
     */
    const sendLink = async (
      user: AdminUser,
      purpose: "INVITE" | "WELCOME" | "LOGIN",
      req: FastifyRequest,
    ): Promise<{ emailed: boolean; linkExpiresAt?: string; emailError?: string }> => {
      if (!ctx.magicLinks.enabled) {
        return { emailed: false, emailError: "email is not configured on this deployment" };
      }
      try {
        const { expiresAt } = await ctx.magicLinks.send(user, purpose, { requestedIp: req.ip });
        return { emailed: true, linkExpiresAt: expiresAt.toISOString() };
      } catch (err) {
        return { emailed: false, emailError: (err as Error).message };
      }
    };

    // ---- accounts ----

    scope.get("/api/v1/admin/users", owner, async () => ({
      users: (await ctx.adminUsers.list()).map(toPublicUser),
    }));

    /**
     * Invite an operator. The account and the sign-in link are one action: an
     * invited account has no password and no Discord linkage, so an invite
     * that did not mail a link would create something nobody can reach.
     *
     * A failed send is reported but does NOT roll the account back — the
     * account is the durable half, and the link can be re-sent. `emailed`
     * tells the caller which of the two happened.
     */
    scope.post("/api/v1/admin/users", owner, async (req, reply) => {
      const body = z
        .object({ email: z.string().email().max(320), role: z.enum(ASSIGNABLE_ROLES).default("ADMIN") })
        .parse(req.body ?? {});
      if (await ctx.adminUsers.byEmail(body.email)) {
        return reply.code(409).send({ error: "an account with that email already exists" });
      }
      const user = await ctx.adminUsers.invite(body.email, body.role);
      await ctx.audit.record(actor(req), "admin_user.invite", user.id, {
        email: user.email,
        role: user.role,
      });
      const invite = await sendLink(user, "INVITE", req);
      return reply.code(201).send({ user: toPublicUser(user), ...invite });
    });

    /**
     * Approve a pending signup, and tell them so with a link. Without the
     * mail, approval is invisible to the person waiting on it.
     */
    scope.post("/api/v1/admin/users/:id/approve", owner, async (req, reply) => {
      const { id } = req.params as { id: string };
      const user = await ctx.adminUsers.approve(id);
      if (!user) return reply.code(409).send({ error: "unknown account, or already approved" });
      await ctx.audit.record(actor(req), "admin_user.approve", id, { email: user.email });
      const welcome = await sendLink(user, "WELCOME", req);
      return { ok: true, user: toPublicUser(user), ...welcome };
    });

    /**
     * Re-send a sign-in link. The invite mail is the part most likely to go
     * missing — spam folders, typo'd addresses, expiry over a long weekend —
     * so recovering from that must not require an owner to invent a password
     * for somebody else and send it over some other channel.
     */
    scope.post("/api/v1/admin/users/:id/magic-link", owner, async (req, reply) => {
      const { id } = req.params as { id: string };
      const user = await ctx.adminUsers.byId(id);
      if (!user) return reply.code(404).send({ error: "unknown account" });
      if (!user.approved) {
        return reply.code(409).send({ error: "approve the account before sending a sign-in link" });
      }
      if (!ctx.magicLinks.enabled) {
        return reply.code(503).send({ error: "email is not configured on this deployment" });
      }
      const sent = await sendLink(user, user.passwordHash ? "LOGIN" : "INVITE", req);
      if (!sent.emailed) return reply.code(502).send({ error: sent.emailError });
      await ctx.audit.record(actor(req), "admin_user.magic_link", id, { email: user.email });
      return { ok: true, ...sent };
    });

    scope.post("/api/v1/admin/users/:id/role", owner, async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = z.object({ role: z.enum(ASSIGNABLE_ROLES) }).parse(req.body ?? {});
      const result = await ctx.adminUsers.setRole(id, body.role);
      if (result === "unknown") return reply.code(404).send({ error: "unknown account" });
      if (result === "last-owner") {
        return reply.code(409).send({ error: "cannot demote the last owner" });
      }
      await ctx.audit.record(actor(req), "admin_user.role", id, { role: body.role });
      return { ok: true };
    });

    scope.delete("/api/v1/admin/users/:id", owner, async (req, reply) => {
      const { id } = req.params as { id: string };
      const result = await ctx.adminUsers.remove(id);
      if (result === "unknown") return reply.code(404).send({ error: "unknown account" });
      if (result === "last-owner") return reply.code(409).send({ error: "cannot delete the last owner" });
      await ctx.audit.record(actor(req), "admin_user.delete", id);
      return { ok: true };
    });

    /**
     * Set a password. Self-service — which is what an account that got in with
     * an emailed link does first — or an owner setting one for somebody else,
     * which is also how the seeded owner gets its first password after logging
     * in with the break-glass token.
     */
    scope.post("/api/v1/admin/users/:id/password", async (req, reply) => {
      const { id } = req.params as { id: string };
      if (req.adminRole !== "OWNER" && req.adminUserId !== id) {
        return reply.code(403).send({ error: "you may only change your own password" });
      }
      const body = z
        .object({ password: z.string().min(MIN_PASSWORD_LENGTH).max(1024) })
        .safeParse(req.body ?? {});
      if (!body.success) {
        return reply.code(400).send({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      }
      const user = await ctx.adminUsers.byId(id);
      if (!user) return reply.code(404).send({ error: "unknown account" });
      await ctx.adminUsers.setPassword(id, body.data.password);
      // The account now has a credential its holder chose, so any link still
      // sitting in an inbox stops being a second way in.
      const retired = await ctx.loginTokens.revokeOutstanding(id);
      await ctx.audit.record(actor(req), "admin_user.password", id, { retiredLinks: retired });
      // Told, not asked: a password change the account holder did not make is
      // the one thing they need to hear about immediately.
      await ctx.magicLinks.notify("password-changed", user.email);
      return { ok: true };
    });

    /**
     * Detach Discord. Self-service, or an owner doing it for somebody who has
     * lost the Discord account — which is the case that matters, because
     * without this the operator account is stranded behind a credential nobody
     * holds any more.
     *
     * Refused when it would leave the account with no way in at all: no
     * password, and no mailer to send a sign-in link with. Removing the last
     * credential from an account is deletion with extra steps, and deletion is
     * its own button.
     */
    scope.delete("/api/v1/admin/users/:id/discord", async (req, reply) => {
      const { id } = req.params as { id: string };
      if (req.adminRole !== "OWNER" && req.adminUserId !== id) {
        return reply.code(403).send({ error: "you may only unlink your own Discord account" });
      }
      const user = await ctx.adminUsers.byId(id);
      if (!user) return reply.code(404).send({ error: "unknown account" });
      if (!user.discordId) return reply.code(409).send({ error: "no Discord account is linked" });
      if (!user.passwordHash && !ctx.magicLinks.enabled) {
        return reply.code(409).send({
          error:
            "Discord is the only way into this account: set a password first, or configure email sign-in links.",
        });
      }
      const updated = await ctx.adminUsers.unlinkDiscord(id);
      await ctx.audit.record(actor(req), "admin_user.discord_unlink", id, {
        discordUsername: user.discordUsername,
      });
      return { ok: true, user: toPublicUser(updated) };
    });

    // ---- live sessions ----

    scope.get("/api/v1/admin/sessions", owner, async () => ({
      sessions: (await ctx.adminUsers.listSessions()).map((s) => ({
        id: s.id,
        actor: s.actor,
        email: s.user.email,
        role: s.user.role,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
      })),
    }));

    scope.delete("/api/v1/admin/sessions/:id", owner, async (req, reply) => {
      const { id } = req.params as { id: string };
      const revoked = await ctx.adminUsers.revokeSession(id);
      if (!revoked) return reply.code(404).send({ error: "unknown or already revoked session" });
      await ctx.audit.record(actor(req), "admin_session.revoke", id);
      return { ok: true };
    });

    // ---- self-signup gate ----

    scope.get("/api/v1/admin/settings/signups", owner, async () => ({
      enabled: await ctx.settings.getSignupsEnabled(),
    }));

    scope.post("/api/v1/admin/settings/signups", owner, async (req) => {
      const body = z.object({ enabled: z.boolean() }).parse(req.body ?? {});
      await ctx.settings.setSignupsEnabled(body.enabled);
      await ctx.audit.record(actor(req), "settings.signups", undefined, { enabled: body.enabled });
      return { ok: true, enabled: body.enabled };
    });
  });
}
