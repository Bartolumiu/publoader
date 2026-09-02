import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { adminAuthHook, requireOwner, requireScope } from "../auth.js";
import { sessionAuthenticator, impersonationResolver} from "../session.js";
import { InvalidScopesError } from "../../store/apiTokens.js";
import { SCOPE_PRESETS, SCOPES } from "../scopes.js";

/**
 * Scoped per-client token management. Gated on `users:admin`: the ability to
 * mint credentials is the ability to grant any scope, so it belongs with
 * account administration rather than with the areas a token can reach.
 */
export function registerTokenRoutes(app: FastifyInstance, ctx: AppContext): void {
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
    scope.addHook("preHandler", requireScope("users:admin"));
    // Minting a credential can grant any scope, including "*"; so it is
    // privilege escalation and must stay a human, owner-level action. API
    // tokens are never OWNER, so no token can mint (or widen) another token,
    // however broadly it is scoped.
    scope.addHook("preHandler", requireOwner);

    const actor = (req: FastifyRequest) =>
      req.principal?.name ??
      `admin:${(req.headers["x-actor"] as string | undefined)?.slice(0, 64) ?? "unknown"}`;

    /** The taxonomy, so the dashboard's mint form never hardcodes it. */
    scope.get("/api/v1/admin/tokens/scopes", async () => ({
      scopes: SCOPES,
      presets: SCOPE_PRESETS,
    }));

    scope.get("/api/v1/admin/tokens", async () => ({
      tokens: await ctx.apiTokens.list(),
    }));

    scope.post("/api/v1/admin/tokens", async (req, reply) => {
      const body = z
        .object({
          name: z.string().min(1).max(128),
          scopes: z.array(z.string().max(64)).min(1).max(32),
          ttlDays: z.number().int().min(1).max(3650).optional(),
        })
        .parse(req.body);

      try {
        const { token, row } = await ctx.apiTokens.mint({
          name: body.name,
          scopes: body.scopes,
          createdBy: actor(req),
          ttlDays: body.ttlDays,
        });
        await ctx.audit.record(actor(req), "api_token.mint", row.id, {
          name: row.name,
          scopes: row.scopes,
          expiresAt: row.expiresAt,
        });
        // Shown once. There is no endpoint that can reveal it again.
        return reply.code(201).send({
          id: row.id,
          name: row.name,
          scopes: row.scopes,
          expiresAt: row.expiresAt,
          token,
        });
      } catch (err) {
        if (err instanceof InvalidScopesError) {
          return reply.code(422).send({ error: err.message, validScopes: SCOPES });
        }
        throw err;
      }
    });

    scope.post("/api/v1/admin/tokens/:id/revoke", async (req, reply) => {
      const { id } = req.params as { id: string };
      const revoked = await ctx.apiTokens.revoke(id);
      if (!revoked) {
        return reply.code(409).send({ error: "unknown or already-revoked token" });
      }
      await ctx.audit.record(actor(req), "api_token.revoke", id);
      return { ok: true };
    });
  });
}
