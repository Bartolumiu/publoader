import type { FastifyInstance, FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { adminAuthHook, requireScope } from "../auth.js";
import { hasScope } from "../scopes.js";
import {
  DEFAULT_NAMESPACE,
  MAX_BATCH_ROWS,
  MAX_NAMESPACE_LENGTH,
  NAMESPACE_RE,
  normaliseNamespace,
  parsePairs,
} from "../../store/trackedManga.js";
import { sessionAuthenticator } from "../session.js";
import { Manifest, EXTENSION_NAME_RE } from "../../../contracts/manifest.js";
import { MANGADEX_LANGUAGES } from "../../../contracts/languages.js";
import { countOutstandingErrors } from "../../observability/errorFeed.js";

/**
 * The worker image the enrolment snippet tells a new host to run. Set
 * `PUBLOADER_WORKER_IMAGE` on core-api to pin it; the compose file does,
 * defaulting to the same release as the core.
 *
 * The fallback is `:latest` deliberately. A hardcoded version here rots
 * silently: this constant said `2.1.1` for three releases while the env var it
 * reads was never passed to core-api at all.
 */
const WORKER_IMAGE = process.env["PUBLOADER_WORKER_IMAGE"] ?? "ardax/publoader-worker:latest";
import { VALID_REMOVAL_MODES } from "../../store/settings.js";
import { BundleRejectedError } from "../../store/bundles.js";
import { MapSyncService } from "../../mapsync/service.js";
import AdmZip from "adm-zip";

const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

/**
 * Validate a query string and answer 400, not 500, when it is wrong. Same helper
 * as routes/ops.ts, routes/queues.ts and routes/sysops.ts.
 */
function parseOrThrow<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue && issue.path.length > 0 ? issue.path.join(".") : "request";
  throw Object.assign(new Error(`invalid ${where}: ${issue?.message ?? "validation failed"}`), {
    statusCode: 400,
  });
}

/**
 * The audit subject for one tracked mapping. The default id space keeps the
 * `extension:mangaId` form every existing audit row uses; a namespaced row adds
 * the catalogue, since `709` alone does not identify a series once viz has two.
 */
function trackedSubject(extension: string, namespace: string, mangaId: string): string {
  return namespace === DEFAULT_NAMESPACE
    ? `${extension}:${mangaId}`
    : `${extension}:${namespace}/${mangaId}`;
}

/**
 * Admin-audience routes, consumed by the operator CLI, the Discord bot and the
 * dashboard. Every mutating action is written to the audit log with the acting
 * principal.
 */
