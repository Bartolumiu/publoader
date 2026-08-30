import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";
import AdmZip from "adm-zip";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { adminAuthHook, requireOwner, requireScope } from "../auth.js";
import { hasScope } from "../scopes.js";
import { sessionAuthenticator } from "../session.js";
import { EXTENSION_NAME_RE, Manifest, hostAllowed, manifestSchedule } from "../../../contracts/manifest.js";
import { normaliseMangadexLanguage } from "../../../contracts/languages.js";
import { UPLOAD_TASK_KINDS, UPLOAD_TASK_STATES } from "../../store/uploadTasks.js";
import { workerLabel, workerNames } from "../../store/workers.js";
import { mangaEditPayload } from "../../md/titleService.js";
import {
  ERROR_FEED_SOURCES,
  MAX_CLEAR_ALL,
  clearErrors,
  listErrors,
  restoreErrors,
} from "../../observability/errorFeed.js";

const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const DEFAULT_WINDOW_HOURS = 72;

/** Written by MdClient (core/md/client.ts); read-only here. */
const MD_ACCESS_KEY = "mdauth_access";
const MD_REFRESH_KEY = "mdauth_refresh";

/**
 * Parse with zod, answering 400 instead of the error handler's default 500.
 * Generic over the schema so the return is the schema's output type.
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

/** `exp` from a JWT payload, without verifying the signature. Returns no other claim. */
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

