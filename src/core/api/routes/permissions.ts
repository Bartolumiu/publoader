import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { adminAuthHook, requireOwner, requireScope } from "../auth.js";
import { sessionAuthenticator, impersonationResolver} from "../session.js";
import {
  SCOPES,
  SCOPE_DESCRIPTIONS,
  SCOPE_PRESETS,
  TUNABLE_ROLES,
  effectiveScopes,
  isTunableRole,
  parseScopes,
} from "../scopes.js";

/**
 * Permission tuning: what a role means on this deployment, and what one
 * account may do beyond (or short of) its role.
 *
 * Every *change* here is gated exactly like account administration — OWNER
 * *and* `users:admin` — for the same reason: widening a role is granting
 * authority, and an API token is never OWNER however broadly it is scoped, so
 * no token can widen the role its own holder sits in.
 *
 * Reading the taxonomy and the role baselines is only `users:admin`, without
 * the role gate. It names no account and grants nothing — it is the answer to
 * "what does CONTRIBUTOR mean on this deployment?" — and keeping it reachable
 * is what lets the Discord bot, which can never be OWNER, still answer that
 * question instead of being a surface where the feature simply does not exist.
 * The per-account view names an account, so it stays owner-only with the rest.
 *
 * Two things are deliberately impossible here. OWNER's baseline cannot be
 * edited, and an owner account cannot be individually tuned. OWNER is the role
 * that reaches this file at all, so a narrowing mistake against it would leave
 * a deployment with no way to undo the mistake short of the break-glass token.
 */

/** Cap the request body: 32 scopes is already more than the taxonomy holds. */
const ScopeList = z.array(z.string().max(64)).max(64);

