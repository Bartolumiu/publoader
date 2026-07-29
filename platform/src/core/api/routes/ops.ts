// Not self-registering: server.ts is owned elsewhere, so the integrator wires
// this module in with `registerOpsRoutes(app, ctx)` next to the other route
// modules.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { adminAuthHook, requireScope } from "../auth.js";
import { sessionAuthenticator } from "../session.js";

/**
 * Operational visibility and triage that the legacy Discord IPC commands used
 * to provide and the HTTP API did not (see docs/ipc-to-api-mapping.md §gaps):
 * upload-task queues (`queue_peek` / `queue_clear`), MangaDex session state
 * (`mdauth_status` / `logout`), and a merged error feed standing in for `logs`.
 *
 * The through-line is that an operator should never need a shell on the core
 * container to answer "what is stuck and why". Container logs stay where they
 * are — `docker logs` — because they describe processes, not platform state.
 */

const UPLOAD_TASK_KINDS = ["UPLOAD", "EDIT", "DELETE", "UNAVAILABLE"] as const;
const UPLOAD_TASK_STATES = ["PENDING", "LEASED", "DONE", "FAILED", "DEAD_LETTER"] as const;

/** Settings keys written by MdClient; read-only here (see core/md/client.ts). */
const MD_ACCESS_KEY = "mdauth_access";
const MD_REFRESH_KEY = "mdauth_refresh";

/**
 * `exp` from a JWT payload, WITHOUT verifying the signature.
 *
 * Verification would need MangaDex's signing keys and would prove nothing we
 * act on: this is a "when does the saved session go stale?" readout for a
 * human, and a token we cannot parse is reported as unknown expiry rather than
 * treated as an error. Never returns any other claim — the token itself must
 * not leak through this endpoint.
 */
function jwtExpiry(token: string): Date | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const json: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const exp = (json as { exp?: unknown }).exp;
    if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
    return new Date(exp * 1000);
  } catch {
    return null;
  }
}