/** Walk up for `prisma/migrations`: the depth differs between `src/` and `dist/`. */
function findMigrationsDir(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let hop = 0; hop < 8; hop++) {
    const candidate = join(dir, "prisma", "migrations");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Migration directory names on disk, in the order prisma applies them. */
function migrationsOnDisk(dir: string | null): string[] {
  if (!dir) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** `pg_dump` connection args, with the password returned separately so it stays out of argv. */
function pgDumpTarget(databaseUrl: string): { args: string[]; password: string; database: string } | null {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return null;
  }
  const database = url.pathname.replace(/^\//, "");
  if (!database) return null;
  return {
    database,
    password: decodeURIComponent(url.password),
    args: [
      "--host",
      url.hostname,
      "--port",
      url.port || "5432",
      "--username",
      decodeURIComponent(url.username),
      "--dbname",
      database,
      // Compressed, and `pg_restore` can pick objects out of it.
      "--format=custom",
      "--no-owner",
      "--no-privileges",
    ],
  };
}

type Severity = "error" | "warn" | "info";

interface ActivityRow {
  at: Date;
  severity: Severity;
  source: "run" | "job" | "upload-task" | "submission" | "audit";
  kind: string;
  subject: string;
  message: string;
  id: string;
  extension?: string | null;
  /** Parent run, for rows that have one; the dashboard permalink needs it. */
  runId?: string | null;
}

/** Membership in the MangaDex language allowlist, not a shape check. */
const LANGUAGE_VALIDATION = "allowlist" as const;

const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

const APPLY_ROLE_REASON =
  "editing the MangaDex title requires the ADMIN role: it changes a public " +
  "catalogue entry under the platform's MangaDex account. Correct the row and " +
  "ask an admin to apply it.";

const APPLY_TOKEN_REASON =
  "editing the MangaDex title is closed to api tokens however broadly they are " +
  "scoped: it changes a public catalogue entry under the platform's MangaDex " +
  "account, so it is attributable to a signed-in operator or nothing. Apply it " +
  "from the dashboard.";

/**
 * May this caller push a row's corrections onto the public MangaDex entry?
 *
 * Allow-list, not deny-list: a deny-list on a role enum grants every role added
 * later. API tokens are refused outright rather than judged on their role,
 * because `adminAuthHook` assigns every api token `adminRole = "ADMIN"`.
 */
async function requireApplyRole(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.principal?.kind === "api-token") {
    await reply.code(403).send({ error: APPLY_TOKEN_REASON, requiredRole: "ADMIN" });
    return;
  }
  if (req.adminRole !== "OWNER" && req.adminRole !== "ADMIN") {
    await reply.code(403).send({ error: APPLY_ROLE_REASON, requiredRole: "ADMIN" });
  }
}

export function registerOpsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const migrationsDir = findMigrationsDir();

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

    /** Same attribution rules as routes/admin.ts. */
    const actor = (req: FastifyRequest) => {
      const claimed = (req.headers["x-actor"] as string | undefined)?.slice(0, 64);
      const principal = req.principal;
      if (principal?.kind === "api-token") {
        return claimed ? `${principal.name} for ${claimed}` : principal.name;
      }
      if (principal?.kind === "session") return principal.name;
      return `admin:${claimed ?? "root"}`;
    };

    // ---- who am I ----

    /**
     * The principal's own identity and authority. No scope guard: every
     * authenticated caller may ask what it is. Lets the dashboard hide controls
     * the server would refuse; the scope checks still run on every route.
     */
    scope.get("/api/v1/admin/whoami", async (req, reply) => {
      const principal = req.principal;
      if (!principal) return reply.code(401).send({ error: "unauthenticated" });
      return {
        kind: principal.kind,
        name: principal.name,
        role: req.adminRole ?? null,
        scopes: [...principal.scopes],
        csrfHeader: "x-requested-with",
      };
    });

    // ---- schema & migrations ----

    /**
     * Is the database schema the one this build expects? A migration prisma
     * recorded but never finished (`finished_at` null) or rolled back is
     * reported as failed: that is what makes a container crash-loop on boot.
     */
    scope.get("/api/v1/admin/schema", { preHandler: requireScope("settings:read") }, async () => {
      const onDisk = migrationsOnDisk(migrationsDir);

      let rows: { migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[];
      try {
        rows = await ctx.prisma.$queryRaw<
          { migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]
        >(
          Prisma.sql`SELECT migration_name, finished_at, rolled_back_at
                     FROM _prisma_migrations ORDER BY started_at ASC`,
        );
      } catch {
        // No `_prisma_migrations` table: the schema was created some other way
        // (`prisma db push`, a hand-restored dump), not left unmigrated.
        return {
          historyAvailable: false,
          current: null,
          applied: [],
          pending: onDisk,
          onDisk,
          note: "this database has no _prisma_migrations table; its schema was not applied by prisma migrate",
        };
      }

      const applied = rows.map((row) => ({
        name: row.migration_name,
        appliedAt: row.finished_at,
        rolledBackAt: row.rolled_back_at,
        failed: row.rolled_back_at !== null || row.finished_at === null,
      }));
      const appliedNames = new Set(applied.filter((m) => !m.failed).map((m) => m.name));
      const pending = onDisk.filter((name) => !appliedNames.has(name));
      const failed = applied.filter((m) => m.failed).map((m) => m.name);

      return {
        historyAvailable: true,
        // Null rather than true when the history was not shipped: "none pending"
        // and "we cannot see the migrations" must not look alike.
        current: migrationsDir === null ? null : pending.length === 0 && failed.length === 0,
        applied,
        pending,
        failed,
        onDisk,
        ...(migrationsDir === null
          ? { note: "prisma/migrations was not shipped with this build, so pending migrations cannot be detected" }
          : {}),
      };
    });

    /**
     * Stream a `pg_dump` of the whole database as a download.
     *
     * Gated on the OWNER role AND `users:admin`: a dump contains every operator
     * password hash, every token hash and the saved MangaDex session, so taking
     * one is a credential-theft primitive rather than a read. `requireOwner` is
     * what excludes api tokens, since a wildcard-scoped token satisfies the
     * scope check but is never assigned the OWNER role.
     *
     * stdout is piped straight to the response so a multi-GB dump is never
     * buffered in the API process.
     */
    scope.get("/api/v1/admin/backup", { preHandler: [requireOwner, requireScope("users:admin")] }, async (req, reply) => {
      const target = pgDumpTarget(ctx.config.databaseUrl);
      if (!target) {
        return reply.code(500).send({ error: "DATABASE_URL is not a usable postgres url" });
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const child = spawn("pg_dump", target.args, {
        // Password in the environment, never in argv where `ps` would show it.
        env: { ...process.env, PGPASSWORD: target.password, PGCONNECT_TIMEOUT: "10" },
        stdio: ["ignore", "pipe", "pipe"],
      });

      // ENOENT is the expected failure: the runtime image carries no postgres
      // client tools. Answer with the fix rather than a 500.
      const spawned = await new Promise<Error | null>((resolve) => {
        child.once("spawn", () => resolve(null));
        child.once("error", (err) => resolve(err));
      });
      if (spawned) {
        const missing = (spawned as NodeJS.ErrnoException).code === "ENOENT";
        return reply.code(503).send({
          error: missing
            ? "pg_dump is not installed in this container; take the backup on the host " +
              "(docs/operations.md §Backup and restore) or add postgresql-client-16 to the core image"
            : `could not start pg_dump: ${spawned.message}`,
        });
      }

      // Diagnostics go to stderr; keep them for the log line rather than mixing
      // them into the download.
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        if (stderr.length < 4000) stderr += chunk;
      });
      child.once("close", (code) => {
        if (code !== 0) {
          ctx.log.error({ code, stderr: stderr.slice(0, 2000) }, "pg_dump failed");
        }
      });
      // A client that disconnects mid-download must not leave pg_dump holding a
      // connection and a snapshot open.
      reply.raw.once("close", () => {
        if (child.exitCode === null) child.kill("SIGTERM");
      });

      await ctx.audit.record(actor(req), "database.backup", target.database);
      return reply
        .header("content-type", "application/octet-stream")
        .header("content-disposition", `attachment; filename="publoader-${stamp}.dump"`)
        .send(child.stdout);
    });

    // ---- bundle preflight ----

    /**
     * Report what publishing a bundle zip would accept or reject, without
     * publishing. `POST /bundles` remains the validation of record and re-checks
     * everything.
     */
    scope.post(
      "/api/v1/admin/bundles/inspect",
      { bodyLimit: MAX_BUNDLE_BYTES, preHandler: requireScope("bundles:read") },
      async (req, reply) => {
        if (!Buffer.isBuffer(req.body)) {
          return reply.code(400).send({ error: "zip body required (content-type application/zip)" });
        }

        let zip: AdmZip;
        try {
          zip = new AdmZip(req.body);
        } catch {
          return reply.code(422).send({ ok: false, errors: ["not a readable zip archive"] });
        }
        const names = zip.getEntries().map((entry) => entry.entryName);
        const manifestEntry = zip.getEntry("manifest.json");
        if (!manifestEntry) {
          return reply.code(422).send({
            ok: false,
            entries: names.length,
            errors: [
              "no manifest.json at the root of the archive; zip the contents of the " +
                "extension directory, not the directory itself",
            ],
          });
        }

        let raw: unknown;
        try {
          raw = JSON.parse(manifestEntry.getData().toString("utf8"));
        } catch (err) {
          return reply
            .code(422)
            .send({ ok: false, entries: names.length, errors: [`manifest.json is not valid JSON: ${String(err)}`] });
        }

        const parsed = Manifest.safeParse(raw);
        if (!parsed.success) {
          return reply.code(422).send({
            ok: false,
            entries: names.length,
            errors: parsed.error.issues.map(
              (issue) => `${issue.path.length ? issue.path.join(".") : "manifest"}: ${issue.message}`,
            ),
          });
        }

        // Advisory only: publishing re-runs the real checks in store/bundles.ts,
        // so drift here can never let a bad bundle through.
        const manifest = parsed.data;
        const errors: string[] = [];
        const entry = zip.getEntry(manifest.entrypoint);
        if (!entry) {
          errors.push(`entrypoint ${manifest.entrypoint} is missing from the archive`);
        } else if (entry.getData().toString("utf8").trim().length === 0) {
          errors.push(`entrypoint ${manifest.entrypoint} is empty`);
        }
        if ((manifest.runtime ?? (manifest.publoader_api.includes("2") ? "node" : "python")) === "python") {
          errors.push(
            "python bundles are no longer accepted; port to extension API v2 " +
              '(publoader_api "^2.0.0", runtime "node", ESM default export)',
          );
        }

        const latest = await ctx.bundles.latest(manifest.name);
        return reply.code(errors.length ? 422 : 200).send({
          ok: errors.length === 0,
          entries: names.length,
          errors,
          manifest: {
            name: manifest.name,
            version: manifest.version,
            runtime: manifest.runtime ?? null,
            publoaderApi: manifest.publoader_api,
            entrypoint: manifest.entrypoint,
            languages: manifest.languages,
            allowedHosts: manifest.allowed_hosts,
            mangadexGroupId: manifest.mangadex_group_id,
            minTrust: manifest.min_trust,
            // Normalised, so the preview shows what the scheduler will read
            // rather than which of the two spellings the author happened to use.
            schedule: manifestSchedule(manifest),
          },
          currentlyPublished: latest ? { version: latest.version, sha256: latest.sha256, publishedAt: latest.publishedAt } : null,
          replacesSameVersion: latest?.version === manifest.version,
        });
      },
    );

    // ---- upload-task queues ----

    /**
     * Upload-task rows plus the depth summary. `chapter` is deliberately not
     * returned: the payload is large and worker-supplied, and the dedupe key
     * identifies the chapter well enough for triage.
     */
    scope.get("/api/v1/admin/upload-tasks", { preHandler: requireScope("runs:read") }, async (req) => {
      const query = parseOrThrow(
        z.object({
          kind: z.enum(UPLOAD_TASK_KINDS).optional(),
          state: z.enum(UPLOAD_TASK_STATES).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
        req.query ?? {},
      );

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
     * Requeue a task the uploader gave up on. The attempt counter resets: the
     * operator is asserting the cause is fixed, and leaving it at maxAttempts
     * would dead-letter it on the first hiccup.
     */
    scope.post("/api/v1/admin/upload-tasks/:id/retry", { preHandler: requireScope("runs:write") }, async (req, reply) => {
      const { id } = parseOrThrow(taskId, req.params);
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
     * Abandon a task without running it. There is no CANCELLED state, so this
     * marks it DONE and records why in `lastError`; a silent DONE would be
     * indistinguishable from a chapter that actually uploaded.
     *
     * A LEASED row belongs to an uploader that is mid-flight, so it is refused:
     * setting it DONE would race that process into a duplicate upload or a lost
     * result.
     */
    scope.post("/api/v1/admin/upload-tasks/:id/cancel", { preHandler: requireScope("runs:write") }, async (req, reply) => {
      const { id } = parseOrThrow(taskId, req.params);
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

    /** Manual sweep, for when the uploader died holding leases. */
    scope.post("/api/v1/admin/upload-tasks/requeue-stale", { preHandler: requireScope("runs:write") }, async (req) => {
      const requeued = await ctx.uploadTasks.sweepExpired();
      await ctx.audit.record(actor(req), "upload_task.requeue_stale", undefined, { requeued });
      return { ok: true, requeued };
    });

    // ---- MangaDex session visibility ----

    /** Whether the saved MangaDex session is still good. The tokens are never returned. */
    scope.get("/api/v1/admin/mangadex/auth", { preHandler: requireScope("settings:read") }, async () => {
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
        // Unknown expiry is not "expired": an unparseable token may still work.
        expired: expiresInSeconds === null ? false : expiresInSeconds <= 0,
        expiresInSeconds,
      };
    });

    /**
     * Forget the saved session; the next MangaDex call re-authenticates from the
     * configured credentials. Revokes nothing MangaDex-side.
     */
    scope.post("/api/v1/admin/mangadex/auth/clear", { preHandler: requireScope("settings:write") }, async (req) => {
      await ctx.settings.clearSetting(MD_ACCESS_KEY);
      await ctx.settings.clearSetting(MD_REFRESH_KEY);
      await ctx.audit.record(actor(req), "mangadex_auth.clear");
      return { ok: true, cleared: true };
    });

    // ---- merged error feed ----

    /**
     * One time-ordered list of everything that failed.
     *
     * By default this is a to-do list, not a history: entries an operator has
     * cleared are omitted, and `clearedHidden` says how many, so "nothing is
     * outstanding" cannot be confused with "nothing ever failed". `?cleared=`
     * switches to including them (`with`) or to only them (`only`).
     *
     * The merge, the per-source `limit` and the acknowledgement rules all live in
     * core/observability/errorFeed.ts, shared with the bot, the CLI and the
     * dashboard.
     */
    /**
     * Raw log lines, newest first.
     *
     * The errors feed above is a curated view: it shows what failed. This is
     * the uncurated one — every line a core service emitted, with the fields it
     * carried — because the questions that matter during an incident are often
     * about lines that are not errors at all. What a check concluded, which
     * titles a run skipped and why, what a decision was made on: all of that was
     * previously readable only with shell access to the host, and only until the
     * container restarted.
     *
     * Paged by `before` rather than an offset: the table is being appended to
     * while it is read, so an offset would skip and repeat lines.
     */
    scope.get("/api/v1/admin/logs", { preHandler: requireScope("runs:read") }, async (req) => {
      const query = parseOrThrow(
        z.object({
          limit: z.coerce.number().int().min(1).max(1000).default(200),
          /** pino levels: 10 trace, 20 debug, 30 info, 40 warn, 50 error. */
          minLevel: z.coerce.number().int().min(10).max(60).optional(),
          service: z.string().max(64).optional(),
          component: z.string().max(64).optional(),
          runId: z.string().max(64).optional(),
          jobId: z.string().max(64).optional(),
          /** Case-insensitive substring over the message. */
          q: z.string().min(1).max(200).optional(),
          since: z.coerce.date().optional(),
          /** Cursor: return lines strictly older than this timestamp. */
          before: z.coerce.date().optional(),
        }),
        req.query ?? {},
      );

      const createdAt: { gte?: Date; lt?: Date } = {};
      if (query.since) createdAt.gte = query.since;
      if (query.before) createdAt.lt = query.before;

      const rows = await ctx.prisma.logEvent.findMany({
        where: {
          ...(query.minLevel === undefined ? {} : { level: { gte: query.minLevel } }),
          ...(query.service ? { service: query.service } : {}),
          ...(query.component ? { component: query.component } : {}),
          ...(query.runId ? { runId: query.runId } : {}),
          ...(query.jobId ? { jobId: query.jobId } : {}),
          ...(query.q ? { msg: { contains: query.q, mode: "insensitive" as const } } : {}),
          ...(Object.keys(createdAt).length > 0 ? { createdAt } : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: query.limit,
      });

      const oldest = rows[rows.length - 1];
      return {
        logs: rows,
        // Feed straight back as `before` to page further into the past.
        nextBefore: rows.length === query.limit && oldest ? oldest.createdAt.toISOString() : null,
        /**
         * Extension runs are NOT here. Worker agents have no database by
         * design, so a runner's output reaches the host's log stream and the
         * failure tail on its envelope, but not this table. Said plainly so an
         * empty result is not read as "nothing happened".
         */
        covers: ["core-api", "core-scheduler", "core-processor", "core-uploader"],
      };
    });

    /**
     * Run SQL against the platform's own database.
     *
     * Deployment here is compose-only: there is no psql on the host and no
     * published port, by design — a reachable 5432 has been the entry point in
     * enough incidents. That left no way to answer a question the API happens
     * not to expose, which is how several of this session's investigations
     * stalled.
     *
     * The trade is real and worth stating. This is unrestricted read/write over
     * HTTP, so it is fenced accordingly:
     *
     *  - ROOT ONLY. Not a `pa_…` token however scoped, and not a dashboard
     *    session however privileged. Scopes are for delegating a capability;
     *    this one is not delegable, so it is gated on the credential itself
     *    rather than on a scope somebody could be granted.
     *  - READ ONLY unless asked otherwise. The statement runs inside a
     *    transaction marked read-only, so an UPDATE fails at the database
     *    rather than on a check here that could be wrong.
     *  - Writing needs `write` AND `confirm`, the same shape as every other
     *    destructive verb, so a typo cannot become a mutation.
     *  - Every statement is audited before it runs, including the ones that
     *    fail, because "what was run against the database" is exactly the
     *    question an incident asks.
     *  - A statement timeout, so a careless join cannot hold a connection the
     *    scheduler needs.
     */
    scope.post("/api/v1/admin/sql", async (req, reply) => {
      if (req.principal?.kind !== "root") {
        return reply.code(403).send({
          error:
            "direct SQL is restricted to the root ADMIN_TOKEN; it is not available to API tokens " +
            "or dashboard sessions",
        });
      }

      const body = parseOrThrow(
        z
          .object({
            sql: z.string().min(1).max(20_000),
            /** Allow the statement to modify data. Requires `confirm` too. */
            write: z.boolean().default(false),
            confirm: z.boolean().default(false),
            /** Rows returned to the caller; the query itself is not rewritten. */
            limit: z.coerce.number().int().min(1).max(5_000).default(200),
            timeoutMs: z.coerce.number().int().min(100).max(60_000).default(15_000),
          })
          .strict(),
        req.body ?? {},
      );

      if (body.write && !body.confirm) {
        return reply
          .code(400)
          .send({ error: "a write needs confirm: true alongside write: true" });
      }

      // Audited BEFORE running: a statement that fails, or hangs, is the one
      // most worth having a record of.
      await ctx.audit.record(actor(req), body.write ? "sql.write" : "sql.read", undefined, {
        sql: body.sql.slice(0, 4_000),
        write: body.write,
      });

      const started = Date.now();
      try {
        const rows = await ctx.prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${body.timeoutMs}`);
          if (!body.write) {
            // Enforced by Postgres, not by inspecting the statement: parsing SQL
            // to decide whether it writes is a guess, and a wrong guess here is
            // an unintended mutation.
            await tx.$executeRawUnsafe("SET LOCAL transaction_read_only = on");
          }
          return (await tx.$queryRawUnsafe(body.sql)) as unknown[];
        });

        const list = Array.isArray(rows) ? rows : [];
        return {
          ok: true,
          write: body.write,
          rowCount: list.length,
          truncated: list.length > body.limit,
          durationMs: Date.now() - started,
          // BigInt is what Postgres returns for count(*) and for bigint columns,
          // and JSON cannot carry it; stringifying keeps the value exact rather
          // than rounding it into a double.
          rows: JSON.parse(
            JSON.stringify(list.slice(0, body.limit), (_key, value) =>
              typeof value === "bigint" ? value.toString() : value,
            ),
          ) as unknown[],
        };
      } catch (err) {
        return reply.code(400).send({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - started,
        });
      }
    });

    /** Distinct services and components present, for the log page's filters. */
    scope.get("/api/v1/admin/logs/sources", { preHandler: requireScope("runs:read") }, async () => {
      const [services, components] = await Promise.all([
        ctx.prisma.logEvent.findMany({ distinct: ["service"], select: { service: true }, take: 50 }),
        ctx.prisma.logEvent.findMany({
          distinct: ["component"],
          select: { component: true },
          where: { component: { not: null } },
          take: 200,
        }),
      ]);
      return {
        services: services.map((row) => row.service).sort(),
        components: components.map((row) => row.component).filter(Boolean).sort(),
      };
    });

    scope.get("/api/v1/admin/errors", { preHandler: requireScope("runs:read") }, async (req) => {
      const query = parseOrThrow(
        z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          cleared: z.enum(["without", "with", "only"]).default("without"),
        }),
        req.query ?? {},
      );

      return listErrors(ctx.prisma, {
        limit: query.limit,
        includeCleared: query.cleared === "with",
        clearedOnly: query.cleared === "only",
      });
    });

    /**
     * Acknowledge failures: "read this, dealt with it, stop showing it to me".
     *
     * `runs:write` rather than `runs:read` because it changes what the next
     * operator sees (the same reason retry and cancel are writes), but it is not
     * destructive: nothing about the job, task or submission changes, and
     * `/errors/restore` is a complete undo.
     *
     * Three ways to name entries, because the four surfaces reach for different
     * ones: `refs` ({source, id}) is what the dashboard sends for a row it is
     * already rendering, `ids` is what a human types from a table, and
     * `all: true` is the "I have been through the list" button. Entries that are
     * not currently failing come back in `skipped` with a reason rather than
     * being silently written, since acknowledging a healthy row would hide its
     * NEXT failure.
     */
    scope.post("/api/v1/admin/errors/clear", { preHandler: requireScope("runs:write") }, async (req, reply) => {
      const body = parseOrThrow(
        z
          .object({
            refs: z
              .array(z.object({ source: z.enum(ERROR_FEED_SOURCES), id: z.string().min(1).max(128) }))
              .max(MAX_CLEAR_ALL)
              .optional(),
            ids: z.array(z.string().min(1).max(128)).max(MAX_CLEAR_ALL).optional(),
            all: z.boolean().optional(),
            note: z.string().max(1000).optional(),
          })
          .refine((b) => b.all === true || (b.refs?.length ?? 0) > 0 || (b.ids?.length ?? 0) > 0, {
            message: "pass refs, ids, or all: true",
          }),
        (req.body as unknown) ?? {},
      );

      const result = await clearErrors(ctx.prisma, {
        actor: actor(req),
        refs: body.refs,
        ids: body.ids,
        all: body.all,
        note: body.note ?? null,
      });

      // One audit row per acknowledgement: "who decided this failure was fine"
      // is exactly the question the audit trail gets asked later, and a single
      // summary row makes it unanswerable by subject lookup.
      await ctx.audit.recordMany(
        result.cleared.map((ref) => ({
          actor: actor(req),
          action: "errors.clear",
          subject: `${ref.source}:${ref.id}`,
          detail: body.note ? { note: body.note } : undefined,
        })),
      );

      // Nothing matched and the caller named specific entries: that is a failed
      // request, not an empty success; a stale id typed from an old table
      // should say so.
      if (result.cleared.length === 0 && result.skipped.length > 0) {
        return reply.code(404).send({ ok: false, cleared: 0, skipped: result.skipped });
      }
      return { ok: true, cleared: result.cleared.length, entries: result.cleared, skipped: result.skipped };
    });

    /**
     * Put cleared entries back in the feed: the undo for a mis-click, and the
     * way to re-open something that turned out not to be fixed.
     *
     * No state check on the subject: deleting an acknowledgement is safe whatever
     * the row is doing now, and refusing would leave rows that can never be
     * un-cleared.
     */
    scope.post("/api/v1/admin/errors/restore", { preHandler: requireScope("runs:write") }, async (req) => {
      const body = parseOrThrow(
        z
          .object({
            refs: z
              .array(z.object({ source: z.enum(ERROR_FEED_SOURCES), id: z.string().min(1).max(128) }))
              .max(MAX_CLEAR_ALL)
              .optional(),
            ids: z.array(z.string().min(1).max(128)).max(MAX_CLEAR_ALL).optional(),
            all: z.boolean().optional(),
          })
          .refine((b) => b.all === true || (b.refs?.length ?? 0) > 0 || (b.ids?.length ?? 0) > 0, {
            message: "pass refs, ids, or all: true",
          }),
        (req.body as unknown) ?? {},
      );

      const { restored } = await restoreErrors(ctx.prisma, {
        refs: body.refs,
        ids: body.ids,
        all: body.all,
      });
      await ctx.audit.record(actor(req), "errors.restore", body.all ? "all" : undefined, { restored });
      return { ok: true, restored };
    });

    // ---- unified activity feed ----

    /**
     * Runs, jobs, upload tasks, quarantined submissions and audit events in one
     * time-ordered list. Application events only: every one is a durable row.
     * Process stdout is not captured here and stays in `docker logs`.
     *
     * Unlike `/errors`, healthy rows are included. Audit events need
     * `audit:read` on top of `runs:read`; a credential with only the latter is
     * told the audit half was withheld rather than silently getting a short list.
     */
    scope.get("/api/v1/admin/activity", { preHandler: requireScope("runs:read") }, async (req) => {
      const query = parseOrThrow(
        z.object({
          severity: z.enum(["error", "warn", "info", "all"]).default("all"),
          hours: z.coerce.number().int().min(1).max(24 * 30).default(DEFAULT_WINDOW_HOURS),
          extension: z.string().max(128).optional(),
          /** Case-insensitive substring over the subject and message. */
          q: z.string().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
        req.query ?? {},
      );

      const since = new Date(Date.now() - query.hours * 3600_000);
      const extensionFilter = query.extension ? { extension: query.extension } : {};
      const includeAudit = hasScope(req.principal!, "audit:read");

      const [runs, jobs, tasks, submissions, auditEvents] = await Promise.all([
        ctx.prisma.run.findMany({
          where: { updatedAt: { gte: since }, ...extensionFilter },
          orderBy: { updatedAt: "desc" },
          take: query.limit,
          select: {
            id: true,
            extension: true,
            kind: true,
            state: true,
            segmentsTotal: true,
            triggeredBy: true,
            error: true,
            updatedAt: true,
          },
        }),
        ctx.prisma.job.findMany({
          where: { updatedAt: { gte: since }, ...extensionFilter },
          orderBy: { updatedAt: "desc" },
          take: query.limit,
          select: {
            id: true,
            runId: true,
            extension: true,
            state: true,
            segmentIndex: true,
            segmentTotal: true,
            attempt: true,
            maxAttempts: true,
            errorClass: true,
            lastError: true,
            updatedAt: true,
          },
        }),
        ctx.prisma.uploadTask.findMany({
          where: { updatedAt: { gte: since } },
          orderBy: { updatedAt: "desc" },
          take: query.limit,
          select: { id: true, kind: true, state: true, dedupeKey: true, attempt: true, lastError: true, updatedAt: true },
        }),
        ctx.prisma.resultSubmission.findMany({
          where: { createdAt: { gte: since }, state: { in: ["QUARANTINED", "COMMITTED"] } },
          orderBy: { createdAt: "desc" },
          take: query.limit,
          select: { id: true, jobId: true, workerId: true, state: true, rejectReason: true, createdAt: true },
        }),
        includeAudit
          ? ctx.prisma.auditEvent.findMany({
              where: { createdAt: { gte: since } },
              orderBy: { createdAt: "desc" },
              take: query.limit,
              select: { id: true, actor: true, action: true, subject: true, detail: true, createdAt: true },
            })
          : Promise.resolve([]),
      ]);

      const activityWorkerNames = await workerNames(
        ctx.prisma,
        submissions.map((submission) => submission.workerId),
      );

      const rows: ActivityRow[] = [
        ...runs.map((run): ActivityRow => ({
          at: run.updatedAt,
          severity: run.state === "FAILED" || run.state === "DEAD_LETTER" ? "error" : run.state === "CANCELLED" ? "warn" : "info",
          source: "run",
          kind: `run:${run.state}`,
          subject: `${run.extension} · ${run.kind} · ${run.segmentsTotal} segment(s)`,
          message: run.error ?? (run.triggeredBy ? `triggered by ${run.triggeredBy}` : ""),
          id: run.id,
          extension: run.extension,
        })),
        ...jobs.map((job): ActivityRow => ({
          at: job.updatedAt,
          severity: job.state === "DEAD_LETTER" ? "error" : job.lastError ? "warn" : job.state === "CANCELLED" ? "warn" : "info",
          source: "job",
          kind: `job:${job.state}`,
          subject: `${job.extension} · segment ${job.segmentIndex + 1}/${job.segmentTotal} · attempt ${job.attempt}/${job.maxAttempts}`,
          // A retrying job carries its last error while still being healthy, so
          // the text is attached whatever the state.
          message: job.lastError ? `${job.errorClass ? `[${job.errorClass}] ` : ""}${job.lastError}` : "",
          id: job.id,
          extension: job.extension,
        })),
        ...tasks.map((task): ActivityRow => ({
          at: task.updatedAt,
          severity: task.state === "FAILED" || task.state === "DEAD_LETTER" ? "error" : task.lastError ? "warn" : "info",
          source: "upload-task",
          kind: `upload-task:${task.state}`,
          subject: `${task.kind} · ${task.dedupeKey}`,
          message: task.lastError ?? "",
          id: task.id,
          extension: null,
        })),
        ...submissions.map((submission): ActivityRow => ({
          at: submission.createdAt,
          severity: submission.state === "QUARANTINED" ? "error" : "info",
          source: "submission",
          kind: `submission:${submission.state}`,
          subject: `worker ${workerLabel(submission.workerId, activityWorkerNames)} · job ${submission.jobId}`,
          message: submission.rejectReason ?? "",
          id: submission.id,
          extension: null,
        })),
        ...auditEvents.map((event): ActivityRow => ({
          at: event.createdAt,
          // An audit event records a deliberate action, so it is never an error
          // in itself.
          severity: "info",
          source: "audit",
          kind: `audit:${event.action}`,
          subject: `${event.actor} → ${event.action}${event.subject ? ` · ${event.subject}` : ""}`,
          message: event.detail ? JSON.stringify(event.detail) : "",
          id: event.id,
          extension: null,
        })),
      ];

      const needle = query.q?.toLowerCase();
      const filtered = rows
        .filter((r) => query.severity === "all" || r.severity === query.severity)
        // Upload tasks and submissions carry no extension column, so an
        // extension filter cannot pass them: guessing from the dedupe key would
        // show the wrong series.
        .filter((r) => !query.extension || r.extension === query.extension)
        .filter((r) => !needle || r.subject.toLowerCase().includes(needle) || r.message.toLowerCase().includes(needle))
        .sort((a, b) => b.at.getTime() - a.at.getTime())
        .slice(0, query.limit);

      return {
        activity: filtered,
        since,
        sources: ["run", "job", "upload-task", "submission", ...(includeAudit ? ["audit"] : [])],
        omittedSources: includeAudit ? [] : [{ source: "audit", reason: "missing scope: audit:read" }],
        note: "application events only; container stdout is not captured here (see docker logs)",
      };
    });

    // ---- audit search ----

    /**
     * Search the audit log. `q` is a case-insensitive substring across actor,
     * action, subject and the serialised detail.
     *
     * ILIKE rather than a tsvector index: the corpus is small and substring beats
     * word-stemming on identifiers like `mangaplus:12345`. The time window keeps
     * it bounded, and `createdAt` is already indexed.
     */
    scope.get("/api/v1/admin/audit/search", { preHandler: requireScope("audit:read") }, async (req) => {
      const query = parseOrThrow(
        z.object({
          q: z.string().max(200).optional(),
          actor: z.string().max(128).optional(),
          action: z.string().max(128).optional(),
          subject: z.string().max(256).optional(),
          since: z.coerce.date().optional(),
          until: z.coerce.date().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
          offset: z.coerce.number().int().min(0).max(100_000).default(0),
        }),
        req.query ?? {},
      );

      const where: Prisma.Sql[] = [];
      if (query.q) {
        // Parameterised, so a `%` or a quote in the needle is data. LIKE
        // metacharacters are left unescaped: an operator typing `%` means it as
        // a wildcard.
        const like = `%${query.q}%`;
        where.push(
          Prisma.sql`(actor ILIKE ${like} OR action ILIKE ${like} OR coalesce(subject, '') ILIKE ${like} OR coalesce(detail::text, '') ILIKE ${like})`,
        );
      }
      if (query.actor) where.push(Prisma.sql`actor ILIKE ${`%${query.actor}%`}`);
      if (query.action) where.push(Prisma.sql`action ILIKE ${`%${query.action}%`}`);
      if (query.subject) where.push(Prisma.sql`coalesce(subject, '') ILIKE ${`%${query.subject}%`}`);
      if (query.since) where.push(Prisma.sql`created_at >= ${query.since}`);
      if (query.until) where.push(Prisma.sql`created_at <= ${query.until}`);
      const predicate = where.length ? Prisma.sql`WHERE ${Prisma.join(where, " AND ")}` : Prisma.empty;

      const [events, counted] = await Promise.all([
        ctx.prisma.$queryRaw<
          { id: string; actor: string; action: string; subject: string | null; detail: unknown; created_at: Date }[]
        >(
          Prisma.sql`SELECT id, actor, action, subject, detail, created_at
                     FROM audit_events ${predicate}
                     ORDER BY created_at DESC
                     LIMIT ${query.limit} OFFSET ${query.offset}`,
        ),
        // The total is what makes paging honest: without it the UI cannot tell
        // "these are all of them" from "here is the first page of 4000".
        ctx.prisma.$queryRaw<{ total: bigint }[]>(
          Prisma.sql`SELECT count(*) AS total FROM audit_events ${predicate}`,
        ),
      ]);

      return {
        events: events.map((row) => ({
          id: row.id,
          actor: row.actor,
          action: row.action,
          subject: row.subject,
          detail: row.detail,
          createdAt: row.created_at,
        })),
        total: Number(counted[0]?.total ?? 0),
        limit: query.limit,
        offset: query.offset,
      };
    });

    // ---- per-extension activity ----

    /**
     * One extension's runs, jobs, upload tasks, quarantined submissions and
     * curation counts, so "the scrape succeeded but the uploads are all failing"
     * is visible as a single fact.
     */
    scope.get(
      "/api/v1/admin/extensions/:name/activity",
      { preHandler: requireScope("extensions:read") },
      async (req, reply) => {
        const { name } = req.params as { name: string };
        if (!EXTENSION_NAME_RE.test(name)) return reply.code(400).send({ error: "bad name" });
        const query = parseOrThrow(
          z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }),
          req.query ?? {},
        );

        const [runs, jobs, uploadTasks, quarantined, trackedCount, untrackedCounts, bundle] = await Promise.all([
          ctx.prisma.run.findMany({
            where: { extension: name },
            orderBy: { createdAt: "desc" },
            take: query.limit,
            select: {
              id: true,
              kind: true,
              state: true,
              segmentsTotal: true,
              triggeredBy: true,
              error: true,
              createdAt: true,
              completedAt: true,
            },
          }),
          ctx.prisma.job.findMany({
            where: { extension: name },
            orderBy: { updatedAt: "desc" },
            take: query.limit,
            select: {
              id: true,
              runId: true,
              state: true,
              segmentIndex: true,
              segmentTotal: true,
              attempt: true,
              maxAttempts: true,
              errorClass: true,
              lastError: true,
              updatedAt: true,
            },
          }),
          // Upload tasks have no extension column, so the JSONB is the only join
          // available. The EDIT shape wraps the chapter, hence the nested path.
          ctx.prisma.$queryRaw<
            {
              id: string;
              kind: string;
              state: string;
              dedupe_key: string;
              attempt: number;
              last_error: string | null;
              updated_at: Date;
            }[]
          >(
            Prisma.sql`SELECT id, kind::text, state::text, dedupe_key, attempt, last_error, updated_at
                       FROM upload_tasks
                       WHERE chapter->>'extensionName' = ${name}
                          OR chapter->'payload'->>'extensionName' = ${name}
                       ORDER BY updated_at DESC
                       LIMIT ${query.limit}`,
          ),
          ctx.prisma.$queryRaw<{ id: string; job_id: string; worker_id: string; reject_reason: string | null; created_at: Date }[]>(
            Prisma.sql`SELECT s.id, s.job_id, s.worker_id, s.reject_reason, s.created_at
                       FROM result_submissions s
                       JOIN jobs j ON j.id = s.job_id
                       WHERE s.state = 'QUARANTINED' AND j.extension = ${name}
                       ORDER BY s.created_at DESC
                       LIMIT ${query.limit}`,
          ),
          ctx.prisma.trackedManga.count({ where: { extension: name } }),
          ctx.prisma.untrackedManga.groupBy({
            by: ["state"],
            where: { extension: name },
            _count: true,
          }),
          ctx.bundles.latest(name),
        ]);

        return {
          extension: name,
          bundle: bundle
            ? { version: bundle.version, sha256: bundle.sha256, publishedAt: bundle.publishedAt, sourceCommit: bundle.sourceCommit }
            : null,
          runs,
          jobs,
          uploadTasks: uploadTasks.map((task) => ({
            id: task.id,
            kind: task.kind,
            state: task.state,
            dedupeKey: task.dedupe_key,
            attempt: task.attempt,
            lastError: task.last_error,
            updatedAt: task.updated_at,
          })),
          quarantined: quarantined.map((row) => ({
            id: row.id,
            jobId: row.job_id,
            workerId: row.worker_id,
            rejectReason: row.reject_reason,
            createdAt: row.created_at,
          })),
          tracked: trackedCount,
          untracked: Object.fromEntries(untrackedCounts.map((row) => [row.state, row._count])),
        };
      },
    );

    // ---- correcting an untracked series ----

    // The split below is load-bearing: PATCH corrects the LOCAL row and is a
    // contributor's job; apply-to-mangadex changes a public entry and is an
    // admin's. Nothing here touches MangaDex implicitly.

    const untrackedId = z.object({ id: z.string().uuid() });

    /** Manifest of the newest non-yanked bundle for an extension, or null. */
    const manifestFor = async (extension: string): Promise<Manifest | null> => {
      const bundle = await ctx.bundles.latest(extension);
      if (!bundle) return null;
      const parsed = Manifest.safeParse(bundle.manifest);
      return parsed.success ? parsed.data : null;
    };

    /**
     * Why the apply button must be disabled, or null when it is available.
     * Returned by the GET so the dashboard can disable the control with the
     * reason instead of letting an operator find out from a 403.
     */
    const applyBlockedReason = (
      req: FastifyRequest,
      row: { mdMangaId: string | null; state: string },
    ): string | null => {
      if (!hasScope(req.principal!, "untracked:write")) return "missing scope: untracked:write";
      // Must mirror requireApplyRole exactly; if they disagree the dashboard
      // offers a button that 403s.
      if (req.principal?.kind === "api-token") return APPLY_TOKEN_REASON;
      if (req.adminRole !== "OWNER" && req.adminRole !== "ADMIN") return APPLY_ROLE_REASON;
      if (!row.mdMangaId) {
        return "this row has no MangaDex title yet; approving it creates one from the corrected values";
      }
      if (row.state === "CREATING") return "a title creation is in flight for this row";
      if (!ctx.titleService) {
        return "this API instance holds no MangaDex credentials (see MD_USERNAME/MD_PASSWORD)";
      }
      return null;
    };

    /**
     * One untracked row, plus what MangaDex currently says about the title it
     * created. The live read is the point: the title may have been corrected by
     * hand or merged since, so `pendingChanges` says what an apply would send.
     *
     * A MangaDex outage is reported as `mangadex: null` plus `mangadexError`;
     * everything else still answers, because correcting the local row does not
     * need MangaDex.
     */
    scope.get(
      "/api/v1/admin/untracked/:id",
      { preHandler: requireScope("untracked:read") },
      async (req, reply) => {
        const { id } = parseOrThrow(untrackedId, req.params);
        const row = await ctx.prisma.untrackedManga.findUnique({ where: { id } });
        if (!row) return reply.code(404).send({ error: "unknown untracked manga" });

        const [manifest, lastApply] = await Promise.all([
          manifestFor(row.extension),
          ctx.prisma.auditEvent.findFirst({
            where: { action: "untracked.mangadex_apply", subject: id },
            orderBy: { createdAt: "desc" },
            select: { actor: true, detail: true, createdAt: true },
          }),
        ]);

        let mangadex: Record<string, unknown> | null = null;
        let mangadexError: string | null = null;
        let pendingChanges: unknown[] = [];
        if (row.mdMangaId) {
          if (!ctx.titleService) {
            mangadexError =
              "this API instance holds no MangaDex credentials, so the live title could not be read";
          } else {
            try {
              const live = await ctx.titleService.mangadexTitle(row.mdMangaId);
              if (!live) {
                mangadexError = `MangaDex has no title ${row.mdMangaId}; it may have been deleted or merged`;
              } else {
                mangadex = {
                  id: live.id,
                  titleUrl: `https://mangadex.org/title/${live.id}`,
                  titles: live.attributes.title,
                  altTitles: live.attributes.altTitles,
                  originalLanguage: live.attributes.originalLanguage ?? null,
                  status: live.attributes.status ?? null,
                  contentRating: live.attributes.contentRating ?? null,
                  links: live.attributes.links ?? {},
                  version: live.attributes.version,
                };
                pendingChanges = mangaEditPayload(live, row).changes;
              }
            } catch (err) {
              mangadexError = err instanceof Error ? err.message : String(err);
              ctx.log.warn({ err, mdMangaId: row.mdMangaId }, "live MangaDex title read failed");
            }
          }
        }

        const blocked = applyBlockedReason(req, row);
        return {
          untracked: row,
          /** False while a create is in flight: the row is not the operator's to change. */
          editable: row.state !== "CREATING",
          extension: {
            name: row.extension,
            // Null manifest means no published, non-yanked bundle, which is also
            // why a URL correction is refused for this row (see PATCH).
            allowedHosts: manifest?.allowed_hosts ?? null,
            languages: manifest?.languages ?? null,
            autoCreateTitles: manifest?.auto_create_titles ?? null,
            titleDefaults: manifest?.title_defaults ?? null,
          },
          mangadex,
          mangadexError,
          pendingChanges,
          // The row is authoritative for whether and when, because it survives
          // audit-log pruning; the log supplies the detail and answers for rows
          // applied before those columns existed.
          appliedToMangaDex: row.mdAppliedAt
            ? {
                at: row.mdAppliedAt,
                actor: row.mdAppliedBy,
                detail: lastApply?.detail ?? null,
              }
            : lastApply
              ? { at: lastApply.createdAt, actor: lastApply.actor, detail: lastApply.detail }
              : null,
          canApplyToMangaDex: blocked === null,
          applyBlockedReason: blocked,
          languageValidation: LANGUAGE_VALIDATION,
        };
      },
    );

    /**
     * Correct the scraped details on the LOCAL row. Nothing reaches MangaDex
     * from here; that is the separate apply below.
     *
     * Every field is validated because every field escapes: the name goes into a
     * public title and a Discord embed, and `mangaUrl` becomes `links.raw` on
     * the MangaDex entry. The URL is checked against the manifest's
     * `allowed_hosts`, the same allowlist the sandbox enforces on the extension.
     */
    scope.patch(
      "/api/v1/admin/untracked/:id",
      { preHandler: requireScope("untracked:write") },
      async (req, reply) => {
        const { id } = parseOrThrow(untrackedId, req.params);
        const body = parseOrThrow(
          z
            .object({
              mangaName: z.string().min(1).max(256).optional(),
              mangaLanguage: z.string().min(2).max(16).optional(),
              mangaUrl: z.string().min(1).max(2048).optional(),
            })
            // A misspelled field name must not look like a successful edit that
            // changed nothing.
            .strict(),
          req.body ?? {},
        );
        if (Object.keys(body).length === 0) {
          return reply.code(400).send({ error: "nothing to change: send mangaName, mangaLanguage or mangaUrl" });
        }

        const row = await ctx.prisma.untrackedManga.findUnique({ where: { id } });
        if (!row) return reply.code(404).send({ error: "unknown untracked manga" });
        if (row.state === "CREATING") {
          return reply.code(409).send({
            error:
              "this row is CREATING: a title service instance has claimed it and is calling " +
              "MangaDex. Editing it now would create a title from values nobody reviewed.",
          });
        }

        const manifest = await manifestFor(row.extension);
        const warnings: string[] = [];
        const data: { mangaName?: string; mangaLanguage?: string; mangaUrl?: string } = {};

        if (body.mangaName !== undefined) {
          const name = body.mangaName.trim();
          if (name.length === 0) return reply.code(400).send({ error: "mangaName cannot be blank" });
          if (CONTROL_CHARS_RE.test(name)) {
            return reply.code(400).send({ error: "mangaName contains control characters" });
          }
          data.mangaName = name;
        }

        if (body.mangaLanguage !== undefined) {
          const language = normaliseMangadexLanguage(body.mangaLanguage);
          if (!language) {
            return reply.code(400).send({
              error:
                `mangaLanguage ${JSON.stringify(body.mangaLanguage)} is not a language MangaDex ` +
                `accepts (expected e.g. "en", "ja", "pt-br")`,
            });
          }
          // A title in a language outside the manifest is unusual but legitimate,
          // so this warns rather than refuses, and is returned rather than logged.
          if (manifest && !manifest.languages.includes(language)) {
            warnings.push(
              `${language} is not in ${row.extension}'s manifest languages ` +
                `(${manifest.languages.join(", ")})`,
            );
          }
          data.mangaLanguage = language;
        }

        if (body.mangaUrl !== undefined) {
          const url = body.mangaUrl.trim();
          let parsed: URL;
          try {
            parsed = new URL(url);
          } catch {
            return reply.code(400).send({ error: "mangaUrl is not a valid absolute URL" });
          }
          if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
            return reply
              .code(400)
              .send({ error: `mangaUrl scheme ${parsed.protocol} is not allowed (http or https only)` });
          }
          if (!manifest) {
            // Without a manifest there is no allowlist to check against, and this
            // URL can end up on a public catalogue entry.
            return reply.code(409).send({
              error:
                `no published bundle for ${row.extension}, so its allowed_hosts cannot be ` +
                `checked; publish (or un-yank) a bundle before correcting the URL`,
            });
          }
          if (!hostAllowed(url, manifest.allowed_hosts)) {
            return reply.code(400).send({
              error:
                `mangaUrl host is not in ${row.extension}'s allowed_hosts ` +
                `(${manifest.allowed_hosts.join(", ")}); this URL is published on the MangaDex ` +
                `entry and in Discord, so it has to be a host this extension actually scrapes`,
              allowedHosts: manifest.allowed_hosts,
            });
          }
          data.mangaUrl = url;
        }

        const before: Record<string, string> = {};
        const after: Record<string, string> = {};
        for (const [field, value] of Object.entries(data) as [keyof typeof data, string][]) {
          if (row[field] === value) continue;
          before[field] = row[field];
          after[field] = value;
        }
        const changed = Object.keys(after);
        if (changed.length === 0) {
          return { ok: true, changed: [], warnings, untracked: row, mangadexNeedsApply: false };
        }

        let updated;
        try {
          updated = await ctx.prisma.untrackedManga.update({ where: { id }, data: after });
        } catch (err) {
          // (extension, mangaId, mangaLanguage) is unique, so correcting the
          // language can collide with another row for the same series.
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
            return reply.code(409).send({
              error:
                `another untracked row already exists for ${row.extension}:${row.mangaId} in ` +
                `${after.mangaLanguage ?? row.mangaLanguage}; skip one of the two rather than ` +
                `making them identical`,
            });
          }
          throw err;
        }

        await ctx.audit.record(actor(req), "untracked.edit", id, {
          extension: row.extension,
          mangaId: row.mangaId,
          before,
          after,
        });

        return {
          ok: true,
          changed,
          warnings,
          untracked: updated,
          // The row and the MangaDex entry now disagree, and only an admin can
          // reconcile them.
          mangadexNeedsApply: updated.mdMangaId !== null,
          languageValidation: LANGUAGE_VALIDATION,
        };
      },
    );

    /**
     * Push the corrected details onto the MangaDex title this row created.
     *
     * Two guards: `untracked:write` says the caller may work this queue, and the
     * role check says they may change a public catalogue. A CONTRIBUTOR holds
     * the scope and is still refused.
     *
     * Failure statuses are distinct: 409 is something the operator can resolve,
     * 502 is MangaDex refusing a well-formed request.
     */
    scope.post(
      "/api/v1/admin/untracked/:id/apply-to-mangadex",
      { preHandler: [requireScope("untracked:write"), requireApplyRole] },
      async (req, reply) => {
        const { id } = parseOrThrow(untrackedId, req.params);
        if (!ctx.titleService) {
          return reply.code(503).send({ error: "title service not available on this instance" });
        }
        const result = await ctx.titleService.applyToMangaDex(id, actor(req));
        if (!result.ok) {
          const status = result.reason === "unknown-row" ? 404 : result.reason === "rejected" ? 502 : 409;
          return reply.code(status).send({ error: result.error, reason: result.reason });
        }
        return {
          ok: true,
          applied: result.applied,
          mdMangaId: result.mdMangaId,
          titleUrl: result.titleUrl,
          changes: result.changes,
          notes: result.notes,
        };
      },
    );
  });
}
