import { setTimeout as sleep } from "node:timers/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { workerAuthHook } from "../auth.js";
import { MAX_ENVELOPE_BYTES } from "../../../contracts/envelope.js";
import { MAX_ARTIFACT_BYTES } from "../../store/artifacts.js";
import { hashToken } from "../../store/workers.js";

const EnrollBody = z.object({
  enrollToken: z.string().min(8).max(256),
  name: z.string().min(1).max(128),
  capabilities: z.object({ extensions: z.array(z.string()).optional() }).partial().default({}),
  agentVersion: z.string().max(64).optional(),
});

const LeaseBody = z.object({
  extensions: z.array(z.string().max(128)).max(256).optional(),
  waitSeconds: z.number().int().min(0).max(55).optional(),
});

const RenewBody = z.object({ leaseId: z.string().uuid() });

/**
 * Worker-audience routes. Everything here is reachable with a worker token
 * only; no route returns secrets or accepts writes outside the worker's own
 * lease scope.
 */
export function registerWorkerRoutes(app: FastifyInstance, ctx: AppContext): void {
  const requireWorker = workerAuthHook(ctx.workers);

  // ---- enrollment (no worker token yet; enroll-token + IP rate limit) ----
  app.post("/api/v1/worker/enroll", async (req, reply) => {
    if (!ctx.enrollLimiter.allow(req.ip)) {
      return reply.code(429).send({ error: "rate limited" });
    }
    const body = EnrollBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    const result = await ctx.workers.enroll(body.data);
    if (!result) {
      await ctx.audit.record(`ip:${req.ip}`, "worker.enroll.rejected", undefined, {
        name: body.data.name,
      });
      return reply.code(403).send({ error: "invalid, expired, or used enrollment token" });
    }
    await ctx.audit.record(`worker:${result.workerId}`, "worker.enroll", result.workerId, {
      name: body.data.name,
      trust: result.trust,
      ip: req.ip,
    });
    return reply.code(201).send(result);
  });

  // ---- authenticated worker routes ----
  app.register(async (scope) => {
    scope.addHook("preHandler", requireWorker);
    scope.addHook("preHandler", async (req, reply) => {
      if (!ctx.workerLimiter.allow(req.worker!.id)) {
        await reply.code(429).send({ error: "rate limited" });
      }
    });

    scope.post("/api/v1/worker/heartbeat", async (req) => {
      const body = z
        .object({ agentVersion: z.string().max(64).optional() })
        .parse(req.body ?? {});
      await ctx.workers.heartbeat(req.worker!.id, body.agentVersion);
      return { ok: true, status: req.worker!.status };
    });

    /** Rotate this worker's own credential; old token dies atomically. */
    scope.post("/api/v1/worker/token/rotate", async (req) => {
      const { randomBytes } = await import("node:crypto");
      const newToken = `pw_${randomBytes(32).toString("base64url")}`;
      await ctx.prisma.worker.update({
        where: { id: req.worker!.id },
        data: { tokenHash: hashToken(newToken) },
      });
      await ctx.audit.record(`worker:${req.worker!.id}`, "worker.token.rotate", req.worker!.id);
      return { workerToken: newToken };
    });

    /**
     * Long-poll lease. Drained workers get 204 + drained flag so the agent
     * idles without hammering. Pause gate stops new leases globally.
     */
    scope.post("/api/v1/worker/lease", async (req, reply) => {
      const worker = req.worker!;
      if (worker.status !== "ACTIVE") {
        return reply.code(204).header("x-publoader-drained", "true").send();
      }
      const body = LeaseBody.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.message });
      const waitSeconds = Math.min(
        body.data.waitSeconds ?? ctx.config.leasePollWaitSeconds,
        ctx.config.leasePollWaitSeconds,
      );
      const capabilities = worker.capabilities as { extensions?: string[] };
      const requested = body.data.extensions;
      // A worker may narrow, never widen, its registered capability set.
      const extensions =
        capabilities.extensions && capabilities.extensions.length > 0
          ? requested
            ? requested.filter((e) => capabilities.extensions!.includes(e))
            : capabilities.extensions
          : requested;

      const deadline = Date.now() + waitSeconds * 1000;
      do {
        if (await ctx.settings.isPaused()) break;
        const claimed = await ctx.jobs.claim(worker.id, {
          extensions,
          trust: worker.trust,
          leaseTtlSeconds: ctx.config.leaseTtlSeconds,
        });
        if (claimed) {
          const bundle = await ctx.bundles.bySha(claimed.job.bundleSha256);
          // Runtime config comes from the DATABASE, not bundle JSON files:
          // the tracked-manga map (including titles auto-created since the
          // bundle was published) and operator-editable override options.
          const [trackedRows, extConfig] = await Promise.all([
            ctx.prisma.trackedManga.findMany({
              where: { extension: claimed.job.extension },
              select: { mangaId: true, mdMangaId: true },
            }),
            ctx.prisma.extensionConfig.findUnique({
              where: { extension: claimed.job.extension },
            }),
          ]);
          // Delivered in the legacy manga_id_map shape {mdMangaId: [externalIds]}
          // so the runner's open_manga_id_map compat needs no translation.
          const mangaIdMap: Record<string, string[]> = {};
          for (const row of trackedRows) {
            (mangaIdMap[row.mdMangaId] ??= []).push(row.mangaId);
          }
          const postedChapterIds =
            claimed.job.kind === "CLEAN"
              ? []
              : (
                  await ctx.prisma.uploadedId.findMany({
                    where: { extension: claimed.job.extension },
                    select: { chapterId: true },
                  })
                ).map((r) => r.chapterId);
          ctx.log.info(
            { jobId: claimed.job.id, workerId: worker.id, extension: claimed.job.extension },
            "job leased",
          );
          return reply.send({
            job: {
              jobId: claimed.job.id,
              runId: claimed.job.runId,
              extension: claimed.job.extension,
              extensionVersion: claimed.job.extensionVersion,
              bundleSha256: claimed.job.bundleSha256,
              kind: claimed.job.kind,
              attempt: claimed.job.attempt,
              segmentIndex: claimed.job.segmentIndex,
              segmentTotal: claimed.job.segmentTotal,
              segmentKey: claimed.job.segmentKey,
              segmentMangaIds: claimed.job.segmentMangaIds ?? [],
              timeoutSeconds: claimed.job.timeoutSeconds,
              manifest: bundle?.manifest ?? null,
              postedChapterIds,
              mangaIdMap,
              overrideOptions: extConfig?.overrideOptions ?? {},
            },
            leaseId: claimed.leaseId,
            leaseExpiresAt: claimed.leaseExpiresAt.toISOString(),
            leaseTtlSeconds: ctx.config.leaseTtlSeconds,
          });
        }
        await sleep(1000);
      } while (Date.now() < deadline);
      return reply.code(204).send();
    });

    scope.post("/api/v1/worker/jobs/:jobId/start", async (req, reply) => {
      const { jobId } = req.params as { jobId: string };
      const body = RenewBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.message });
      const ok = await ctx.jobs.start(jobId, body.data.leaseId);
      if (!ok) return reply.code(409).send({ error: "lease not current" });
      return { ok: true };
    });

    scope.post("/api/v1/worker/jobs/:jobId/renew", async (req, reply) => {
      const { jobId } = req.params as { jobId: string };
      const body = RenewBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.message });
      const renewed = await ctx.jobs.renew(jobId, body.data.leaseId, ctx.config.leaseTtlSeconds);
      if (!renewed) return reply.code(409).send({ error: "lease not current" });
      return {
        ok: true,
        cancelRequested: renewed.cancelRequested,
        leaseExpiresAt: renewed.leaseExpiresAt.toISOString(),
      };
    });

    scope.post(
      "/api/v1/worker/jobs/:jobId/results",
      { bodyLimit: MAX_ENVELOPE_BYTES },
      async (req, reply) => {
        const { jobId } = req.params as { jobId: string };
        const envelope = req.body as Record<string, unknown> | null;
        if (!envelope || envelope["jobId"] !== jobId) {
          return reply.code(400).send({ error: "envelope jobId does not match route" });
        }
        const outcome = await ctx.ingest.ingest(envelope, req.worker!.id);
        if (outcome.outcome === "invalid") {
          return reply.code(422).send(outcome);
        }
        // 200 for every judged outcome: the worker's delivery duty is done
        // whether we committed, superseded, or quarantined.
        return reply.send(outcome);
      },
    );

    scope.post(
      "/api/v1/worker/artifacts",
      { bodyLimit: MAX_ARTIFACT_BYTES + 1024 },
      async (req, reply) => {
        const declared = (req.headers["x-artifact-sha256"] as string | undefined) ?? "";
        const jobId = (req.headers["x-artifact-job-id"] as string | undefined) ?? undefined;
        const contentType = req.headers["content-type"] ?? "application/octet-stream";
        if (!Buffer.isBuffer(req.body)) {
          return reply.code(400).send({ error: "binary body required" });
        }
        const result = await ctx.artifacts.put({
          data: req.body,
          contentType,
          declaredSha256: declared,
          jobId,
          workerId: req.worker!.id,
        });
        if ("error" in result) return reply.code(422).send({ error: result.error });
        return reply.code(201).send({ artifactId: result.artifact.id, sha256: result.artifact.sha256 });
      },
    );

    scope.get("/api/v1/worker/bundles/:sha256", async (req, reply) => {
      const { sha256 } = req.params as { sha256: string };
      if (!/^[a-f0-9]{64}$/.test(sha256)) return reply.code(400).send({ error: "bad sha" });
      const bundle = await ctx.bundles.bySha(sha256);
      if (!bundle) return reply.code(404).send({ error: "unknown bundle" });
      return reply
        .header("content-type", "application/zip")
        .header("x-bundle-sha256", bundle.sha256)
        .header("x-bundle-extension", bundle.extension)
        .header("x-bundle-version", bundle.version)
        .send(Buffer.from(bundle.data));
    });
  });
}