export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
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
    /**
     * Who to blame in the audit log. A scoped token is always named; when it
     * acts for a human (the Discord bot passing `x-actor: discord:alice`) both
     * identities are recorded. Browser sessions are named by their account and
     * may not claim someone else via the header.
     */
    const actor = (req: FastifyRequest) => {
      const claimed = (req.headers["x-actor"] as string | undefined)?.slice(0, 64);
      const principal = req.principal;
      if (principal?.kind === "api-token") {
        return claimed ? `${principal.name} for ${claimed}` : principal.name;
      }
      if (principal?.kind === "session") return principal.name;
      return `admin:${claimed ?? "root"}`;
    };

    // ---- worker fleet ----
    scope.post("/api/v1/admin/enroll-tokens", { preHandler: requireScope("enroll:write") }, async (req) => {
      const body = z
        .object({
          trust: z.enum(["TRUSTED", "COMMUNITY"]).default("COMMUNITY"),
          note: z.string().max(256).optional(),
          ttlHours: z.number().int().min(1).max(720).default(24),
        })
        .parse(req.body ?? {});
      const token = await ctx.workers.createEnrollToken(body);
      await ctx.audit.record(actor(req), "enroll_token.create", undefined, {
        trust: body.trust,
        note: body.note,
      });
      // The image goes out with the token so the dashboard's compose snippet
      // names a tag that exists.
      return { ...token, workerImage: WORKER_IMAGE };
    });

    /**
     * Every enrolment token and what became of it. The token itself is never
     * returned: only its hash is stored. An unused, unexpired token is a
     * credential somebody can still enrol with, which is what an operator needs
     * to see. Status is derived rather than stored, so it cannot drift.
     */
    scope.get("/api/v1/admin/enroll-tokens", { preHandler: requireScope("workers:read") }, async () => {
      const rows = await ctx.prisma.enrollToken.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
      const usedIds = rows.map((r) => r.usedByWorkerId).filter((v): v is string => v !== null);
      const workers = usedIds.length
        ? await ctx.prisma.worker.findMany({ where: { id: { in: usedIds } }, select: { id: true, name: true } })
        : [];
      const nameOf = new Map(workers.map((w) => [w.id, w.name]));
      const now = Date.now();

      return {
        tokens: rows.map((row) => ({
          id: row.id,
          trust: row.trust,
          note: row.note,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
          singleUse: row.singleUse,
          usedByWorkerId: row.usedByWorkerId,
          usedByWorkerName: row.usedByWorkerId ? (nameOf.get(row.usedByWorkerId) ?? null) : null,
          status: row.revoked
            ? "REVOKED"
            : row.usedByWorkerId
              ? "USED"
              : row.expiresAt.getTime() <= now
                ? "EXPIRED"
                : "PENDING",
        })),
      };
    });

    /**
     * Withdraw a token that has not been used yet, for one sent to the wrong
     * person, without waiting out its TTL.
     */
    scope.post(
      "/api/v1/admin/enroll-tokens/:id/revoke",
      { preHandler: requireScope("enroll:write") },
      async (req, reply) => {
        const { id } = req.params as { id: string };
        const updated = await ctx.prisma.enrollToken.updateMany({
          where: { id, revoked: false },
          data: { revoked: true },
        });
        // Already revoked, or no such token: either way there was nothing to
        // withdraw, and answering ok would imply there had been.
        if (updated.count !== 1) {
          return reply.code(404).send({ error: "no unrevoked enrolment token with that id" });
        }
        await ctx.audit.record(actor(req), "enroll_token.revoke", id);
        return { ok: true, revoked: true };
      },
    );

    scope.get("/api/v1/admin/workers", { preHandler: requireScope("workers:read") }, async () => {
      const workers = await ctx.workers.list();
      return {
        workers: workers.map((w) => ({
          id: w.id,
          name: w.name,
          status: w.status,
          trust: w.trust,
          extensions: w.extensions,
          lastHeartbeatAt: w.lastHeartbeatAt,
          agentVersion: w.agentVersion,
          createdAt: w.createdAt,
        })),
      };
    });

    for (const [action, status] of [
      ["drain", "DRAINED"],
      ["activate", "ACTIVE"],
      ["revoke", "REVOKED"],
    ] as const) {
      scope.post(`/api/v1/admin/workers/:id/${action}`, { preHandler: requireScope("workers:write") }, async (req, reply) => {
        const { id } = req.params as { id: string };
        const ok = await ctx.workers.setStatus(id, status);
        if (!ok) return reply.code(404).send({ error: "unknown worker" });
        await ctx.audit.record(actor(req), `worker.${action}`, id);
        return { ok: true, status };
      });
    }

    /**
     * Change which extensions a worker will be given, at runtime. The stored
     * list is what the lease query filters on, so this takes effect on that
     * worker's next poll. An empty list means "anything".
     */
    scope.put(
      "/api/v1/admin/workers/:id/extensions",
      { preHandler: requireScope("workers:write") },
      async (req, reply) => {
        const { id } = req.params as { id: string };
        const body = z
          .object({ extensions: z.array(z.string().max(128)).max(256) })
          .parse(req.body);
        const updated = await ctx.prisma.worker.updateMany({
          where: { id },
          data: { extensions: body.extensions },
        });
        if (updated.count !== 1) return reply.code(404).send({ error: "unknown worker" });
        await ctx.audit.record(actor(req), "worker.extensions.set", id, body);
        return { ok: true, extensions: body.extensions };
      },
    );

    // ---- runs & jobs ----
    scope.post("/api/v1/admin/runs", { preHandler: requireScope("runs:write") }, async (req, reply) => {
      const body = z
        .object({
          extension: z.string().regex(EXTENSION_NAME_RE),
          kind: z.enum(["UPDATE", "CLEAN", "FORCE"]).default("FORCE"),
          idempotencyKey: z.string().max(256).optional(),
        })
        .parse(req.body);
      if (await ctx.settings.isPaused()) {
        return reply.code(409).send({ error: "platform is paused" });
      }
      const bundle = await ctx.bundles.latest(body.extension);
      if (!bundle) return reply.code(404).send({ error: `no bundle published for ${body.extension}` });
      const manifest = Manifest.parse(bundle.manifest);
      const key =
        body.idempotencyKey ??
        `manual:${body.extension}:${body.kind}:${new Date().toISOString()}`;
      const result = await ctx.scheduler.createRunForExtension(manifest, bundle, {
        idempotencyKey: key,
        kind: body.kind,
        triggeredBy: actor(req),
      });
      await ctx.audit.record(actor(req), "run.trigger", result.runId, body);
      return reply.code(result.created ? 201 : 200).send(result);
    });

    scope.get("/api/v1/admin/runs", { preHandler: requireScope("runs:read") }, async (req) => {
      const query = z
        .object({
          limit: z.coerce.number().int().min(1).max(200).default(25),
          extension: z.string().optional(),
        })
        .parse(req.query ?? {});
      const runs = await ctx.prisma.run.findMany({
        where: query.extension ? { extension: query.extension } : undefined,
        orderBy: { createdAt: "desc" },
        take: query.limit,
      });
      // How much each run found, aggregated in one statement over the page being
      // returned. `chaptersFound` is null for a run with no committed envelope
      // yet, which is distinct from a run that found nothing.
      const totals = await ctx.runChapters.totalsForRuns(runs.map((run) => run.id));
      return {
        runs: runs.map((run) => {
          const found = totals.get(run.id);
          return {
            ...run,
            chaptersFound: found ? found.updated : null,
            chaptersSeen: found ? found.all : null,
          };
        }),
      };
    });

    scope.get("/api/v1/admin/runs/:id", { preHandler: requireScope("runs:read") }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const run = await ctx.prisma.run.findUnique({ where: { id }, include: { jobs: true } });
      if (!run) return reply.code(404).send({ error: "unknown run" });
      return { run };
    });

    /**
     * Kill a run in progress: every outstanding job is cancelled, and workers
     * already executing one abort on their next lease renewal.
     *
     * Harder-edged than cancelling a job on purpose. Cancelling one job of a
     * partitioned run leaves the others to finish and the run to be processed
     * from incomplete results, which for a CLEAN run means the processor
     * concludes every chapter the missing segment covers has vanished upstream.
     * Killing the run never reaches the processor.
     */
    scope.post("/api/v1/admin/runs/:id/cancel", { preHandler: requireScope("runs:write") }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const outcome = await ctx.jobs.cancelRun(id);
      if (!outcome) return reply.code(404).send({ error: "unknown run" });
      if (outcome.result === "rejected") {
        return reply
          .code(409)
          .send({ error: `run already finished (${outcome.previousState.toLowerCase()})` });
      }
      await ctx.audit.record(actor(req), "run.cancel", id, {
        jobsCancelled: outcome.jobsCancelled,
        previousState: outcome.previousState,
      });
      return { ok: true, ...outcome };
    });

    /** The same for everything unfinished at once, optionally scoped to one extension. */
    scope.post("/api/v1/admin/runs/cancel-all", { preHandler: requireScope("runs:write") }, async (req) => {
      const body = z.object({ extension: z.string().min(1).max(64).optional() }).parse(req.body ?? {});
      const stopped = await ctx.jobs.cancelActiveRuns(body.extension);
      await ctx.audit.record(actor(req), "run.cancel_all", body.extension ?? "*", stopped);
      return { ok: true, ...stopped };
    });

    scope.post("/api/v1/admin/jobs/:id/cancel", { preHandler: requireScope("runs:write") }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const result = await ctx.jobs.cancel(id);
      if (result === "rejected") return reply.code(409).send({ error: "job not cancellable" });
      await ctx.audit.record(actor(req), "job.cancel", id, { result });
      return { ok: true, result };
    });

    scope.post("/api/v1/admin/jobs/:id/retry", { preHandler: requireScope("runs:write") }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const ok = await ctx.jobs.replayDeadLetter(id);
      if (!ok) return reply.code(409).send({ error: "job is not dead-lettered" });
      await ctx.audit.record(actor(req), "job.retry", id);
      return { ok: true };
    });

    scope.get("/api/v1/admin/dead-letter", { preHandler: requireScope("runs:read") }, async () => {
      const jobs = await ctx.prisma.job.findMany({
        where: { state: "DEAD_LETTER" },
        orderBy: { updatedAt: "desc" },
        take: 100,
      });
      return { jobs };
    });

    scope.get("/api/v1/admin/quarantine", { preHandler: requireScope("runs:read") }, async () => {
      const results = await ctx.prisma.resultSubmission.findMany({
        where: { state: "QUARANTINED" },
        orderBy: { createdAt: "desc" },
        take: 100,
        select: {
          id: true,
          jobId: true,
          workerId: true,
          rejectReason: true,
          createdAt: true,
        },
      });
      return { quarantined: results };
    });

    // ---- pause / resume ----
    scope.post("/api/v1/admin/pause", { preHandler: requireScope("settings:write") }, async (req) => {
      const body = z
        .object({ minutes: z.number().int().min(1).max(1440).nullable().optional() })
        .parse(req.body ?? {});
      const until =
        body.minutes == null ? Infinity : Date.now() / 1000 + body.minutes * 60;
      await ctx.settings.setPauseUntil(until);
      await ctx.audit.record(actor(req), "platform.pause", undefined, { minutes: body.minutes ?? null });
      return { ok: true, paused: true, indefinite: body.minutes == null };
    });

    scope.post("/api/v1/admin/resume", { preHandler: requireScope("settings:write") }, async (req) => {
      await ctx.settings.setPauseUntil(0);
      await ctx.audit.record(actor(req), "platform.resume");
      return { ok: true, paused: false };
    });

    // ---- extensions ----
    scope.get("/api/v1/admin/extensions", { preHandler: requireScope("extensions:read") }, async () => {
      const bundles = await ctx.bundles.listLatest();
      const disabled = new Set(await ctx.settings.listDisabled());
      return {
        extensions: bundles.map((b) => ({
          name: b.extension,
          version: b.version,
          sha256: b.sha256,
          disabled: disabled.has(b.extension),
          publishedAt: b.publishedAt,
        })),
      };
    });

    /**
     * Unload an extension. Disabling stops scheduling and outstanding work:
     * queued jobs are cancelled and running ones told to abort, so "disabled"
     * means now rather than after the queue drains. The claim query also refuses
     * disabled extensions, so nothing slips through between the two statements.
     */
    scope.post(
      "/api/v1/admin/extensions/:name/disable",
      { preHandler: requireScope("extensions:write") },
      async (req, reply) => {
        const { name } = req.params as { name: string };
        if (!EXTENSION_NAME_RE.test(name)) return reply.code(400).send({ error: "bad name" });
        await ctx.settings.disable(name);
        const stopped = await ctx.jobs.cancelAllForExtension(name);
        await ctx.audit.record(actor(req), "extension.disable", name, stopped);
        return { ok: true, disabled: true, ...stopped };
      },
    );

    scope.post(
      "/api/v1/admin/extensions/:name/enable",
      { preHandler: requireScope("extensions:write") },
      async (req, reply) => {
        const { name } = req.params as { name: string };
        if (!EXTENSION_NAME_RE.test(name)) return reply.code(400).send({ error: "bad name" });
        await ctx.settings.enable(name);
        await ctx.audit.record(actor(req), "extension.enable", name);
        return { ok: true, disabled: false };
      },
    );

    // ---- schedules ----
    scope.get("/api/v1/admin/schedules", { preHandler: requireScope("extensions:read") }, async () => {
      const overrides = await ctx.settings.getScheduleOverrides();
      const bundles = await ctx.bundles.listLatest();
      const defaults: Record<string, unknown> = {};
      for (const b of bundles) {
        const m = Manifest.safeParse(b.manifest);
        if (m.success && m.data.schedule) defaults[b.extension] = m.data.schedule;
      }
      return { defaults, overrides };
    });

    scope.put("/api/v1/admin/schedules/:name", { preHandler: requireScope("extensions:write") }, async (req, reply) => {
      const { name } = req.params as { name: string };
      if (!EXTENSION_NAME_RE.test(name)) return reply.code(400).send({ error: "bad name" });
      const body = z
        .object({
          hour: z.number().int().min(0).max(23),
          minute: z.number().int().min(0).max(59),
          day: z.number().int().min(0).max(6).optional(),
        })
        .parse(req.body);
      await ctx.settings.upsertSchedule(name, body.hour, body.minute, body.day);
      await ctx.audit.record(actor(req), "schedule.set", name, body);
      return { ok: true };
    });

    scope.delete("/api/v1/admin/schedules/:name", { preHandler: requireScope("extensions:write") }, async (req) => {
      const { name } = req.params as { name: string };
      const removed = await ctx.settings.removeSchedule(name);
      await ctx.audit.record(actor(req), "schedule.remove", name, { removed });
      return { ok: true, removed };
    });

    // ---- removal mode ----
    scope.get("/api/v1/admin/removal-mode", { preHandler: requireScope("settings:read") }, async () => ({
      mode: await ctx.settings.getRemovalMode(),
      validModes: VALID_REMOVAL_MODES,
    }));

    scope.post("/api/v1/admin/removal-mode", { preHandler: requireScope("settings:write") }, async (req) => {
      const body = z.object({ mode: z.enum(VALID_REMOVAL_MODES) }).parse(req.body);
      await ctx.settings.setRemovalMode(body.mode);
      await ctx.audit.record(actor(req), "removal_mode.set", body.mode);
      return { ok: true, mode: body.mode };
    });

    // ---- webhook verbosity ----
    // Only the successful per-chapter embeds are switchable. Failures are
    // deliberately not offered as a toggle.
    scope.get(
      "/api/v1/admin/webhook-verbosity",
      { preHandler: requireScope("settings:read") },
      async () => ({ uploadSuccesses: await ctx.settings.getWebhookUploadSuccesses() }),
    );

    scope.post(
      "/api/v1/admin/webhook-verbosity",
      { preHandler: requireScope("settings:write") },
      async (req) => {
        const body = z.object({ uploadSuccesses: z.boolean() }).parse(req.body);
        await ctx.settings.setWebhookUploadSuccesses(body.uploadSuccesses);
        await ctx.audit.record(actor(req), "webhook_verbosity.set", String(body.uploadSuccesses));
        return { ok: true, uploadSuccesses: body.uploadSuccesses };
      },
    );

    // ---- bundles ----
    scope.post(
      "/api/v1/admin/bundles",
      { bodyLimit: MAX_BUNDLE_BYTES, preHandler: requireScope("bundles:write") },
      async (req, reply) => {
        if (!Buffer.isBuffer(req.body)) {
          return reply.code(400).send({ error: "zip body required (content-type application/zip)" });
        }
        let manifestRaw: unknown;
        try {
          const zip = new AdmZip(req.body);
          const entry = zip.getEntry("manifest.json");
          if (!entry) return reply.code(422).send({ error: "bundle missing manifest.json" });
          manifestRaw = JSON.parse(entry.getData().toString("utf8"));
        } catch {
          return reply.code(422).send({ error: "invalid zip" });
        }
        const sourceCommit = (req.headers["x-source-commit"] as string | undefined)?.slice(0, 64);
        // The header alone is recorded even when the publish then fails for some
        // other reason, so republishing a pre-v2 python bundle always leaves a
        // trace.
        const allowLegacy = req.headers["x-allow-legacy-runtime"] === "true";
        if (allowLegacy) {
          await ctx.audit.record(actor(req), "bundle.publish.legacy_runtime_override", "requested", {
            sourceCommit,
          });
        }
        try {
          const { bundle, created, warnings } = await ctx.bundles.publish({
            zipData: req.body,
            manifest: manifestRaw,
            sourceCommit,
            allowLegacy,
          });
          await ctx.audit.record(actor(req), "bundle.publish", `${bundle.extension}@${bundle.version}`, {
            sha256: bundle.sha256,
            sourceCommit,
            created,
            ...(allowLegacy ? { allowLegacy: true } : {}),
            ...(warnings.length > 0 ? { warnings } : {}),
          });
          return reply.code(created ? 201 : 200).send({
            extension: bundle.extension,
            version: bundle.version,
            sha256: bundle.sha256,
            created,
            // Worth an operator's attention but not grounds for refusing the
            // bundle. Empty on a clean publish.
            warnings,
          });
        } catch (err) {
          // A rejected bundle already carries an operator-readable reason.
          if (err instanceof BundleRejectedError) {
            return reply.code(422).send({ error: err.message });
          }
          return reply.code(422).send({ error: `manifest validation failed: ${String(err)}` });
        }
      },
    );

    // ---- tracked manga & extension config (DB is the config authority) ----
    scope.get("/api/v1/admin/extensions/:name/tracked", { preHandler: requireScope("tracked:read") }, async (req, reply) => {
      const { name } = req.params as { name: string };
      if (!EXTENSION_NAME_RE.test(name)) return reply.code(400).send({ error: "bad name" });
      // `namespace` filters to one catalogue; omitting it returns them all.
      const query = z.object({ namespace: z.string().max(MAX_NAMESPACE_LENGTH).optional() }).parse(req.query ?? {});
      const rows = await ctx.prisma.trackedManga.findMany({
        where: {
          extension: name,
          ...(query.namespace === undefined
            ? {}
            : { namespace: normaliseNamespace(query.namespace) }),
        },
        orderBy: { createdAt: "asc" },
      });
      return { tracked: rows, namespaces: await ctx.trackedManga.namespaces(name) };
    });

    scope.put("/api/v1/admin/extensions/:name/tracked", { preHandler: requireScope("tracked:append") }, async (req, reply) => {
      const { name } = req.params as { name: string };
      if (!EXTENSION_NAME_RE.test(name)) return reply.code(400).send({ error: "bad name" });
      const body = z
        .object({
          mangaId: z.string().min(1).max(512),
          mdMangaId: z.string().uuid(),
          /** The extension's catalogue; omit for the single flat id space. */
          namespace: z.string().max(MAX_NAMESPACE_LENGTH).optional(),
        })
        .parse(req.body);
      const namespace = normaliseNamespace(body.namespace);
      if (namespace !== DEFAULT_NAMESPACE && !NAMESPACE_RE.test(namespace)) {
        return reply.code(400).send({ error: `namespace must match ${String(NAMESPACE_RE)}` });
      }
      const identity = { extension: name, namespace, mangaId: body.mangaId };
      // Reachable with tracked:append, which must not be able to repoint an
      // existing series at a different title: that is an edit, and a silent one.
      const existing = await ctx.prisma.trackedManga.findUnique({
        where: { extension_namespace_mangaId: identity },
      });
      if (
        existing &&
        existing.mdMangaId !== body.mdMangaId &&
        !hasScope(req.principal!, "tracked:write")
      ) {
        return reply.code(403).send({
          error: `${body.mangaId} is already mapped to ${existing.mdMangaId}; changing an existing mapping needs scope tracked:write`,
        });
      }
      await ctx.prisma.trackedManga.upsert({
        where: { extension_namespace_mangaId: identity },
        create: { ...identity, mdMangaId: body.mdMangaId, source: actor(req) },
        update: { mdMangaId: body.mdMangaId, source: actor(req) },
      });
      await ctx.audit.record(actor(req), "tracked_manga.set", trackedSubject(name, namespace, body.mangaId), {
        ...body,
        namespace,
      });
      return { ok: true };
    });

    scope.delete("/api/v1/admin/extensions/:name/tracked/:mangaId", { preHandler: requireScope("tracked:write") }, async (req) => {
      const { name, mangaId } = req.params as { name: string; mangaId: string };
      const query = z.object({ namespace: z.string().max(MAX_NAMESPACE_LENGTH).optional() }).parse(req.query ?? {});
      // A query parameter rather than a second path segment, so the flat-space
      // URL every existing client uses keeps working unchanged.
      const namespace = normaliseNamespace(query.namespace);
      const res = await ctx.prisma.trackedManga.deleteMany({
        where: { extension: name, namespace, mangaId },
      });
      await ctx.audit.record(actor(req), "tracked_manga.remove", trackedSubject(name, namespace, mangaId));
      return { ok: true, removed: res.count > 0 };
    });

    /**
     * Bulk curation. `set` adds (or, with tracked:write, repoints) mappings and
     * `remove` deletes them; `text` accepts the pasted `externalId,titleId`
     * format (or `namespace,externalId,titleId`). Rows are judged and reported
     * individually, so a contributor pasting 200 lines learns which three were
     * wrong.
     *
     * `namespace` at the top level is the default for rows that do not name one.
     */
    scope.post(
      "/api/v1/admin/extensions/:name/tracked/batch",
      { preHandler: requireScope("tracked:append") },
      async (req, reply) => {
        const { name } = req.params as { name: string };
        if (!EXTENSION_NAME_RE.test(name)) return reply.code(400).send({ error: "bad name" });
        const body = z
          .object({
            set: z
              .array(
                z.object({
                  mangaId: z.string().min(1).max(512),
                  mdMangaId: z.string(),
                  namespace: z.string().max(MAX_NAMESPACE_LENGTH).optional(),
                }),
              )
              .max(MAX_BATCH_ROWS)
              .optional(),
            remove: z
              .array(
                z.union([
                  z.string().min(1).max(512),
                  z.object({
                    mangaId: z.string().min(1).max(512),
                    namespace: z.string().max(MAX_NAMESPACE_LENGTH).optional(),
                  }),
                ]),
              )
              .max(MAX_BATCH_ROWS)
              .optional(),
            /** Pasted lines: `[namespace,]externalId,mdMangaId` (order-insensitive). */
            text: z.string().max(512 * 1024).optional(),
            /** Default catalogue for `set`/`text` rows that do not name one. */
            namespace: z.string().max(MAX_NAMESPACE_LENGTH).optional(),
            /** Report what would happen without writing anything. */
            dryRun: z.boolean().default(false),
          })
          .parse(req.body ?? {});

        const defaultNamespace = normaliseNamespace(body.namespace);
        if (defaultNamespace !== DEFAULT_NAMESPACE && !NAMESPACE_RE.test(defaultNamespace)) {
          return reply.code(400).send({ error: `namespace must match ${String(NAMESPACE_RE)}` });
        }
        const parsed = body.text
          ? parsePairs(body.text, { defaultNamespace })
          : { rows: [], errors: [] };
        const set = [...(body.set ?? []), ...parsed.rows];
        if (set.length + (body.remove?.length ?? 0) === 0 && parsed.errors.length === 0) {
          return reply.code(400).send({ error: "nothing to do: provide set, remove, or text" });
        }
        if (set.length > MAX_BATCH_ROWS) {
          return reply.code(413).send({ error: `at most ${MAX_BATCH_ROWS} rows per batch` });
        }

        const canWrite = hasScope(req.principal!, "tracked:write");
        if (body.dryRun) {
          // Same judgement, no writes: the store skips its write transaction.
          const preview = await ctx.trackedManga.applyBatch(
            name,
            { set, remove: body.remove },
            { canWrite, source: actor(req), dryRun: true },
          );
          return { dryRun: true, parseErrors: parsed.errors, ...preview };
        }

        const summary = await ctx.trackedManga.applyBatch(name, { set, remove: body.remove }, {
          canWrite,
          source: actor(req),
        });
        await ctx.audit.record(actor(req), "tracked_manga.batch", name, {
          added: summary.added,
          updated: summary.updated,
          removed: summary.removed,
          failed: summary.failed,
        });
        return { dryRun: false, parseErrors: parsed.errors, ...summary };
      },
    );

    /**
     * The whole override-options document, reassembled from the three relation
     * tables and the free-form remainder, so `GET | PUT` round-trips. The split
     * is reported too: `same`, `multi_chapters` and `custom_language` are the
     * modelled ones, `passthrough` is what core does not interpret.
     */
    scope.get("/api/v1/admin/extensions/:name/config", { preHandler: requireScope("extensions:read") }, async (req, reply) => {
      const { name } = req.params as { name: string };
      if (!EXTENSION_NAME_RE.test(name)) return reply.code(400).send({ error: "bad name" });
      // The allowlist ships with the payload so the editor validates a language
      // code against the exact list the write path enforces; a second copy in the
      // dashboard would drift.
      return { ...(await ctx.extensionConfig.describe(name)), mangadexLanguages: MANGADEX_LANGUAGES };
    });

    scope.put("/api/v1/admin/extensions/:name/config", { preHandler: requireScope("extensions:write") }, async (req, reply) => {
      const { name } = req.params as { name: string };
      if (!EXTENSION_NAME_RE.test(name)) return reply.code(400).send({ error: "bad name" });
      const body = z.object({ overrideOptions: z.record(z.unknown()) }).parse(req.body);
      // Rows the constraints refuse come back as `rejected` rather than a 4xx:
      // one unrecognised language code should not discard an otherwise good
      // document.
      const result = await ctx.extensionConfig.replace(name, body.overrideOptions);
      await ctx.audit.record(actor(req), "extension_config.set", name, {
        aliases: result.aliases,
        multiChapters: result.multiChapters,
        languages: result.languages,
        passthroughKeys: result.passthroughKeys,
        rejected: result.rejected.length,
      });
      return { ok: true, ...result };
    });

    /**
     * Run the series-map write-back now instead of waiting for the weekly timer.
     * Same code path the timer uses, so a dry run is an honest preview.
     *
     * `tracked:write` rather than `tracked:read`: this publishes the map to a git
     * repository and, with `force`, can delete mappings from a file contributors
     * read. Even the dry run is gated, because its output lists the full contents
     * of a private repo's map.
     */
    scope.post("/api/v1/admin/maps/sync", { preHandler: requireScope("tracked:write") }, async (req) => {
      const body = parseOrThrow(
        z.object({
          dryRun: z.boolean().default(false),
          /** Bypass the shrink guard. Deliberately not exposed to the timer. */
          force: z.boolean().default(false),
          extensions: z.array(z.string().regex(EXTENSION_NAME_RE)).max(50).default([]),
        }),
        req.body ?? {},
      );
      const service = MapSyncService.fromConfig(ctx.config, {
        prisma: ctx.prisma,
        log: ctx.log,
        audit: ctx.audit,
        settings: ctx.settings,
        ...(ctx.mapSyncContents ? { contents: ctx.mapSyncContents } : {}),
      });
      const report = await service.sync({
        dryRun: body.dryRun,
        force: body.force,
        extensions: body.extensions,
        actor: actor(req),
      });
      // A dry run is not an event; only a run that could write is audited, and
      // the per-file writes audit themselves inside the service.
      if (!body.dryRun) {
        await ctx.audit.record(actor(req), "map_sync.run", "manual", {
          written: report.written,
          failed: report.failed,
          force: body.force,
          extensions: body.extensions,
        });
      }
      return { ok: report.failed === 0, ...report };
    });

    // ---- untracked series pipeline ----
    scope.get("/api/v1/admin/untracked", { preHandler: requireScope("untracked:read") }, async (req) => {
      const query = z
        .object({
          state: z.enum(["NEW", "CREATING", "CREATED", "TRACKED", "FAILED", "SKIPPED"]).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        })
        .parse(req.query ?? {});
      const rows = await ctx.prisma.untrackedManga.findMany({
        where: query.state ? { state: query.state } : undefined,
        orderBy: { createdAt: "desc" },
        take: query.limit,
      });
      return { untracked: rows };
    });

    scope.post("/api/v1/admin/untracked/:id/approve", { preHandler: requireScope("untracked:write") }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!ctx.titleService) {
        return reply.code(503).send({ error: "title service not available on this instance" });
      }
      const result = await ctx.titleService.approve(id, actor(req));
      if ("error" in result) return reply.code(409).send(result);
      return { ok: true, ...result };
    });

    scope.post("/api/v1/admin/untracked/:id/skip", { preHandler: requireScope("untracked:write") }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const res = await ctx.prisma.untrackedManga.updateMany({
        where: { id, state: { in: ["NEW", "FAILED"] } },
        data: { state: "SKIPPED" },
      });
      if (res.count !== 1) return reply.code(409).send({ error: "not skippable" });
      await ctx.audit.record(actor(req), "untracked.skip", id);
      return { ok: true };
    });

    /**
     * Yank a bundle version. `latest()` then resolves to the previous non-yanked
     * version, so this rolls back a bad extension release without touching the
     * core or deleting anything. Jobs already pinned to the yanked sha keep
     * running unless `cancelPinned` is set, since pinning is what makes a run
     * reproducible.
     */
    scope.post(
      "/api/v1/admin/bundles/:extension/:version/yank",
      { preHandler: requireScope("bundles:write") },
      async (req, reply) => {
        const { extension, version } = req.params as { extension: string; version: string };
        const body = z.object({ cancelPinned: z.boolean().default(false) }).parse(req.body ?? {});
        const bundle = await ctx.prisma.bundle.findUnique({
          where: { extension_version: { extension, version } },
        });
        if (!bundle) return reply.code(404).send({ error: "unknown bundle version" });

        const yanked = await ctx.bundles.yank(extension, version);
        const stopped = body.cancelPinned
          ? await ctx.jobs.cancelAllForBundle(bundle.sha256)
          : { cancelled: 0, flagged: 0 };
        const fallback = await ctx.bundles.latest(extension);
        await ctx.audit.record(actor(req), "bundle.yank", `${extension}@${version}`, {
          sha256: bundle.sha256,
          ...stopped,
          nowLatest: fallback?.version ?? null,
        });
        return {
          ok: yanked,
          yanked: `${extension}@${version}`,
          nowLatest: fallback ? { version: fallback.version, sha256: fallback.sha256 } : null,
          ...stopped,
        };
      },
    );

    scope.get(
      "/api/v1/admin/bundles/:extension/versions",
      { preHandler: requireScope("bundles:read") },
      async (req) => {
        const { extension } = req.params as { extension: string };
        const versions = await ctx.prisma.bundle.findMany({
          where: { extension },
          orderBy: { publishedAt: "desc" },
          select: {
            version: true,
            sha256: true,
            yanked: true,
            sourceCommit: true,
            publishedAt: true,
          },
        });
        return { extension, versions };
      },
    );

    // ---- observability ----
    scope.get("/api/v1/admin/stats", { preHandler: requireScope("stats:read") }, async () => {
      const [jobCounts, taskDepths, workerCount, quarantined, outstanding] = await Promise.all([
        ctx.prisma.job.groupBy({ by: ["state"], _count: true }),
        ctx.uploadTasks.depths(),
        ctx.prisma.worker.groupBy({ by: ["status"], _count: true }),
        ctx.prisma.resultSubmission.count({ where: { state: "QUARANTINED" } }),
        countOutstandingErrors(ctx.prisma),
      ]);
      return {
        jobs: Object.fromEntries(jobCounts.map((r) => [r.state, r._count])),
        uploadTasks: taskDepths,
        workers: Object.fromEntries(workerCount.map((r) => [r.status, r._count])),
        quarantined,
        /**
         * Failures nobody has dealt with yet, across all three error sources.
         *
         * `quarantined` above is a state count and stays one; this is the triage
         * number, and the difference is acknowledgements; an operator who has
         * cleared the feed sees 0 here while `quarantined` still reports the rows
         * that are, in fact, still quarantined. The dashboard badge uses this one:
         * a badge that kept counting handled failures teaches people to ignore
         * badges.
         */
        errorsOutstanding: outstanding,
        paused: await ctx.settings.isPaused(),
      };
    });

    /**
     * The audit trail, filterable.
     *
     * `?id=` is what makes a dashboard permalink resolve to its event however
     * old it is; the rest are the filters an operator reaches for next.
     *
     * `id` is the primary key and `createdAt` and `action` each carry an index.
     * The `actor`, `action` and `subject` substring matches could not use an
     * index whatever we added, so they are bounded by `limit` and the time window
     * instead.
     *
     * Paging is offered both ways: `offset` for a "page 4 of 40" control,
     * `cursor` (the id of the previous page's last row) for stability while
     * events are still being written. Sorting on (createdAt, id) rather than
     * createdAt alone is what makes the cursor total.
     */
    scope.get("/api/v1/admin/audit", { preHandler: requireScope("audit:read") }, async (req, reply) => {
      const query = parseOrThrow(
        z.object({
          id: z.string().max(64).optional(),
          actor: z.string().max(128).optional(),
          action: z.string().max(128).optional(),
          subject: z.string().max(256).optional(),
          /** ISO instants; omitted means unbounded on that side. */
          since: z.coerce.date().optional(),
          until: z.coerce.date().optional(),
          /** The id of the last row of the previous page. */
          cursor: z.string().max(64).optional(),
          offset: z.coerce.number().int().min(0).max(100_000).default(0),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
        req.query ?? {},
      );

      const insensitive = { mode: "insensitive" } as const;
      const where: Prisma.AuditEventWhereInput = {
        ...(query.id ? { id: query.id } : {}),
        ...(query.actor ? { actor: { contains: query.actor, ...insensitive } } : {}),
        ...(query.action ? { action: { contains: query.action, ...insensitive } } : {}),
        ...(query.subject ? { subject: { contains: query.subject, ...insensitive } } : {}),
        ...(query.since || query.until
          ? {
              createdAt: {
                ...(query.since ? { gte: query.since } : {}),
                ...(query.until ? { lte: query.until } : {}),
              },
            }
          : {}),
      };

      // Keyset paging needs the cursor row's own sort key, so it is read first.
      // An unknown cursor is a client error rather than an empty page, which
      // would read as "there is nothing older".
      let keyset: Prisma.AuditEventWhereInput | null = null;
      if (query.cursor) {
        const at = await ctx.prisma.auditEvent.findUnique({
          where: { id: query.cursor },
          select: { id: true, createdAt: true },
        });
        if (!at) return reply.code(400).send({ error: `unknown cursor: ${query.cursor}` });
        keyset = {
          OR: [{ createdAt: { lt: at.createdAt } }, { createdAt: at.createdAt, id: { lt: at.id } }],
        };
      }
      const filter = keyset ? { AND: [where, keyset] } : where;

      const [events, total] = await Promise.all([
        ctx.prisma.auditEvent.findMany({
          where: filter,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: query.limit,
          // A cursor already encodes the position, so honouring offset as well
          // would skip rows twice.
          skip: keyset ? 0 : query.offset,
        }),
        // The total is what makes paging honest: without it a caller cannot tell
        // "that is all of them" from "here is the first page of four thousand".
        ctx.prisma.auditEvent.count({ where }),
      ]);

      return {
        events,
        total,
        limit: query.limit,
        offset: keyset ? null : query.offset,
        // Null on the last page, so a caller can stop without a second request
        // that comes back empty.
        nextCursor: events.length === query.limit ? (events[events.length - 1]?.id ?? null) : null,
      };
    });
  });
}