export function registerOpsRoutes(app: FastifyInstance, ctx: AppContext): void {
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

    /** Same attribution rules as routes/admin.ts — see the comment there. */
    const actor = (req: FastifyRequest) => {
      const claimed = (req.headers["x-actor"] as string | undefined)?.slice(0, 64);
      const principal = req.principal;
      if (principal?.kind === "api-token") {
        return claimed ? `${principal.name} for ${claimed}` : principal.name;
      }
      if (principal?.kind === "session") return principal.name;
      return `admin:${claimed ?? "root"}`;
    };

    // ---- upload-task queues ----

    /**
     * The row-level view `queue_peek` had, plus the depth summary the Overview
     * needs. `chapter` is deliberately not returned: the payload is large, it
     * is worker-supplied, and nothing in triage needs it — the dedupe key
     * identifies the chapter well enough to find it on MangaDex.
     */
    scope.get("/api/v1/admin/upload-tasks", { preHandler: requireScope("runs:read") }, async (req) => {
      const query = z
        .object({
          kind: z.enum(UPLOAD_TASK_KINDS).optional(),
          state: z.enum(UPLOAD_TASK_STATES).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        })
        .parse(req.query ?? {});

      const [tasks, counts] = await Promise.all([
        ctx.prisma.uploadTask.findMany({
          where: {
            ...(query.kind ? { kind: query.kind } : {}),
            ...(query.state ? { state: query.state } : {}),
          },
          orderBy: { updatedAt: "desc" },
          take: query.limit,
          select: {
            id: true,
            kind: true,
            state: true,
            dedupeKey: true,
            attempt: true,
            maxAttempts: true,
            notBefore: true,
            leaseExpiresAt: true,
            lastError: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
        ctx.uploadTasks.depths(),
      ]);
      return { tasks, counts };
    });

    const taskId = z.object({ id: z.string().uuid() });

    /**
     * Requeue a task the uploader gave up on. The attempt counter resets so the
     * task gets a full budget again — the operator is asserting the cause is
     * fixed, and leaving it at maxAttempts would dead-letter it on the first
     * hiccup.
     */
    scope.post("/api/v1/admin/upload-tasks/:id/retry", { preHandler: requireScope("runs:write") }, async (req, reply) => {
      const { id } = taskId.parse(req.params);
      const res = await ctx.prisma.uploadTask.updateMany({
        where: { id, state: { in: ["DEAD_LETTER", "FAILED"] } },
        data: {
          state: "PENDING",
          attempt: 0,
          notBefore: new Date(),
          leaseId: null,
          leaseExpiresAt: null,
        },
      });
      if (res.count !== 1) {
        const existing = await ctx.prisma.uploadTask.findUnique({
          where: { id },
          select: { state: true },
        });
        if (!existing) return reply.code(404).send({ error: "unknown upload task" });
        return reply.code(409).send({
          error: `upload task is ${existing.state}; only FAILED or DEAD_LETTER tasks can be retried`,
        });
      }
      await ctx.audit.record(actor(req), "upload_task.retry", id);
      return { ok: true, state: "PENDING" };
    });

    /**
     * Abandon a task without running it. There is no CANCELLED state in the
     * enum, so this marks it DONE and records why in `lastError` — the row has
     * to leave the queue, and a silent DONE would be indistinguishable from a
     * chapter that actually uploaded.
     *
     * A LEASED row belongs to an uploader process that is mid-flight: setting
     * it DONE here would race that process into either a duplicate upload or a
     * lost result. The lease has to expire (or the task fail) first.
     */
    scope.post("/api/v1/admin/upload-tasks/:id/cancel", { preHandler: requireScope("runs:write") }, async (req, reply) => {
      const { id } = taskId.parse(req.params);
      const note = `cancelled by operator (${actor(req)}) at ${new Date().toISOString()}; never sent to MangaDex`;
      const res = await ctx.prisma.uploadTask.updateMany({
        where: { id, state: { in: ["PENDING", "FAILED", "DEAD_LETTER"] } },
        data: { state: "DONE", lastError: note, leaseId: null, leaseExpiresAt: null },
      });
      if (res.count !== 1) {
        const existing = await ctx.prisma.uploadTask.findUnique({
          where: { id },
          select: { state: true },
        });
        if (!existing) return reply.code(404).send({ error: "unknown upload task" });
        return reply.code(409).send({
          error:
            existing.state === "LEASED"
              ? "upload task is LEASED by a worker; wait for the lease to expire or requeue stale leases first"
              : `upload task is ${existing.state} and cannot be cancelled`,
        });
      }
      await ctx.audit.record(actor(req), "upload_task.cancel", id, { note });
      return { ok: true, state: "DONE" };
    });

    /**
     * Manual sweep. The uploader sweeps on its own timer; this is the button for
     * when that process died holding leases and the operator does not want to
     * wait out the interval.
     */
    scope.post("/api/v1/admin/upload-tasks/requeue-stale", { preHandler: requireScope("runs:write") }, async (req) => {
      const requeued = await ctx.uploadTasks.sweepExpired();
      await ctx.audit.record(actor(req), "upload_task.requeue_stale", undefined, { requeued });
      return { ok: true, requeued };
    });

    // ---- MangaDex session visibility ----

    /**
     * Is the saved MangaDex session still good? `settings:write` rather than a
     * read scope because the answer is about the platform's own credential
     * state, and the clear button next door is the reason anyone asks.
     *
     * The tokens themselves are never returned — only whether they exist and
     * when the access token stops being usable.
     */
    scope.get("/api/v1/admin/mangadex/auth", { preHandler: requireScope("settings:write") }, async () => {
      const [access, refresh] = await Promise.all([
        ctx.settings.getSetting(MD_ACCESS_KEY),
        ctx.settings.getSetting(MD_REFRESH_KEY),
      ]);
      const expiresAt = access ? jwtExpiry(access) : null;
      const expiresInSeconds =
        expiresAt === null ? null : Math.round((expiresAt.getTime() - Date.now()) / 1000);
      return {
        hasAccess: access !== null,
        hasRefresh: refresh !== null,
        expiresAt,
        // Unknown expiry is not "expired": an unparseable token may still work,
        // and reporting it as dead would send an operator to clear a session
        // that is fine.
        expired: expiresInSeconds === null ? false : expiresInSeconds <= 0,
        expiresInSeconds,
      };
    });

    /**
     * Forget the saved session. The next MangaDex call re-authenticates from
     * the configured credentials, so this fixes "the stored refresh token is
     * bad" without a redeploy. It does NOT revoke anything MangaDex-side —
     * that is a credential rotation (docs/operations.md).
     */
    scope.post("/api/v1/admin/mangadex/auth/clear", { preHandler: requireScope("settings:write") }, async (req) => {
      await ctx.settings.clearSetting(MD_ACCESS_KEY);
      await ctx.settings.clearSetting(MD_REFRESH_KEY);
      await ctx.audit.record(actor(req), "mangadex_auth.clear");
      return { ok: true, cleared: true };
    });

    // ---- merged error feed ----

    /**
     * One time-ordered list of everything that failed, so triage starts in the
     * dashboard instead of in `docker logs`. Every source is queried at the full
     * `limit` before merging: splitting the budget between them would hide a
     * burst in one source behind old rows from another.
     *
     * `FAILED` exists on upload tasks but not on jobs (a job that exhausts its
     * attempts goes straight to `DEAD_LETTER`), which is why the two halves
     * filter on different state sets.
     */
    scope.get("/api/v1/admin/errors", { preHandler: requireScope("runs:read") }, async (req) => {
      const query = z
        .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
        .parse(req.query ?? {});

      const [jobs, tasks, submissions] = await Promise.all([
        ctx.prisma.job.findMany({
          where: { state: "DEAD_LETTER" },
          orderBy: { updatedAt: "desc" },
          take: query.limit,
          select: {
            id: true,
            runId: true,
            extension: true,
            state: true,
            segmentIndex: true,
            segmentTotal: true,
            errorClass: true,
            lastError: true,
            updatedAt: true,
          },
        }),
        ctx.prisma.uploadTask.findMany({
          where: { state: { in: ["FAILED", "DEAD_LETTER"] } },
          orderBy: { updatedAt: "desc" },
          take: query.limit,
          select: { id: true, kind: true, state: true, dedupeKey: true, lastError: true, updatedAt: true },
        }),
        ctx.prisma.resultSubmission.findMany({
          where: { state: "QUARANTINED" },
          orderBy: { createdAt: "desc" },
          take: query.limit,
          select: { id: true, jobId: true, workerId: true, rejectReason: true, createdAt: true },
        }),
      ]);

      const errors = [
        ...jobs.map((job) => ({
          at: job.updatedAt,
          kind: `job:${job.state}`,
          subject: `${job.extension} · segment ${job.segmentIndex + 1}/${job.segmentTotal}`,
          message: job.errorClass ? `[${job.errorClass}] ${job.lastError ?? ""}` : (job.lastError ?? ""),
          id: job.id,
        })),
        ...tasks.map((task) => ({
          at: task.updatedAt,
          kind: `upload-task:${task.state}`,
          subject: `${task.kind} · ${task.dedupeKey}`,
          message: task.lastError ?? "",
          id: task.id,
        })),
        ...submissions.map((submission) => ({
          at: submission.createdAt,
          kind: "submission:QUARANTINED",
          subject: `worker ${submission.workerId.slice(0, 8)} · job ${submission.jobId}`,
          message: submission.rejectReason ?? "",
          id: submission.id,
        })),
      ]
        .sort((a, b) => b.at.getTime() - a.at.getTime())
        .slice(0, query.limit);

      return { errors };
    });
  });
}
