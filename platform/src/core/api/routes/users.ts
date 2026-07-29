import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { adminAuthHook, requireOwner } from "../auth.js";
import { sessionAuthenticator } from "../session.js";
import { MIN_PASSWORD_LENGTH, toPublicUser } from "../../store/adminUsers.js";

/**
 * Account administration: who can reach the dashboard, with what role, and
 * which of their sessions are live.
 *
 * Everything here is OWNER-only except setting your own password — an ADMIN
 * has full control-plane authority but cannot grant it to anybody else, which
 * is the only privilege boundary the platform has.
 */
export function registerUserRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.register(async (scope) => {
    scope.addHook(
      "preHandler",
      adminAuthHook({
        adminToken: ctx.config.adminToken,
        session: sessionAuthenticator(ctx),
      }),
    );
    scope.addHook("preHandler", async (req, reply) => {
      if (!ctx.adminLimiter.allow(req.ip)) {
        await reply.code(429).send({ error: "rate limited" });
      }
    });

    const actor = (req: FastifyRequest) =>
      `admin:${(req.headers["x-actor"] as string | undefined)?.slice(0, 64) ?? req.adminActor ?? "unknown"}`;
    const owner = { preHandler: requireOwner };

    // ---- accounts ----

    scope.get("/api/v1/admin/users", owner, async () => ({
      users: (await ctx.adminUsers.list()).map(toPublicUser),
    }));

    scope.post("/api/v1/admin/users", owner, async (req, reply) => {
      const body = z
        .object({ email: z.string().email().max(320), role: z.enum(["OWNER", "ADMIN"]).default("ADMIN") })
        .parse(req.body ?? {});
      if (await ctx.adminUsers.byEmail(body.email)) {
        return reply.code(409).send({ error: "an account with that email already exists" });
      }
      const user = await ctx.adminUsers.invite(body.email, body.role);
      await ctx.audit.record(actor(req), "admin_user.invite", user.id, {
        email: user.email,
        role: user.role,
      });
      return reply.code(201).send({ user: toPublicUser(user) });
    });

    scope.post("/api/v1/admin/users/:id/approve", owner, async (req, reply) => {
      const { id } = req.params as { id: string };
      const user = await ctx.adminUsers.approve(id);
      if (!user) return reply.code(409).send({ error: "unknown account, or already approved" });
      await ctx.audit.record(actor(req), "admin_user.approve", id, { email: user.email });
      return { ok: true, user: toPublicUser(user) };
    });

    scope.post("/api/v1/admin/users/:id/role", owner, async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = z.object({ role: z.enum(["OWNER", "ADMIN"]) }).parse(req.body ?? {});
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
     * Set a password. Self-service, or an owner setting one for somebody else
     * — which is also how the seeded owner gets its first password after
     * logging in with the break-glass token.
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
      if (!(await ctx.adminUsers.byId(id))) return reply.code(404).send({ error: "unknown account" });
      await ctx.adminUsers.setPassword(id, body.data.password);
      await ctx.audit.record(actor(req), "admin_user.password", id);
      return { ok: true };
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