export function registerPermissionRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.register(async (scope) => {
    scope.addHook(
      "preHandler",
      adminAuthHook({
        adminToken: ctx.config.adminToken,
        session: sessionAuthenticator(ctx),
        apiTokens: ctx.apiTokens,
        impersonation: impersonationResolver(ctx),
      }),
    );
    scope.addHook("preHandler", async (req, reply) => {
      if (!ctx.adminLimiter.allow(req.ip)) {
        await reply.code(429).send({ error: "rate limited" });
      }
    });
    scope.addHook("preHandler", requireScope("users:admin"));
    /** Everything that grants or removes authority. Attached per route. */
    const owner = { preHandler: [requireOwner] };

    const actor = (req: FastifyRequest) =>
      req.principal?.name ??
      `admin:${(req.headers["x-actor"] as string | undefined)?.slice(0, 64) ?? req.adminActor ?? "unknown"}`;

    /**
     * Reject unknown scope strings rather than dropping them.
     *
     * A silently-dropped typo in a *grant* is merely confusing; in a *denial*
     * it is dangerous, because the operator walks away believing they removed
     * something they did not.
     */
    const validate = (lists: Record<string, readonly string[]>): string[] => {
      const invalid: string[] = [];
      for (const list of Object.values(lists)) invalid.push(...parseScopes(list).invalid);
      return [...new Set(invalid)];
    };

    // ---- the taxonomy and the role baselines ----

    /**
     * Everything an editor needs in one call: the scopes that exist, what each
     * one means, and where every role currently stands.
     */
    scope.get("/api/v1/admin/permissions", async () => ({
      scopes: SCOPES.map((name) => ({ name, description: SCOPE_DESCRIPTIONS[name] })),
      presets: SCOPE_PRESETS,
      tunableRoles: TUNABLE_ROLES,
      roles: await ctx.permissions.baselines(),
    }));

    /**
     * Redefine what a role means here. The list replaces the baseline outright
     * — an editor that reads the state and writes back the intended state
     * cannot half-apply the way an add/remove API can.
     */
    scope.put("/api/v1/admin/permissions/roles/:role", owner, async (req, reply) => {
      const { role } = req.params as { role: string };
      if (!isTunableRole(role)) {
        return reply.code(400).send({
          error: `role must be one of ${TUNABLE_ROLES.join(", ")}`,
          // Said plainly, because "why not OWNER?" is the immediate question.
          detail:
            "OWNER is the wildcard by construction: it is the role that edits permissions, so it is the one role permissions cannot be narrowed against.",
        });
      }
      const body = z.object({ scopes: ScopeList }).parse(req.body ?? {});
      const invalid = validate({ scopes: body.scopes });
      if (invalid.length > 0) {
        return reply.code(400).send({ error: "unknown scopes", invalid });
      }
      const before = await ctx.permissions.roleScopes(role);
      const stored = await ctx.permissions.setRoleScopes(role, body.scopes, actor(req));
      await ctx.audit.record(actor(req), "permissions.role", role, { before, after: stored });
      return { ok: true, role, scopes: stored };
    });

    /** Back to the shipped default, and back to tracking it across releases. */
    scope.delete("/api/v1/admin/permissions/roles/:role", owner, async (req, reply) => {
      const { role } = req.params as { role: string };
      if (!isTunableRole(role)) {
        return reply.code(400).send({ error: `role must be one of ${TUNABLE_ROLES.join(", ")}` });
      }
      const before = await ctx.permissions.roleScopes(role);
      const reset = await ctx.permissions.resetRole(role);
      if (!reset) return reply.code(409).send({ error: "role is already on the shipped default" });
      await ctx.audit.record(actor(req), "permissions.role.reset", role, { before });
      return { ok: true, role, scopes: await ctx.permissions.roleScopes(role) };
    });

    // ---- per-account tuning ----

    /**
     * One account's permissions, broken into the parts that produced them, so
     * the answer to "why can they do that?" is on the page rather than in a
     * mental re-run of the algebra.
     */
    scope.get("/api/v1/admin/users/:id/permissions", owner, async (req, reply) => {
      const { id } = req.params as { id: string };
      const user = await ctx.adminUsers.byId(id);
      if (!user) return reply.code(404).send({ error: "unknown account" });
      return {
        userId: user.id,
        email: user.email,
        role: user.role,
        baseline: await ctx.permissions.roleScopes(user.role),
        extraScopes: user.extraScopes,
        deniedScopes: user.deniedScopes,
        effective: await ctx.permissions.effectiveForUser(user),
        // An owner ignores both lists; say so rather than rendering knobs that
        // would quietly do nothing.
        tunable: user.role !== "OWNER",
      };
    });

    scope.put("/api/v1/admin/users/:id/permissions", owner, async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = z
        .object({
          extraScopes: ScopeList.default([]),
          deniedScopes: ScopeList.default([]),
        })
        .parse(req.body ?? {});

      const user = await ctx.adminUsers.byId(id);
      if (!user) return reply.code(404).send({ error: "unknown account" });
      if (user.role === "OWNER") {
        return reply.code(409).send({
          error:
            "an OWNER holds every scope by construction; change the role first if this account should be restricted",
        });
      }
      const invalid = validate({ extra: body.extraScopes, denied: body.deniedScopes });
      if (invalid.length > 0) {
        return reply.code(400).send({ error: "unknown scopes", invalid });
      }
      // Both at once is contradictory, and denial silently winning is exactly
      // the kind of surprise a permissions editor must not hand back.
      const contradictory = body.extraScopes.filter((s) => body.deniedScopes.includes(s));
      if (contradictory.length > 0) {
        return reply.code(400).send({
          error: "a scope cannot be both granted and denied",
          scopes: contradictory,
        });
      }

      const updated = await ctx.adminUsers.setScopes(id, {
        extraScopes: body.extraScopes,
        deniedScopes: body.deniedScopes,
      });
      const baseline = await ctx.permissions.roleScopes(updated.role);
      const effective = effectiveScopes(baseline, updated.extraScopes, updated.deniedScopes);
      await ctx.audit.record(actor(req), "permissions.user", id, {
        email: updated.email,
        extraScopes: updated.extraScopes,
        deniedScopes: updated.deniedScopes,
      });
      return {
        ok: true,
        userId: updated.id,
        extraScopes: updated.extraScopes,
        deniedScopes: updated.deniedScopes,
        effective,
      };
    });
  });
}
