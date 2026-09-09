import { setTimeout as sleep } from "node:timers/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { workerAuthHook } from "../auth.js";
import { MAX_ENVELOPE_BYTES } from "../../../contracts/envelope.js";
import { MAX_ARTIFACT_BYTES } from "../../store/artifacts.js";
import { activeTrackedWhere, buildMangaIdMap } from "../../store/trackedManga.js";
import { hashToken } from "../../store/workers.js";
import { metrics } from "../../../metrics.js";

const EnrollBody = z.object({
  enrollToken: z.string().min(8).max(256),
  name: z.string().min(1).max(128),
  extensions: z.array(z.string().max(128)).max(256).default([]),
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
      const capable = worker.extensions;
      const requested = body.data.extensions;
      // A worker may narrow, never widen, its registered capability set.
      const extensions =
        capable.length > 0
          ? requested
            ? requested.filter((e) => capable.includes(e))
            : capable
          : requested;

      const deadline = Date.now() + waitSeconds * 1000;
      do {
        // Answered like a drained worker rather than with a bare 204: an empty
        // 204 sends the agent back in a second, so every worker polls the core
        // once a second for the length of the pause. `drained` idles it for a
        // minute, which is what a platform that is handing out nothing wants.
        if (await ctx.settings.isPaused()) {
          return reply.code(204).header("x-publoader-drained", "true").send();
        }
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
          const [trackedRows, overrideOptions, fetchThrottle] = await Promise.all([
            ctx.prisma.trackedManga.findMany({
              // Paused series are left out of the map entirely, which is what
              // makes the pause cost nothing: an extension cannot fetch, report
              // or spend a request on a series it was never told about. The
              // matching filter in authoritativeTrackedIds is what stops their
              // absence from `allChapters` reading as a withdrawal.
              where: activeTrackedWhere(claimed.job.extension),
              select: { namespace: true, mangaId: true, mdMangaId: true },
            }),
            ctx.extensionConfig.loadForLease(claimed.job.extension),
            // Resolved here rather than in the worker: how hard our addresses
            // hit a publisher is the operator's decision, and a worker that
            // computed it from parts could disagree with the dashboard showing
            // it. The runner receives an answer, not a policy.
            ctx.settings.getFetchThrottle(claimed.job.extension),
          ]);
          // Delivered in the legacy manga_id_map shape; flat
          // {mdMangaId: [externalIds]} while the extension has one id space, and
          // {namespace: {mdMangaId: [externalIds]}} once it has more, which is
          // the shape viz's own file already has. See MangaIdMapPayload for why
          // `namespaced` travels alongside it.
          const { mangaIdMap, namespaced } = buildMangaIdMap(trackedRows);
          const postedChapterIds =
            claimed.job.kind === "CLEAN"
              ? []
              : (
                  await ctx.prisma.uploadedId.findMany({
                    where: { extension: claimed.job.extension },
                    select: { chapterId: true },
                  })
                ).map((r) => r.chapterId);
          metrics.jobsLeased.inc({ extension: claimed.job.extension });
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
              segmentMangaIds: claimed.job.segmentMangaIds,
              timeoutSeconds: claimed.job.timeoutSeconds,
              manifest: bundle?.manifest ?? null,
              postedChapterIds,
              mangaIdMap,
              mangaIdMapNamespaced: namespaced,
              overrideOptions,
              fetchThrottle,
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
      // A job leased in the moment before the pause landed must not begin.
      // Handed back here rather than left for the sweeper, which would hold it
      // LEASED for the whole TTL and then charge it a failed attempt.
      if (await ctx.settings.isPaused()) {
        await ctx.jobs.releaseForPause(jobId, body.data.leaseId);
        ctx.log.info({ jobId, workerId: req.worker!.id }, "platform paused; job released before start");
        return reply.code(409).send({ error: "platform is paused" });
      }
      const ok = await ctx.jobs.start(jobId, body.data.leaseId);
      if (!ok) return reply.code(409).send({ error: "lease not current" });
      return { ok: true };
    });

    scope.post("/api/v1/worker/jobs/:jobId/renew", async (req, reply) => {
      const { jobId } = req.params as { jobId: string };
      const body = RenewBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.message });
      /**
       * The pause reaches work that is ALREADY RUNNING through here, and only
       * through here. Everything else gates the NEXT thing: a catalogue scrape
       * runs for tens of minutes, so a pause that waits for it is a pause that
       * does not visibly pause anything.
       *
       * The lease goes back to PENDING and the worker is answered the way a
       * lost lease is answered, so it aborts the runner and abandons the job
       * WITHOUT submitting -- no envelope, no failed attempt, nothing for the
       * error feed. `releaseForPause` returns the attempt too, so pausing costs
       * the job none of its retry budget; it is simply claimed again after the
       * resume, which the claim gate holds off until then.
       */
      if (await ctx.settings.isPaused()) {
        await ctx.jobs.releaseForPause(jobId, body.data.leaseId);
        ctx.log.info({ jobId, workerId: req.worker!.id }, "platform paused; running job released");
        return reply.code(409).send({ error: "platform is paused" });
      }
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
        .send(Buffer.from(bundle.archive));
    });
  });
}
