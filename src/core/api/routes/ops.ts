// Not self-registering: server.ts is owned elsewhere, so the integrator wires
// this module in with `registerOpsRoutes(app, ctx)` next to the other route
// modules.
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
import { EXTENSION_NAME_RE, Manifest, hostAllowed } from "../../../contracts/manifest.js";
import { normaliseMangadexLanguage } from "../../../contracts/languages.js";
import { UPLOAD_TASK_KINDS, UPLOAD_TASK_STATES } from "../../store/uploadTasks.js";
import { mangaEditPayload } from "../../md/titleService.js";
import {
  ERROR_FEED_SOURCES,
  MAX_CLEAR_ALL,
  clearErrors,
  listErrors,
  restoreErrors,
} from "../../observability/errorFeed.js";

/**
 * Operational visibility and triage that the legacy Discord IPC commands used
 * to provide and the HTTP API did not (see docs/ipc-to-api-mapping.md §gaps):
 * upload-task queues (`queue_peek` / `queue_clear`), MangaDex session state
 * (`mdauth_status` / `logout`), and a merged error feed standing in for `logs`.
 *
 * The through-line is that an operator should never need a shell on the core
 * container to answer "what is stuck and why" — or, since the dashboard grew
 * schema status, backups and the Activity feed, to *fix* it either. Container
 * stdout stays where it is (`docker logs`) because it describes processes; every
 * application-level event is a row, and rows are what this module serves.
 */

/** Bundle preflight bodies are the same zip the publish route takes. */
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

/**
 * How far back the Activity feed and the audit search will look by default.
 * A bounded window is what keeps a substring search over `audit_events`
 * predictable without a full-text index (see the audit search route).
 */
const DEFAULT_WINDOW_HOURS = 72;

/** Settings keys written by MdClient; read-only here (see core/md/client.ts). */
const MD_ACCESS_KEY = "mdauth_access";
const MD_REFRESH_KEY = "mdauth_refresh";

/**
 * Validate, answering 400 instead of 500.
 *
 * A bare `schema.parse` throws a ZodError, which the server's error handler
 * reports as "internal error" — actively misleading for a caller who mistyped a
 * filter. The filters here are the ones an operator types by hand, so they get
 * a real answer. `statusCode` is what the handler keys off.
 *
 * Generic over the schema rather than over a result type, so the return is the
 * schema's OUTPUT: with `z.ZodType<T>` TypeScript infers T from the input side,
 * which types every `.default(…)` field as possibly-undefined even though
 * parsing guarantees it is not.
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

/**
 * Locate `prisma/migrations` by walking up from this module.
 *
 * The depth differs between `src/` (vitest, tsx) and `dist/` (the container),
 * and the runtime image copies `prisma/` next to `dist/` — so searching upwards
 * for the directory is the one lookup that is correct in both, without either
 * layout being hard-coded. Returns null when the history was not shipped, which
 * the route reports as "unknown" rather than "up to date".
 */
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

/**
 * Postgres connection parameters for `pg_dump`, taken from the URL the app is
 * already using. Returned separately from the password so the password can go
 * into the child's environment instead of its argv, where `ps` would show it.
 */
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
      // Custom format: compressed, and `pg_restore` can pick objects out of it.
      // Matches the shape docs/operations.md §"Backup and restore" documents,
      // so a dashboard dump and a host dump restore identically.
      "--format=custom",
      "--no-owner",
      "--no-privileges",
    ],
  };
}

/**
 * Severity for the Activity feed. Rows are classified once, here, so the UI
 * filter is a server-side predicate rather than a guess made from a label.
 */
type Severity = "error" | "warn" | "info";

interface ActivityRow {
  at: Date;
  severity: Severity;
  /** Which table this came from; also the permalink's type. */
  source: "run" | "job" | "upload-task" | "submission" | "audit";
  kind: string;
  subject: string;
  message: string;
  id: string;
  extension?: string | null;
  /**
   * Parent run, for rows that have one. The dashboard's per-row permalink needs
   * it: a job id alone opens nothing an operator can act on, while its run
   * shows every sibling segment and the retry buttons.
   */
  runId?: string | null;
}

/**
 * Membership in the MangaDex language allowlist, not a shape check.
 *
 * A well-formed code MangaDex does not know (`xx`) would be accepted by a regex
 * and then rejected at apply time — after the row had been changed, by which
 * point the operator has to undo an edit to find out what went wrong. The
 * allowlist in src/contracts/languages.ts is the same list `custom_language`
 * validates against, so a language is correct or refused in one place.
 */
