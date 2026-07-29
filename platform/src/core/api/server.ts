import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { AppContext } from "./context.js";
import { registerWorkerRoutes } from "./routes/worker.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerTokenRoutes } from "./routes/tokens.js";
import { registerSessionRoutes } from "./session.js";
import { registerOAuthRoutes } from "./oauth.js";
import { registerUserRoutes } from "./routes/users.js";
import { registerDashboardRoutes } from "./dashboard.js";
import { renderMetrics } from "../../metrics.js";

/**
 * The control-plane HTTP server. Public entry is expected to be fronted by
 * TLS (cloudflared tunnel at https://publoader.ardax.dev or a reverse proxy);
 * the server itself binds an internal port only.
 *
 * Security defaults baked in:
 *  - request-id on every request/response (correlation)
 *  - conservative security headers
 *  - 1 MiB default body limit (routes opt into larger, capped limits)
 *  - binary parsers only for the exact content types that need them
 *  - /metrics and /healthz intended for the internal network only —
 *    do NOT expose them through the public tunnel hostname.
 *  - /dash serves the operator dashboard (static, CSP-locked); it is the only
 *    browser-facing surface and authenticates via /api/v1/admin/session.
 */
export function buildServer(ctx: AppContext): FastifyInstance {
  // Cast away the pino-instance generic: fastify narrows its logger type
  // parameter when given a concrete pino logger, which makes the instance
  // incompatible with plugin signatures typed against FastifyBaseLogger.
  const app = Fastify({
    loggerInstance: ctx.log.child({ component: "api" }),
    bodyLimit: 1024 * 1024,
    genReqId: () => randomUUID(),
    trustProxy: true,
  }) as unknown as FastifyInstance;

  // Raw-binary parsing for artifact/bundle uploads only.
  for (const type of ["application/zip", "application/octet-stream", "image/png", "image/jpeg", "image/gif", "image/webp"]) {
    app.addContentTypeParser(type, { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  }

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cache-control", "no-store");
  });

  app.get("/healthz", async () => ({ ok: true }));

  app.get("/readyz", async (_req, reply) => {
    try {
      await ctx.prisma.$queryRawUnsafe("SELECT 1");
    } catch {
      return reply.code(503).send({ ok: false, reason: "database unreachable" });
    }
    return { ok: true };
  });

  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", "text/plain; version=0.0.4");
    return renderMetrics();
  });

  registerWorkerRoutes(app, ctx);
  // Session login/logout and the OAuth dance are the authentication step, so
  // they register outside the admin scope and guard themselves with the
  // per-IP login limiter.
  registerSessionRoutes(app, ctx);
  registerOAuthRoutes(app, ctx);
  registerAdminRoutes(app, ctx);
  registerTokenRoutes(app, ctx);
  registerUserRoutes(app, ctx);
  registerDashboardRoutes(app);

  app.setErrorHandler((err: FastifyError, req, reply) => {
    req.log.error({ err }, "request failed");
    const status = typeof err.statusCode === "number" ? err.statusCode : 500;
    // Never leak stack traces or internals to clients.
    reply.code(status).send({ error: status >= 500 ? "internal error" : err.message });
  });

  return app;
}
