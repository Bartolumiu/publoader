import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { adminAuthHook } from "../auth.js";
import { sessionAuthenticator } from "../session.js";
import { Manifest, EXTENSION_NAME_RE } from "../../../contracts/manifest.js";
import { VALID_REMOVAL_MODES } from "../../store/settings.js";
import { BundleRejectedError } from "../../store/bundles.js";
import AdmZip from "adm-zip";

const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

/**
 * Admin-audience routes. Consumed by the operator CLI, the Discord bot, and
 * the dashboard. Every mutating action is written to the audit log with the
 * acting principal.
 */
export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
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
    // Bearer clients (bot, CLI) name themselves with X-Actor. Dashboard
    // sessions carry the operator name in the cookie, so they need no header.
    const actor = (req: FastifyRequest) =>
      `admin:${(req.headers["x-actor"] as string | undefined)?.slice(0, 64) ?? req.adminActor ?? "unknown"}`;

    // ---- worker fleet ----
    scope.post("/api/v1/admin/enroll-tokens", async (req) => {
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
      return token;
    });

    scope.get("/api/v1/admin/workers", async () => {
      const workers = await ctx.workers.list();
      return {
        workers: workers.map((w) => ({
          id: w.id,
          name: w.name,
          status: w.status,
          trust: w.trust,
          capabilities: w.capabilities,
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
      scope.post(`/api/v1/admin/workers/:id/${action}`, async (req, reply) => {
        const { id } = req.params as { id: string };
        const ok = await ctx.workers.setStatus(id, status);
        if (!ok) return reply.code(404).send({ error: "unknown worker" });
        await ctx.audit.record(actor(req), `worker.${action}`, id);
        return { ok: true, status };
      });
    }

    // ---- runs & jobs ----
    scope.post("/api/v1/admin/runs", async (req, reply) => {
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

    scope.get("/api/v1/admin/runs", async (req) => {
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
      return { runs };
    });

    scope.get("/api/v1/admin/runs/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const run = await ctx.prisma.run.findUnique({ where: { id }, include: { jobs: true } });
      if (!run) return reply.code(404).send({ error: "unknown run" });
      return { run };
    });

    scope.post("/api/v1/admin/jobs/:id/cancel", async (req, reply) => {
      const { id } = req.params as { id: string };
      const result = await ctx.jobs.cancel(id);
      if (result === "rejected") return reply.code(409).send({ error: "job not cancellable" });
      await ctx.audit.record(actor(req), "job.cancel", id, { result });
      return { ok: true, result };
    });

    scope.post("/api/v1/admin/jobs/:id/retry", async (req, reply) => {
      const { id } = req.params as { id: string };
      const ok = await ctx.jobs.replayDeadLetter(id);
      if (!ok) return reply.code(409).send({ error: "job is not dead-lettered" });
      await ctx.audit.record(actor(req), "job.retry", id);
      return { ok: true };
    });

    scope.get("/api/v1/admin/dead-letter", async () => {
      const jobs = await ctx.prisma.job.findMany({
        where: { state: "DEAD_LETTER" },
        orderBy: { updatedAt: "desc" },
        take: 100,
      });
      return { jobs };
    });

    scope.get("/api/v1/admin/quarantine", async () => {
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
    scope.post("/api/v1/admin/pause", async (req) => {
      const body = z
        .object({ minutes: z.number().int().min(1).max(1440).nullable().optional() })
        .parse(req.body ?? {});
      const until =
        body.minutes == null ? Infinity : Date.now() / 1000 + body.minutes * 60;
      await ctx.settings.setPauseUntil(until);
      await ctx.audit.record(actor(req), "platform.pause", undefined, { minutes: body.minutes ?? null });
      return { ok: true, paused: true, indefinite: body.minutes == null };
    });

    scope.post("/api/v1/admin/resume", async (req) => {
      await ctx.settings.setPauseUntil(0);
      await ctx.audit.record(actor(req), "platform.resume");
      return { ok: true, paused: false };
    });

    // ---- extensions ----
    scope.get("/api/v1/admin/extensions", async () => {
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

    for (const [action, method] of [
      ["disable", (e: string) => ctx.settings.disable(e)],
      ["enable", (e: string) => ctx.settings.enable(e)],
    ] as const) {
      scope.post(`/api/v1/admin/extensions/:name/${action}`, async (req, reply) => {
        const { name } = req.params as { name: string };
        if (!EXTENSION_NAME_RE.test(name)) return reply.code(400).send({ error: "bad name" });
        await method(name);
        await ctx.audit.record(actor(req), `extension.${action}`, name);
        return { ok: true };
      });
    }

    // ---- schedules ----
    scope.get("/api/v1/admin/schedules", async () => {
      const overrides = await ctx.settings.getScheduleOverrides();
      const bundles = await ctx.bundles.listLatest();
      const defaults: Record<string, unknown> = {};
      for (const b of bundles) {
        const m = Manifest.safeParse(b.manifest);
        if (m.success && m.data.schedule) defaults[b.extension] = m.data.schedule;
      }
      return { defaults, overrides };
    });

    scope.put("/api/v1/admin/schedules/:name", async (req, reply) => {
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

    scope.delete("/api/v1/admin/schedules/:name", async (req) => {
      const { name } = req.params as { name: string };
      const removed = await ctx.settings.removeSchedule(name);
      await ctx.audit.record(actor(req), "schedule.remove", name, { removed });
      return { ok: true, removed };
    });

    // ---- removal mode ----
    scope.get("/api/v1/admin/removal-mode", async () => ({
      mode: await ctx.settings.getRemovalMode(),
      validModes: VALID_REMOVAL_MODES,
    }));

    scope.post("/api/v1/admin/removal-mode", async (req) => {
      const body = z.object({ mode: z.enum(VALID_REMOVAL_MODES) }).parse(req.body);
      await ctx.settings.setRemovalMode(body.mode);
      await ctx.audit.record(actor(req), "removal_mode.set", body.mode);
      return { ok: true, mode: body.mode };
    });

    // ---- bundles ----
    scope.post(
      "/api/v1/admin/bundles",
      { bodyLimit: MAX_BUNDLE_BYTES },
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
        // Republishing a pre-v2 python bundle is deliberately awkward and
        // always leaves a trace: the header alone is recorded even when the
        // publish then fails for some other reason.
        const allowLegacy = req.headers["x-allow-legacy-runtime"] === "true";
        if (allowLegacy) {
          await ctx.audit.record(actor(req), "bundle.publish.legacy_runtime_override", "requested", {
            sourceCommit,
          });
        }
        try {
          const { bundle, created } = await ctx.bundles.publish({
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
          });
          return reply.code(created ? 201 : 200).send({
            extension: bundle.extension,
            version: bundle.version,
            sha256: bundle.sha256,
            created,
          });
        } catch (err) {
          // A rejected bundle already carries an operator-readable reason;
          // wrapping it in "manifest validation failed" would only bury it.
          if (err instanceof BundleRejectedError) {
            return reply.code(422).send({ error: err.message });
          }
          return reply.code(422).send({ error: `manifest validation failed: ${String(err)}` });
        }
      },
    );

    // ---- tracked manga & extension config (DB is the config authority) ----
    scope.get("/api/v1/admin/extensions/:name/tracked", async (req, reply) => {
      const { name } = req.params as { name: string };
      if (!EXTENSION_NAME_RE.test(name)) return reply.code(400).send({ error: "bad name" });
      const rows = await ctx.prisma.trackedManga.findMany({
        where: { extension: name },
        orderBy: { createdAt: "asc" },
      });
      return { tracked: rows };
    });

    scope.put("/api/v1/admin/extensions/:name/tracked", async (req, reply) => {
      const { name } = req.params as { name: string };
      if (!EXTENSION_NAME_RE.test(name)) return reply.code(400).send({ error: "bad name" });
      const body = z
        .object({ mangaId: z.string().min(1).max(512), mdMangaId: z.string().uuid() })
        .parse(req.body);
      await ctx.prisma.trackedManga.upsert({
        where: { extension_mangaId: { extension: name, mangaId: body.mangaId } },
        create: { extension: name, ...body, source: actor(req) },
        update: { mdMangaId: body.mdMangaId, source: actor(req) },
      });
      await ctx.audit.record(actor(req), "tracked_manga.set", `${name}:${body.mangaId}`, body);
      return { ok: true };
    });

    scope.delete("/api/v1/admin/extensions/:name/tracked/:mangaId", async (req) => {
      const { name, mangaId } = req.params as { name: string; mangaId: string };
      const res = await ctx.prisma.trackedManga.deleteMany({
        where: { extension: name, mangaId },
      });
      await ctx.audit.record(actor(req), "tracked_manga.remove", `${name}:${mangaId}`);
      return { ok: true, removed: res.count > 0 };
    });

    scope.get("/api/v1/admin/extensions/:name/config", async (req, reply) => {
      const { name } = req.params as { name: string };
      if (!EXTENSION_NAME_RE.test(name)) return reply.code(400).send({ error: "bad name" });
      const config = await ctx.prisma.extensionConfig.findUnique({ where: { extension: name } });
      return { extension: name, overrideOptions: config?.overrideOptions ?? {} };
    });

    scope.put("/api/v1/admin/extensions/:name/config", async (req, reply) => {
      const { name } = req.params as { name: string };
      if (!EXTENSION_NAME_RE.test(name)) return reply.code(400).send({ error: "bad name" });
      const body = z.object({ overrideOptions: z.record(z.unknown()) }).parse(req.body);
      await ctx.prisma.extensionConfig.upsert({
        where: { extension: name },
        create: { extension: name, overrideOptions: body.overrideOptions as object },
        update: { overrideOptions: body.overrideOptions as object },
      });
      await ctx.audit.record(actor(req), "extension_config.set", name);
      return { ok: true };
    });

    // ---- untracked series pipeline ----
    scope.get("/api/v1/admin/untracked", async (req) => {
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

    scope.post("/api/v1/admin/untracked/:id/approve", async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!ctx.titleService) {
        return reply.code(503).send({ error: "title service not available on this instance" });
      }
      const result = await ctx.titleService.approve(id, actor(req));
      if ("error" in result) return reply.code(409).send(result);
      return { ok: true, ...result };
    });

    scope.post("/api/v1/admin/untracked/:id/skip", async (req, reply) => {
      const { id } = req.params as { id: string };
      const res = await ctx.prisma.untrackedManga.updateMany({
        where: { id, state: { in: ["NEW", "FAILED"] } },
        data: { state: "SKIPPED" },
      });
      if (res.count !== 1) return reply.code(409).send({ error: "not skippable" });
      await ctx.audit.record(actor(req), "untracked.skip", id);
      return { ok: true };
    });

    // ---- observability ----
    scope.get("/api/v1/admin/stats", async () => {
      const [jobCounts, taskDepths, workerCount, quarantined] = await Promise.all([
        ctx.prisma.job.groupBy({ by: ["state"], _count: true }),
        ctx.uploadTasks.depths(),
        ctx.prisma.worker.groupBy({ by: ["status"], _count: true }),
        ctx.prisma.resultSubmission.count({ where: { state: "QUARANTINED" } }),
      ]);
      return {
        jobs: Object.fromEntries(jobCounts.map((r) => [r.state, r._count])),
        uploadTasks: taskDepths,
        workers: Object.fromEntries(workerCount.map((r) => [r.status, r._count])),
        quarantined,
        paused: await ctx.settings.isPaused(),
      };
    });

    scope.get("/api/v1/admin/audit", async (req) => {
      const query = z
        .object({ limit: z.coerce.number().int().min(1).max(500).default(100) })
        .parse(req.query ?? {});
      return { events: await ctx.audit.recent(query.limit) };
    });
  });
}