const LANGUAGE_VALIDATION = "allowlist" as const;

/** Titles reach a public catalogue and a Discord embed; keep them printable. */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

/**
 * Second-stage guard for writes that leave this platform.
 *
 * `untracked:write` is deliberately in the CONTRIBUTOR scope set: working the
 * untracked queue — correcting a mangled row, skipping a duplicate — is exactly
 * the job that role exists for, and it is all local and reversible. Editing the
 * MangaDex entry is a different act with a different blast radius: it changes a
 * public catalogue, cannot be undone from here, and is attributed to the
 * platform's shared MangaDex account rather than to the person who clicked. So
 * it sits at ADMIN, and the 403 says why rather than just "forbidden" — a
 * contributor who has correctly fixed a row needs to know the remaining step is
 * someone else's, not that they did something wrong.
 */
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
 * Written as an allow-list, and deliberately so. The obvious form — refuse
 * CONTRIBUTOR — is a deny-list, and a deny-list on a role enum grants every role
 * that does not exist yet. `CONTRIBUTOR` was itself added to `AdminRole` after
 * the fact, so the next addition is not hypothetical, and it would silently
 * arrive holding the right to edit a public catalogue. `requireOwner` already
 * uses the allow-list form; this now matches it.
 *
 * API tokens are refused outright rather than judged on their role, because
 * `adminAuthHook` assigns every api token `adminRole = "ADMIN"` — a deliberate
 * default that means "not owner-equivalent", not "vetted human". Combined with a
 * deny-list, that let the `curator` preset through: it carries `untracked:write`
 * precisely so a community curator can work this queue, and it would then have
 * cleared a gate whose stated purpose is to stop exactly that person from
 * editing MangaDex. A leaked curator token could have mutated the public
 * catalogue under the shared account, which is the blast radius scoped tokens
 * exist to prevent. Nothing programmatic calls this endpoint — the dashboard is
 * the only caller — so closing it to tokens costs no capability.
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
  // Resolved once at wiring time: the answer cannot change while the process
  // lives, and a per-request filesystem walk would be pure waste.
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

    // ---- who am I ----

    /**
     * The principal's own identity and authority. No scope guard: every
     * authenticated caller may ask what it is, and refusing would make the
     * answer unobtainable exactly when it is needed.
     *
     * This exists because the dashboard cannot otherwise know what to render.
     * It used to probe an owner-only endpoint and read the 403 — which worked,
     * but only answered one bit. Returning the scope set lets the SPA hide
     * every control the server would refuse, so an operator never clicks into a
     * wall of "missing scope" toasts.
     *
     * Hiding is cosmetic and this endpoint does not change that: the same scope
     * checks still run on every route. Nothing secret is returned — no token,
     * no session id, no email beyond the actor name already in the audit log.
     */
    scope.get("/api/v1/admin/whoami", async (req, reply) => {
      const principal = req.principal;
      if (!principal) return reply.code(401).send({ error: "unauthenticated" });
      return {
        kind: principal.kind,
        name: principal.name,
        role: req.adminRole ?? null,
        scopes: [...principal.scopes],
        // The SPA needs this on every mutating call; sending it beats hard-coding
        // the same constant in two languages.
        csrfHeader: "x-requested-with",
      };
    });

    // ---- schema & migrations ----

    /**
     * Is the database schema the one this build expects?
     *
     * The answer used to require `docker compose run migrate status` on the
     * host. It is a `settings:read` question rather than a privileged one: it
     * returns migration names and timestamps, nothing about the data.
     *
     * A migration prisma recorded but never finished (`finished_at` null) or
     * rolled back is reported as failed. That is the state that makes a
     * container crash-loop on boot, and it is invisible from every other panel.
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
        // (`prisma db push`, a hand-restored dump). Say so instead of implying
        // the database is unmigrated, which would send an operator to run a
        // migration that then conflicts with existing objects.
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
        // Null rather than true when the history was not shipped with the
        // build: "no pending migrations found" and "we cannot see the
        // migrations" must not look alike.
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
     * Gated on the OWNER role AND `users:admin` — the same double gate as
     * routes/tokens.ts and routes/users.ts, and for the same reason. The scope
     * name looks off for a backup until you notice what a dump contains: every
     * operator password hash, every token hash and the saved MangaDex session in
     * plaintext. Taking one is a credential-theft primitive, not a read, so it
     * belongs at the bar for account administration — emphatically NOT at
     * `settings:write`, which the Discord bot holds so it can pause the platform.
     *
     * The scope alone is not that bar: an OWNER may mint a `pa_…` token with
     * `["*"]` (or with `users:admin` outright), and wildcard satisfies every
     * scope check. `requireOwner` is what actually excludes tokens, because
     * `adminAuthHook` never assigns one the OWNER role — so no credential a
     * client holds can dump the database and widen itself offline.
     *
     * stdout is piped straight to the response: a multi-GB dump must never be
     * buffered in the API process, and the operator sees bytes immediately.
     */
    scope.get("/api/v1/admin/backup", { preHandler: [requireOwner, requireScope("users:admin")] }, async (req, reply) => {
      const target = pgDumpTarget(ctx.config.databaseUrl);
      if (!target) {
        return reply.code(500).send({ error: "DATABASE_URL is not a usable postgres url" });
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const child = spawn("pg_dump", target.args, {
        // The password goes in the environment, never in argv where `ps` on the
        // host would show it. PGCONNECT_TIMEOUT keeps a wedged connection from
        // holding the request open forever.
        env: { ...process.env, PGPASSWORD: target.password, PGCONNECT_TIMEOUT: "10" },
        stdio: ["ignore", "pipe", "pipe"],
      });

      // ENOENT is the expected failure, not an exceptional one: the runtime
      // image deliberately carries no postgres client tools. Answer with the
      // fix rather than a 500 (see docs/dashboard.md §"still needs host access").
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

      // pg_dump's diagnostics are on stderr; keep them for the log line rather
      // than mixing them into the download.
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
     * Read a bundle zip and report what publishing it would accept or reject,
     * WITHOUT publishing.
     *
     * The publish route already answers 422 with a readable reason, so this is
     * not the validation of record — `POST /bundles` is, and it re-checks
     * everything. What this buys is that an operator who dragged the wrong
     * directory in learns so from an inline error next to the drop zone,
     * before they have authorized a code-execution change to every worker.
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
              "no manifest.json at the root of the archive — zip the contents of the " +
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
          // One line per bad field, pathed — "languages: array must contain at
          // least 1 element" is actionable in a way "validation failed" is not.
          return reply.code(422).send({
            ok: false,
            entries: names.length,
            errors: parsed.error.issues.map(
              (issue) => `${issue.path.length ? issue.path.join(".") : "manifest"}: ${issue.message}`,
            ),
          });
        }

        // Mirrors the entrypoint checks in store/bundles.ts. Duplicated on
        // purpose and deliberately advisory: publishing re-runs the real ones,
        // so drift here can only ever make the preflight less helpful, never
        // let a bad bundle through.
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
            schedule: manifest.schedule ?? null,
          },
          // "Am I about to replace what is live?" is the question an operator
          // asks right before clicking publish.
          currentlyPublished: latest ? { version: latest.version, sha256: latest.sha256, publishedAt: latest.publishedAt } : null,
          replacesSameVersion: latest?.version === manifest.version,
        });
      },
    );

    // ---- upload-task queues ----

    /**
     * The row-level view `queue_peek` had, plus the depth summary the Overview
     * needs. `chapter` is deliberately not returned: the payload is large, it
     * is worker-supplied, and nothing in triage needs it — the dedupe key
     * identifies the chapter well enough to find it on MangaDex.
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
     * Requeue a task the uploader gave up on. The attempt counter resets so the
     * task gets a full budget again — the operator is asserting the cause is
     * fixed, and leaving it at maxAttempts would dead-letter it on the first
     * hiccup.
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
     * dashboard instead of in `docker logs`.
     *
     * By default this is a to-do list, not a history: entries an operator has
     * cleared are omitted, and `clearedHidden` says how many, so "nothing is
     * outstanding" cannot be confused with "nothing ever failed". `?cleared=`
     * switches to including them (`with`) or to only them (`only`), which is the
     * review view — what did we decide was handled, by whom, and why.
     *
     * The merge, the per-source `limit` and the acknowledgement rules all live in
     * core/observability/errorFeed.ts, shared with the bot, the CLI and the
     * dashboard.
     */
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
     * operator sees — the same reason retry and cancel are writes — but it is not
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
      // request, not an empty success — a stale id typed from an old table
      // should say so.
      if (result.cleared.length === 0 && result.skipped.length > 0) {
        return reply.code(404).send({ ok: false, cleared: 0, skipped: result.skipped });
      }
      return { ok: true, cleared: result.cleared.length, entries: result.cleared, skipped: result.skipped };
    });

    /**
     * Put cleared entries back in the feed — the undo for a mis-click, and the
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
     * Everything the platform did recently, in one time-ordered list: runs,
     * jobs, upload tasks, quarantined submissions and audit events.
     *
     * This is the closest thing to "logs" the dashboard can honestly offer, and
     * the distinction matters enough to state twice: it covers APPLICATION
     * events, every one of which is a durable row. Process stdout — a stack
     * trace from a crash loop, prisma's connection warnings — is not here and
     * cannot be, because nothing writes it to the database. That stays
     * `docker logs` (docs/dashboard.md §"still needs host access").
     *
     * Unlike `/errors`, healthy rows are included, because "the run succeeded
     * four minutes ago" is half of most answers. `severity=error` reproduces
     * the old feed.
     *
     * Audit events need `audit:read` on top of `runs:read`, so a credential
     * with only the latter gets the operational half and is TOLD that the audit
     * half was withheld — silently returning a short list would read as "the
     * platform has been quiet".
     */
    scope.get("/api/v1/admin/activity", { preHandler: requireScope("runs:read") }, async (req) => {
      const query = parseOrThrow(
        z.object({
          severity: z.enum(["error", "warn", "info", "all"]).default("all"),
          /** How far back to look, in hours. */
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

      // Every source is queried at the full limit before merging, for the same
      // reason the error feed does it: splitting the budget would hide a burst
      // in one source behind old rows from another.
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
          // the text is attached whatever the state — that is the single most
          // useful string in the whole feed and it is otherwise only visible by
          // opening the run.
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
          subject: `worker ${submission.workerId.slice(0, 8)} · job ${submission.jobId}`,
          message: submission.rejectReason ?? "",
          id: submission.id,
          extension: null,
        })),
        ...auditEvents.map((event): ActivityRow => ({
          at: event.createdAt,
          // An audit event records a deliberate action, so it is never an error
          // in itself; the thing it did may show up as one on its own row.
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
        // An extension filter cannot pass rows we cannot attribute: upload
        // tasks and submissions carry no extension column, and guessing from
        // the dedupe key would quietly show the wrong series.
        .filter((r) => !query.extension || r.extension === query.extension)
        .filter((r) => !needle || r.subject.toLowerCase().includes(needle) || r.message.toLowerCase().includes(needle))
        .sort((a, b) => b.at.getTime() - a.at.getTime())
        .slice(0, query.limit);

      return {
        activity: filtered,
        since,
        // Named sources rather than a boolean: the UI says which half is
        // missing, and adding a source later does not change the shape.
        sources: ["run", "job", "upload-task", "submission", ...(includeAudit ? ["audit"] : [])],
        omittedSources: includeAudit ? [] : [{ source: "audit", reason: "missing scope: audit:read" }],
        note: "application events only; container stdout is not captured here (see docker logs)",
      };
    });

    // ---- audit search ----

    /**
     * Search the audit log instead of paging through it.
     *
     * `q` is a case-insensitive substring across actor, action, subject and the
     * serialised detail — matching detail is the whole point, because "which
     * change set removal mode to delete?" lives in there and nowhere else.
     *
     * Deliberately ILIKE and not a tsvector index: the corpus is small, the
     * queries are ad-hoc, and substring beats word-stemming on identifiers like
     * `mangaplus:12345`, which a text-search parser would mangle. The time
     * window is what keeps it bounded, and `createdAt` is already indexed.
     */
    scope.get("/api/v1/admin/audit/search", { preHandler: requireScope("audit:read") }, async (req) => {
      const query = parseOrThrow(
        z.object({
          q: z.string().max(200).optional(),
          actor: z.string().max(128).optional(),
          action: z.string().max(128).optional(),
          subject: z.string().max(256).optional(),
          /** ISO instants. Omitted `since` means "as far back as it goes". */
          since: z.coerce.date().optional(),
          until: z.coerce.date().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
          offset: z.coerce.number().int().min(0).max(100_000).default(0),
        }),
        req.query ?? {},
      );

      const where: Prisma.Sql[] = [];
      if (query.q) {
        // Parameterised, so a `%` or a quote in the needle is data. Escaping the
        // LIKE metacharacters as well would make `%` un-searchable; an operator
        // typing one means it as a wildcard.
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
     * One extension, everything about it: its runs, its jobs, the upload tasks
     * its chapters produced, its quarantined submissions and its curation
     * counts.
     *
     * Assembling this by hand meant five filtered views and a mental join on
     * run ids. It is the panel an operator opens when an extension "looks
     * broken" and the one place where "the scrape succeeded but the uploads are
     * all failing" is visible as a single fact.
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
          // Upload tasks have no extension column — the chapter payload is a
          // transient queue document, not a queryable record. Reaching into the
          // JSONB is the only join available, and it checks the EDIT shape's
          // nested payload too, because an edit task wraps the chapter.
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

    /**
     * What an extension scraped is not always right: a mangled name, a title
     * keyed to the wrong language, a source URL that moved. Approve-or-skip was
     * the whole vocabulary before these three routes, which meant the only way
     * to fix a bad row was to skip it and wait for the extension to report it
     * again — and if a title had already been created, the wrong name was
     * already on a public catalogue with no way back through this API.
     *
     * The split is deliberate and load-bearing: PATCH corrects the LOCAL row and
     * is a contributor's job; apply-to-mangadex changes a public entry and is an
     * admin's. Nothing here touches MangaDex implicitly.
     */

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
     * Returned by the GET so the dashboard can disable the control WITH the
     * reason instead of letting an operator find out from a 403 — the role case
     * in particular is not a mistake on their part and should not read like one.
     */
    const applyBlockedReason = (
      req: FastifyRequest,
      row: { mdMangaId: string | null; state: string },
    ): string | null => {
      if (!hasScope(req.principal!, "untracked:write")) return "missing scope: untracked:write";
      // Mirrors requireApplyRole exactly, including the allow-list shape and the
      // api-token refusal. If these two ever disagree the dashboard offers a
      // button that 403s, which is the failure this function exists to avoid.
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
     * created.
     *
     * The live read is the point. An operator correcting a row is deciding what
     * a public catalogue entry should say, and the scraped values in the row are
     * the LEAST reliable description of it: the title may have been created days
     * ago, corrected by hand on MangaDex since, or merged into another entry. So
     * the fields come from MangaDex at request time, and `pendingChanges` says
     * exactly what an apply would send.
     *
     * A MangaDex outage must not make the row unreadable — correcting the local
     * row does not need MangaDex at all. The call failing is reported as
     * `mangadex: null` plus `mangadexError`, and everything else still answers.
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
            // Null manifest means no published, non-yanked bundle — which is
            // also why a URL correction is refused for this row (see PATCH).
            allowedHosts: manifest?.allowed_hosts ?? null,
            languages: manifest?.languages ?? null,
            autoCreateTitles: manifest?.auto_create_titles ?? null,
            titleDefaults: manifest?.title_defaults ?? null,
          },
          mangadex,
          mangadexError,
          pendingChanges,
          // The row is authoritative for WHETHER and WHEN, because it survives
          // audit-log pruning; the log still supplies the detail of the last
          // application, and answers for rows applied before those columns
          // existed.
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
     * from here, including for a row that already has a title — that is the
     * separate apply below, and conflating them would let a contributor edit a
     * public catalogue entry by editing a database row.
     *
     * Every field is validated because every field escapes: the name goes into a
     * public title and a Discord embed, and `mangaUrl` becomes `links.raw` on
     * the MangaDex entry and a clickable link in chat. An unvalidated host there
     * is a way to get the platform to publish a link to anywhere, attributed to
     * its own account, so the URL is checked against the extension manifest's
     * `allowed_hosts` — the same allowlist the sandbox enforces on the
     * extension, applied to the operator correcting its output.
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
          // The manifest's languages are the ones this extension is known to
          // produce. A title in another language is unusual but legitimate (a
          // series' name in its original language, say), so this is a warning
          // and not a refusal — and it is returned rather than logged, because
          // the person who typed it is the only one who can judge it.
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
            // Without a manifest there is no allowlist to check against, and
            // this URL can end up on a public catalogue entry. Refusing is the
            // conservative half of that trade.
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
                `(${manifest.allowed_hosts.join(", ")}) — this URL is published on the MangaDex ` +
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
          // language can collide with another row for the same series — usually
          // the duplicate that prompted the correction in the first place.
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
          // reconcile them. Saying so is what stops a correction from being
          // silently local.
          mangadexNeedsApply: updated.mdMangaId !== null,
          languageValidation: LANGUAGE_VALIDATION,
        };
      },
    );

    /**
     * Push the corrected details onto the MangaDex title this row created.
     *
     * Two guards, not one. `untracked:write` says the caller may work this
     * queue; the role check says they may change a public catalogue. A
     * CONTRIBUTOR holds the scope and is still refused here, which is the whole
     * reason the second guard exists (see APPLY_ROLE_REASON).
     *
     * Failure statuses are distinct on purpose: 409 is something the operator
     * can resolve (no title yet, a create in flight, the entry moved under
     * them), 502 is MangaDex refusing a well-formed request.
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
