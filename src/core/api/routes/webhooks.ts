/**
 * The GitHub push webhook, replacing the legacy standalone listener in
 * publoader/github_webhook.py.
 *
 * Deliberately UNAUTHENTICATED in the platform's own terms: there is no bearer
 * token and no session, because GitHub cannot present one. The
 * X-Hub-Signature-256 HMAC is the credential, and it is checked over the raw
 * request bytes before anything else looks at the payload.
 *
 * `POST /webhook` is kept at exactly that path because the operator's existing
 * GitHub webhooks already point at https://publoader.ardax.dev/webhook;
 * `POST /api/v1/webhooks/github` is the alias to configure for anything new.
 *
 * A note on what this is *for*: publishing from CI is the better arrangement
 * (see docs/webhooks.md §"Prefer CI-side publishing"). This endpoint exists so
 * a deployment with no CI at all still gets code out of a push, at the cost of
 * putting a GitHub token and a build toolchain inside core-api.
 */
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { RateLimiter } from "../ratelimit.js";
import {
  MAX_WEBHOOK_BODY_BYTES,
  changedExtensions,
  isMapSyncPush,
  roleForPush,
  verifySignature,
  type GithubWebhookConfig,
  type PushPayload,
} from "../../webhooks/github.js";
import { handleExtensionsPush, type PushHandlerDeps } from "../../webhooks/pushHandler.js";
import { parseRepoList } from "../../webhooks/repoList.js";

const PATHS = ["/webhook", "/api/v1/webhooks/github"] as const;

export interface WebhookRouteOptions {
  /** Test seam: overrides the real GitHub archive download. */
  fetchArchive?: PushHandlerDeps["fetchArchive"];
}

export function registerWebhookRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  options: WebhookRouteOptions = {},
): void {
  /**
   * Per-IP budget. GitHub delivers one request per push and does not retry
   * automatically, so a handful of tokens is generous for the legitimate
   * caller while making the endpoint useless for hammering: 10 bursts,
   * refilling one every 10s.
   */
  const limiter = new RateLimiter(10, 0.1);

  const cfg: GithubWebhookConfig = {
    ...(ctx.config.githubWebhookSecret ? { secret: ctx.config.githubWebhookSecret } : {}),
    owner: ctx.config.githubRepoOwner,
    extensionsRepos: parseRepoList(ctx.config.githubExtensionsRepos),
    ...(ctx.config.githubCoreRepo ? { coreRepo: ctx.config.githubCoreRepo } : {}),
  };

  app.register(async (scope) => {
    // GitHub signs the exact bytes it sent, so this scope needs the raw body
    // rather than the server's parsed-JSON default. Replacing the parser inside
    // an encapsulated plugin leaves every other route untouched.
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) =>
      done(null, body),
    );

    for (const path of PATHS) {
      scope.post(path, { bodyLimit: MAX_WEBHOOK_BODY_BYTES }, async (req, reply) => {
        if (!limiter.allow(req.ip)) {
          return reply.code(429).send({ ok: false, error: "rate limited" });
        }
        if (!cfg.secret) {
          // Fail closed. An endpoint that triggers a publish must never run
          // without its credential configured.
          req.log.warn("github webhook delivery refused: GITHUB_WEBHOOK_SECRET is unset");
          return reply.code(503).send({ ok: false, error: "webhook is not configured" });
        }
        const body = Buffer.isBuffer(req.body) ? req.body : null;
        if (!body || body.length === 0) {
          return reply.code(400).send({ ok: false, error: "empty body" });
        }
        if (!verifySignature(cfg.secret, body, req.headers["x-hub-signature-256"] as string | undefined)) {
          return reply.code(401).send({ ok: false, error: "invalid signature" });
        }

        const event = (req.headers["x-github-event"] as string | undefined) ?? "";
        // GitHub sends a ping the moment a webhook is created. Answering it 200
        // is the difference between a green delivery log and an operator
        // debugging a red one that was never a problem.
        if (event === "ping") return reply.code(200).send({ ok: true, pong: true });
        if (event !== "push") {
          return reply.code(202).send({ ok: true, ignored: `event '${event}'` });
        }

        let payload: PushPayload;
        try {
          payload = JSON.parse(body.toString("utf8"));
        } catch {
          return reply.code(400).send({ ok: false, error: "invalid json" });
        }

        const decision = roleForPush(payload, cfg);
        if (decision.role === null) {
          // 202 with the reason, matching the legacy listener: the delivery is
          // green (nothing is wrong with it) and the log explains itself.
          return reply.code(202).send({ ok: true, ignored: decision.reason });
        }

        if (decision.role === "core") {
          return reply.code(200).send({
            ok: true,
            acknowledged: true,
            action: "none",
            reason:
              "core deploys are image-based; CI builds ardax/publoader-core and " +
              "`./scripts/publoader prod upgrade <tag>` rolls it out. See docs/deployment.md.",
            commit: decision.after,
          });
        }

        if (isMapSyncPush(payload)) {
          // Our own weekly write-back of manga_id_map.json. Republishing a
          // bundle for it would churn the sha256 pin every week for a file the
          // workers do not read from the bundle.
          return reply.code(200).send({
            ok: true,
            commit: decision.after,
            ignored: "every commit in this push is a publoader series-map sync commit",
          });
        }

        const changed = changedExtensions(payload);
        if (changed.length === 0) {
          return reply.code(200).send({
            ok: true,
            commit: decision.after,
            ignored: "no paths under src/<extension>/ changed",
          });
        }

        const result = await handleExtensionsPush(
          payload,
          decision.repo,
          decision.after,
          changed,
          {
            owner: ctx.config.githubRepoOwner,
            ...(ctx.config.githubToken ? { token: ctx.config.githubToken } : {}),
            apiUrl: ctx.config.githubApiUrl,
          },
          {
            bundles: ctx.bundles,
            audit: ctx.audit,
            log: ctx.log,
            ...(options.fetchArchive ?? ctx.webhookFetchArchive
              ? { fetchArchive: (options.fetchArchive ?? ctx.webhookFetchArchive)! }
              : {}),
          },
        );

        // 207 when the delivery was partly unsuccessful: the operator sees at a
        // glance from GitHub's delivery list that something needs attention,
        // without a total failure hiding the extensions that did publish.
        const anyFailed = result.outcomes.some((o) => o.status === "failed" || o.status === "skipped");
        return reply.code(anyFailed ? 207 : 200).send({ ok: !anyFailed, ...result });
      });
    }
  });
}

// Re-exported so existing importers (and tests) keep finding it here, while
// background jobs like the series-map sync read the same setting without
// importing a route.
export { parseRepoList };
