import type { FastifyInstance, FastifyRequest } from "fastify";
import { Prisma, RunKind, RunState } from "@prisma/client";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { adminAuthHook, requireScope } from "../auth.js";
import { hasScope } from "../scopes.js";
import {
  DEFAULT_COOLDOWN_DAYS,
  DEFAULT_NAMESPACE,
  MAX_BATCH_ROWS,
  MAX_COOLDOWN_DAYS,
  MAX_NAMESPACE_LENGTH,
  NAMESPACE_RE,
  normaliseNamespace,
  parsePairs,
} from "../../store/trackedManga.js";
import { sessionAuthenticator, impersonationResolver} from "../session.js";
import {
  Manifest,
  ManifestScheduleEntry,
  EXTENSION_NAME_RE,
  manifestSchedule,
  normalizeWeekdays,
  type ScheduleSlot,
} from "../../../contracts/manifest.js";
import { MANGADEX_LANGUAGES } from "../../../contracts/languages.js";
import {
  countOutstandingErrors,
  listDeadLetterJobs,
  listQuarantinedSubmissions,
} from "../../observability/errorFeed.js";
import { workerNames } from "../../store/workers.js";
import {
  encodeSortCursor,
  numberKeys,
  sortedBy,
  textKeys,
  type OrderKey,
  type SortColumns,
} from "../../store/ordering.js";
import { parseMdTitleId } from "../../md/titleId.js";
import {
  createSourceResolver,
  parseSourceMapLines,
  resolveSourceUrl,
  type SourceLinkDeps,
  type SourceMapLine,
} from "../../store/sourceLinks.js";

/**
 * The untracked queue's columns, aliased to the names the API answers with.
 *
 * Spelled out rather than read through the model because the listing is sorted
 * and paged in SQL: the ordering, the keyset predicate and the cursor are all
 * SQL expressions, and a query built half in Prisma's object language and half
 * in SQL would have two spellings of one filter to keep in agreement.
 */
const UNTRACKED_COLUMNS = Prisma.sql`u.id, u.extension, u.manga_id AS "mangaId",
  u.manga_name AS "mangaName", u.manga_language AS "mangaLanguage",
  u.manga_url AS "mangaUrl", u.state::text AS state, u.md_manga_id AS "mdMangaId",
  u.attempts, u.last_error AS "lastError", u.md_applied_at AS "mdAppliedAt",
  u.md_applied_by AS "mdAppliedBy",
  u.official_link_checked_at AS "officialLinkCheckedAt",
  u.title_checked_at AS "titleCheckedAt", u.created_at AS "createdAt",
  u.updated_at AS "updatedAt",
  t.md_manga_id AS "trackedMdMangaId", t.source AS "trackedSource",
  t.created_at AS "trackedAt"`;

/**
 * The series map, joined onto the queue by the identity the map is keyed on.
 *
 * A queue row and a mapping are about the same series when the extension and
 * the extension's own id agree; the default catalogue only, because that is the
 * one the untracked pipeline writes into. Note this says nothing about other
 * publishers: two extensions covering one series are two identities and two
 * rows, and both may point at the same MangaDex title quite legitimately.
 */
const UNTRACKED_TRACKED_JOIN = Prisma.sql`
  LEFT JOIN tracked_manga t
    ON t.extension = u.extension AND t.manga_id = u.manga_id AND t.namespace = ''`;

interface UntrackedRow {
  id: string;
  [key: string]: unknown;
}

/**
 * Fold the joined map columns into one `tracked` object, or null.
 *
 * A nested object rather than three loose fields because callers ask one
 * question of it — "is this series already mapped, and to what?" — and three
 * nullable siblings is three chances to check the wrong one. Null means the
 * series is not in the map: the honest answer, and the one that makes
 * `row.tracked` safe to use as the condition it reads as.
 */
function withTrackedMapping(row: Record<string, unknown>): Record<string, unknown> {
  const { trackedMdMangaId, trackedSource, trackedAt, ...rest } = row;
  return {
    ...rest,
    tracked: trackedMdMangaId
      ? { mdMangaId: trackedMdMangaId, source: trackedSource ?? null, at: trackedAt ?? null }
      : null,
  };
}

/** What the untracked listing may be ordered by, as the console's columns. */
const UNTRACKED_SORTS = ["series", "extension", "language", "state", "attempts", "result"] as const;

const UNTRACKED_SORT_COLUMNS: SortColumns = {
  series: textKeys(Prisma.sql`u.manga_name`),
  extension: textKeys(Prisma.sql`u.extension`),
  language: textKeys(Prisma.sql`u.manga_language`),
  state: textKeys(Prisma.sql`u.state::text`),
  attempts: numberKeys(Prisma.sql`u.attempts`),
  // The Result column shows the MangaDex link when there is one and the last
  // error when there is not, so it orders by that same split first: ascending
  // gathers the series that made it, descending gathers the ones that did not.
  result: [
    { sql: Prisma.sql`(u.md_manga_id IS NULL)`, cast: "boolean", dir: "follow" },
    ...textKeys(Prisma.sql`u.last_error`),
  ],
};

const UNTRACKED_ID: OrderKey = { sql: Prisma.sql`u.id`, cast: "text", dir: "follow" };

/**
 * The series map across every extension, as one listing.
 *
 * The map was only ever addressable per extension, which answers the
 * platform's question ("what does comikey track?") and not the operator's
 * ("which publishers feed this MangaDex title, and are any of them wrong?").
 * The second one could only be answered by listing all six catalogues and
 * joining them by hand, which is why nobody did.
 */
const TRACKED_COLUMNS = Prisma.sql`t.id, t.extension, t.namespace, t.manga_id AS "mangaId",
  t.md_manga_id AS "mdMangaId", t.source, t.created_at AS "createdAt",
  t.recheck_after AS "recheckAfter", t.cooldown_days AS "cooldownDays",
  t.paused_at AS "pausedAt", t.paused_by AS "pausedBy", t.pause_reason AS "pauseReason"`;

const TRACKED_SORTS = ["extension", "catalogue", "series", "mangadex", "source", "added"] as const;

const TRACKED_SORT_COLUMNS: SortColumns = {
  extension: textKeys(Prisma.sql`t.extension`),
  catalogue: textKeys(Prisma.sql`t.namespace`),
  series: textKeys(Prisma.sql`t.manga_id`),
  mangadex: textKeys(Prisma.sql`t.md_manga_id`),
  source: textKeys(Prisma.sql`t.source`),
  added: [{ sql: Prisma.sql`t.created_at`, cast: "timestamp", dir: "follow" }],
};

const TRACKED_ID: OrderKey = { sql: Prisma.sql`t.id`, cast: "text", dir: "follow" };

/**
 * MangaDex ids that more than one mapping points at.
 *
 * A subquery rather than a window function over the page: a window would count
 * only the rows that survived the filter, so filtering to one extension would
 * report every title as having a single source — which is the exact opposite of
 * the answer being asked for.
 */
const SHARED_TITLES = Prisma.sql`(
  SELECT md_manga_id FROM tracked_manga GROUP BY md_manga_id HAVING count(*) > 1
)`;

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
import {
  DEFAULT_FETCH_THROTTLE,
  DEFAULT_UPLOAD_SCHEDULE,
  UPLOAD_BUDGET_SCOPES,
  VALID_REMOVAL_MODES,
} from "../../store/settings.js";
import { BundleRejectedError } from "../../store/bundles.js";
import { MapSyncService } from "../../mapsync/service.js";
import AdmZip from "adm-zip";

const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

/**
 * One schedule slot on the wire.
 *
 * Deliberately the manifest's own entry schema minus `timezone`: an operator
 * and a manifest are describing the same thing, and letting the two drift is
 * how you end up with a `days` an extension author can write and an operator
 * cannot. `timezone` is dropped because it has exactly one legal value and
 * accepting it here would imply otherwise.
 */
const ScheduleSlotInput = ManifestScheduleEntry.omit({ timezone: true });

/** Wire shape into the normalised slot every layer below this one speaks. */
function toSlot(input: z.infer<typeof ScheduleSlotInput>): ScheduleSlot {
  return {
    hour: input.hour,
    minute: input.minute,
    days: normalizeWeekdays(input),
    kind: input.kind,
    ...(input.label !== undefined ? { label: input.label } : {}),
  };
}

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
 * A boolean that may arrive as a query-string word. Not `z.coerce.boolean()`,
 * which is `Boolean(value)`, so the string "false" coerces to true. Same helper
 * as routes/chapters.ts and routes/queues.ts.
 */
const Flag = z.preprocess(
  (value) => (typeof value === "string" ? value === "true" || value === "1" : value),
  z.boolean(),
);

/**
 * A filter that accepts one value or several, so `?state=FAILED&state=CANCELLED`
 * means either. Fastify parses a repeated key into an array; a single one stays
 * a string, and both become a deduplicated list here.
 */
function oneOrMany<T extends readonly [string, ...string[]]>(values: T) {
  return z
    .union([z.enum(values), z.array(z.enum(values)).min(1)])
    .transform((value) => (Array.isArray(value) ? [...new Set(value)] : [value]));
}

const RUN_STATES = Object.values(RunState) as [RunState, ...RunState[]];
const RUN_KINDS = Object.values(RunKind) as [RunKind, ...RunKind[]];

/**
 * How many links one paste may carry.
 *
 * Far below the tracked map's 2000-row cap, and deliberately: those rows are a
 * pure write, while each of these is resolved against the queue, the map and a
 * measured rule first. Two hundred is a publisher's whole front page and still
 * answers inside one interactive request.
 */
const MAX_SOURCE_BATCH = 200;

/**
 * A MangaDex title id, accepted as either the bare uuid or the link an operator
 * has open in the tab where they checked the series is the right one.
 *
 * Stripping the link here rather than at each caller is what makes "paste the
 * mangadex.org link" true of the dashboard, the CLI, the bot and any script
 * against this API at the same time; and the message on a bad value names what
 * was pasted (a chapter link, a legacy numeric id) instead of "invalid uuid".
 */
const MdTitleId = z.string().transform((value, ctx) => {
  const parsed = parseMdTitleId(value);
  if ("error" in parsed) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: parsed.error });
    return z.NEVER;
  }
  return parsed.id;
});

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
  /**
   * What the source-link resolver reads: our own rows, plus the published
   * manifests whose `allowed_hosts` say which extension covers a site.
   *
   * The manifests are read per call rather than cached. Resolving a link is an
   * interactive action a person is waiting on, not a hot path, and a cache here
   * would answer "no extension serves that host" for as long as it lived after
   * someone published the extension that does.
   */
  const sourceLinkDeps = (): SourceLinkDeps => ({
    prisma: ctx.prisma,
    manifests: async () => {
      const bundles = await ctx.bundles.listLatest();
      const out = new Map<string, Manifest>();
      for (const bundle of bundles) {
        const parsed = Manifest.safeParse(bundle.manifest);
        // A bundle whose manifest no longer parses is not a reason to fail the
        // whole lookup; it is one extension that cannot claim a host.
        if (parsed.success) out.set(bundle.extension, parsed.data);
      }
      return out;
    },
  });

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

    /**
     * Recent runs, newest first, filtered.
     *
     * Every filter narrows the same ordering rather than changing it, so a
     * filtered page is a subsequence of the unfiltered one and `total` counts
     * what matched rather than what was returned — otherwise "25 runs" would
     * mean the page size on every query wide enough to fill it.
     *
     * Offset paging rather than a cursor: unlike the log table, `runs` is
     * appended to slowly (a handful an hour), and an operator paging back
     * through a filtered history is not racing the writer in a way that would
     * skip or repeat rows often enough to matter.
     */
    scope.get("/api/v1/admin/runs", { preHandler: requireScope("runs:read") }, async (req) => {
      const query = parseOrThrow(
        z.object({
          limit: z.coerce.number().int().min(1).max(200).default(25),
          offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
          extension: z.string().max(64).optional(),
          /** Repeatable: `?state=FAILED&state=DEAD_LETTER` means either. */
          state: oneOrMany(RUN_STATES).optional(),
          kind: oneOrMany(RUN_KINDS).optional(),
          /** Case-insensitive substring: "user:" finds every manual trigger. */
          triggeredBy: z.string().min(1).max(200).optional(),
          /**
           * Scope shape, not a title id. A CLEAN run over three named titles and
           * one over the whole catalogue make incompatible claims about what a
           * missing chapter means, and telling them apart in a list is the point
           * of the filter.
           */
          scope: z.enum(["catalogue", "scoped"]).optional(),
          /** Only runs that recorded an error. */
          failed: Flag.optional(),
          /** Case-insensitive substring over the run and idempotency ids and the error. */
          q: z.string().min(1).max(200).optional(),
          since: z.coerce.date().optional(),
          before: z.coerce.date().optional(),
        }),
        req.query ?? {},
      );

      const createdAt: { gte?: Date; lt?: Date } = {};
      if (query.since) createdAt.gte = query.since;
      if (query.before) createdAt.lt = query.before;

      const where: Prisma.RunWhereInput = {
        ...(query.extension ? { extension: query.extension } : {}),
        ...(query.state ? { state: { in: query.state } } : {}),
        ...(query.kind ? { kind: { in: query.kind } } : {}),
        ...(query.triggeredBy
          ? { triggeredBy: { contains: query.triggeredBy, mode: "insensitive" as const } }
          : {}),
        // `isEmpty` on the array column, so this is answered by the row itself
        // rather than by counting ids.
        ...(query.scope ? { scopeMangaIds: { isEmpty: query.scope === "catalogue" } } : {}),
        ...(query.failed === undefined
          ? {}
          : query.failed
            ? { error: { not: null } }
            : { error: null }),
        ...(query.q
          ? {
              OR: [
                { id: { contains: query.q, mode: "insensitive" as const } },
                { idempotencyKey: { contains: query.q, mode: "insensitive" as const } },
                { error: { contains: query.q, mode: "insensitive" as const } },
              ],
            }
          : {}),
        ...(Object.keys(createdAt).length > 0 ? { createdAt } : {}),
      };

      const [runs, total] = await Promise.all([
        ctx.prisma.run.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: query.limit,
          skip: query.offset,
        }),
        ctx.prisma.run.count({ where }),
      ]);
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
            titlesFound: found ? found.titlesUpdated : null,
            untrackedManga: found ? found.untrackedManga : null,
            /** True when the run looked at named titles only; see `scopeMangaIds`. */
            scoped: run.scopeMangaIds.length > 0,
          };
        }),
        total,
        limit: query.limit,
        offset: query.offset,
        /** What `state`, `kind` and `scope` accept, so a client need not hardcode them. */
        filters: { state: RUN_STATES, kind: RUN_KINDS, scope: ["catalogue", "scoped"] },
      };
    });

    scope.get("/api/v1/admin/runs/:id", { preHandler: requireScope("runs:read") }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const run = await ctx.prisma.run.findUnique({ where: { id }, include: { jobs: true } });
      if (!run) return reply.code(404).send({ error: "unknown run" });
      // The lease holder is stored as an id; operators think in worker names,
      // so resolve them here rather than making every surface do its own read.
      const names = await workerNames(
        ctx.prisma,
        run.jobs.map((job) => job.leaseWorkerId),
      );
      return {
        run: {
          ...run,
          jobs: run.jobs.map((job) => ({
            ...job,
            leaseWorkerName: job.leaseWorkerId ? (names.get(job.leaseWorkerId) ?? null) : null,
          })),
        },
      };
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

    /**
     * The dead-letter queue, hiding what an operator has already cleared.
     *
     * `cleared=without` (the default) is the to-do list and matches the error
     * feed; `with` is the full queue, `only` is what has been dealt with. The
     * rows are untouched either way — this is the feed's view filter, not a
     * state change — and `clearedHidden` keeps the default from reading as
     * "nothing ever failed".
     */
    scope.get("/api/v1/admin/dead-letter", { preHandler: requireScope("runs:read") }, async (req) => {
      const query = parseOrThrow(
        z.object({ cleared: z.enum(["without", "with", "only"]).default("without") }),
        req.query ?? {},
      );
      return listDeadLetterJobs(ctx.prisma, { limit: 100, cleared: query.cleared });
    });

    /** Quarantined submissions, hiding what has been cleared. See `/dead-letter`. */
    scope.get("/api/v1/admin/quarantine", { preHandler: requireScope("runs:read") }, async (req) => {
      const query = parseOrThrow(
        z.object({ cleared: z.enum(["without", "with", "only"]).default("without") }),
        req.query ?? {},
      );
      return listQuarantinedSubmissions(ctx.prisma, { limit: 100, cleared: query.cleared });
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

    /**
     * The manifest schedule of every published extension, normalised.
     *
     * Read from the latest bundles rather than a cache: the manifest is the
     * default an operator is choosing to keep or replace, so it has to be the
     * manifest that is actually deployed.
     */
    const manifestSchedules = async (): Promise<Record<string, ScheduleSlot[]>> => {
      const bundles = await ctx.bundles.listLatest();
      const out: Record<string, ScheduleSlot[]> = {};
      for (const b of bundles) {
        const m = Manifest.safeParse(b.manifest);
        if (!m.success) continue;
        const slots = manifestSchedule(m.data);
        if (slots.length > 0) out[b.extension] = slots;
      }
      return out;
    };

    scope.get("/api/v1/admin/schedules", { preHandler: requireScope("extensions:read") }, async () => {
      const [entries, defaults] = await Promise.all([
        ctx.settings.listAllScheduleEntries(),
        manifestSchedules(),
      ]);
      // `effective` is computed here rather than left to each caller, because
      // three surfaces were about to re-derive "rows if any, else manifest,
      // minus the disabled ones" and a disagreement between them would show as
      // a dashboard that confidently displays a schedule the scheduler is not
      // running.
      const effective: Record<string, ScheduleSlot[]> = {};
      for (const name of new Set([...Object.keys(defaults), ...Object.keys(entries)])) {
        const rows = entries[name];
        effective[name] = rows
          ? rows.filter((r) => r.enabled).map(({ id: _id, enabled: _enabled, ...slot }) => slot)
          : (defaults[name] ?? []);
      }
      return { defaults, overrides: entries, effective };
    });

    scope.get(
      "/api/v1/admin/schedules/:name",
      { preHandler: requireScope("extensions:read") },
      async (req, reply) => {
        const { name } = req.params as { name: string };
        if (!EXTENSION_NAME_RE.test(name)) return reply.code(400).send({ error: "bad name" });
        const [entries, defaults] = await Promise.all([
          ctx.settings.listScheduleEntries(name),
          manifestSchedules(),
        ]);
        const manifest = defaults[name] ?? [];
        const effective =
          entries.length > 0
            ? entries.filter((r) => r.enabled).map(({ id: _id, enabled: _enabled, ...slot }) => slot)
            : manifest;
        return { extension: name, manifest, entries, effective, source: entries.length > 0 ? "operator" : "manifest" };
      },
    );

    /**
     * Replace the whole schedule.
     *
     * Accepts a list, or a single slot for the callers that predate lists:
     * the old body shape meant exactly "this extension's schedule is this one
     * time", which is a one-element list and needs no separate handling beyond
     * being recognised. An empty list is legal and means "run nothing", which
     * is NOT the same as DELETE (fall back to the manifest).
     */
    scope.put("/api/v1/admin/schedules/:name", { preHandler: requireScope("extensions:write") }, async (req, reply) => {
      const { name } = req.params as { name: string };
      if (!EXTENSION_NAME_RE.test(name)) return reply.code(400).send({ error: "bad name" });
      const body = z
        .union([ScheduleSlotInput, z.object({ entries: z.array(ScheduleSlotInput).max(48) })])
        .parse(req.body);
      const slots = ("entries" in body ? body.entries : [body]).map(toSlot);
      const count = await ctx.settings.replaceScheduleEntries(name, slots);
      await ctx.audit.record(actor(req), "schedule.set", name, { entries: slots });
      return { ok: true, entries: count };
    });

    /** Append one slot, seeding the manifest's slots first if there are none. */
    scope.post("/api/v1/admin/schedules/:name", { preHandler: requireScope("extensions:write") }, async (req, reply) => {
      const { name } = req.params as { name: string };
      if (!EXTENSION_NAME_RE.test(name)) return reply.code(400).send({ error: "bad name" });
      const slot = toSlot(ScheduleSlotInput.parse(req.body));
      const defaults = await manifestSchedules();
      const result = await ctx.settings.addScheduleEntry(name, slot, defaults[name] ?? []);
      await ctx.audit.record(actor(req), "schedule.add", name, { ...slot, ...result });
      return { ok: true, ...result };
    });

    /** Switch one slot on or off, keeping what it said. */
    scope.patch(
      "/api/v1/admin/schedules/:name/:id",
      { preHandler: requireScope("extensions:write") },
      async (req, reply) => {
        const { name, id } = req.params as { name: string; id: string };
        if (!EXTENSION_NAME_RE.test(name)) return reply.code(400).send({ error: "bad name" });
        const body = z.object({ enabled: z.boolean() }).parse(req.body);
        const updated = await ctx.settings.setScheduleEntryEnabled(name, id, body.enabled);
        if (!updated) return reply.code(404).send({ error: "no such schedule entry" });
        await ctx.audit.record(actor(req), "schedule.toggle", name, { id, enabled: body.enabled });
        return { ok: true, enabled: body.enabled };
      },
    );

    scope.delete(
      "/api/v1/admin/schedules/:name/:id",
      { preHandler: requireScope("extensions:write") },
      async (req, reply) => {
        const { name, id } = req.params as { name: string; id: string };
        if (!EXTENSION_NAME_RE.test(name)) return reply.code(400).send({ error: "bad name" });
        const removed = await ctx.settings.removeScheduleEntry(name, id);
        if (!removed) return reply.code(404).send({ error: "no such schedule entry" });
        await ctx.audit.record(actor(req), "schedule.remove", name, { id });
        return { ok: true, removed };
      },
    );

    /** Drop every slot: the extension falls back to its manifest schedule. */
    scope.delete("/api/v1/admin/schedules/:name", { preHandler: requireScope("extensions:write") }, async (req) => {
      const { name } = req.params as { name: string };
      const removed = await ctx.settings.removeSchedule(name);
      await ctx.audit.record(actor(req), "schedule.reset", name, { removed });
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

    // ---- publisher fetch pacing ----

    /**
     * How fast workers may talk to a publisher, and how regular it looks.
     *
     * Operator infrastructure, not extension config: the operator owns how hard
     * their addresses hit a publisher, and the answer differs per publisher
     * without the extension having a say. `overrides` is per extension and
     * merges over the global field by field, so raising one interval does not
     * mean restating the jitter that was already fine.
     */
    scope.get("/api/v1/admin/fetch-throttle", { preHandler: requireScope("settings:read") }, async () => ({
      global: await ctx.settings.getFetchThrottle(),
      overrides: await ctx.settings.getFetchThrottleOverrides(),
      defaults: DEFAULT_FETCH_THROTTLE,
    }));

    const throttleBody = z
      .object({
        minIntervalMs: z.coerce.number().int().min(100).max(60_000).optional(),
        jitter: z.boolean().optional(),
        jitterRatio: z.coerce.number().min(0).max(5).optional(),
      })
      .strict();

    scope.post("/api/v1/admin/fetch-throttle", { preHandler: requireScope("settings:write") }, async (req) => {
      const body = throttleBody.parse(req.body);
      await ctx.settings.setFetchThrottle(body);
      const applied = await ctx.settings.getFetchThrottle();
      await ctx.audit.record(actor(req), "fetch_throttle.set", "global", applied);
      return { ok: true, global: applied };
    });

    /**
     * One extension's override. An empty body clears it, so the extension goes
     * back to following the global rather than being pinned to whatever the
     * global happened to be when it was set.
     */
    scope.post(
      "/api/v1/admin/fetch-throttle/:name",
      { preHandler: requireScope("settings:write") },
      async (req, reply) => {
        const { name } = req.params as { name: string };
        if (!EXTENSION_NAME_RE.test(name)) return reply.code(400).send({ error: "bad name" });
        const body = throttleBody.parse(req.body ?? {});
        const clearing = Object.keys(body).length === 0;
        await ctx.settings.setFetchThrottleOverride(name, clearing ? null : body);
        const applied = await ctx.settings.getFetchThrottle(name);
        await ctx.audit.record(actor(req), "fetch_throttle.set", name, {
          cleared: clearing,
          ...applied,
        });
        return { ok: true, extension: name, cleared: clearing, effective: applied };
      },
    );

    // ---- upload release spreading ----

    /**
     * How many chapters a run may put on MangaDex per day.
     *
     * Operator infrastructure for the same reason the fetch throttle is: the
     * extension decides what is publishable, the operator decides how fast that
     * reaches readers. Spreading only changes a task's `not_before`, so nothing
     * is dropped and a routine run — well under the caps — is unaffected.
     */
    scope.get(
      "/api/v1/admin/upload-schedule",
      { preHandler: requireScope("settings:read") },
      async () => ({
        global: await ctx.settings.getUploadSchedule(),
        overrides: await ctx.settings.getUploadScheduleOverrides(),
        defaults: DEFAULT_UPLOAD_SCHEDULE,
        scope: await ctx.settings.getUploadBudgetScope(),
        scopes: UPLOAD_BUDGET_SCOPES,
        priority: await ctx.settings.getUploadPriorityExtensions(),
        paused: await ctx.settings.getUploadPausedExtensions(),
        // The names the priority and pause pickers offer.
        //
        // Published bundles, the same source `GET /extensions` lists, NOT
        // `extension_configs`: a config row only exists once something has
        // written one, so two live extensions (alpha_manga and viz, one of them
        // merely disabled rather than gone) had no row and silently could not
        // be prioritised or paused. A picker missing an extension is worse than
        // one showing a stale name -- the operator cannot tell the control is
        // absent rather than the setting off.
        //
        // Read here rather than left to the client because the picker must not
        // be able to arm a name the platform does not know, and the client's
        // own extension list belongs to a different page's resource.
        extensions: [...new Set((await ctx.bundles.listLatest()).map((b) => b.extension))].sort(),
      }),
    );

    // 0 is allowed and means "no limit"; the store clamps the rest.
    const uploadScheduleBody = z
      .object({
        perDay: z.coerce.number().int().min(0).max(100_000).optional(),
        perMangaPerDay: z.coerce.number().int().min(0).max(100_000).optional(),
        intervalHours: z.coerce.number().int().min(1).max(24 * 30).optional(),
        // 0 is auto: spread a day evenly, and do not pace enqueueing.
        spacingSeconds: z.coerce.number().int().min(0).max(24 * 3600).optional(),
      })
      .strict();

    /**
     * Whether `perDay` is one platform-wide pool or one per extension.
     *
     * Its own route rather than a field on the schedule body: a per-extension
     * override cannot coherently choose the scope, so this is set once for
     * everybody and the override routes stay about numbers.
     */
    scope.post(
      "/api/v1/admin/upload-schedule/scope",
      { preHandler: requireScope("settings:write") },
      async (req) => {
        const body = parseOrThrow(
          z.object({ scope: z.enum(UPLOAD_BUDGET_SCOPES) }).strict(),
          req.body ?? {},
        );
        await ctx.settings.setUploadBudgetScope(body.scope);
        await ctx.audit.record(actor(req), "upload_schedule.scope", body.scope, {
          scope: body.scope,
        });
        return { ok: true, scope: body.scope };
      },
    );

    /**
     * Which extensions ignore the queue entirely.
     *
     * A list rather than a flag on the per-extension override, because the
     * override body is about numbers and this is not a number: it says the
     * pacing arithmetic does not apply at all. Set wholesale so the answer to
     * "who has priority?" is one row an operator can read, not a field to hunt
     * for across every extension.
     */
    scope.post(
      "/api/v1/admin/upload-schedule/priority",
      { preHandler: requireScope("settings:write") },
      async (req, reply) => {
        const body = parseOrThrow(
          z
            .object({ extensions: z.array(z.string().max(64)).max(50) })
            .strict(),
          req.body ?? {},
        );
        const bad = body.extensions.filter((name) => !EXTENSION_NAME_RE.test(name));
        if (bad.length > 0) {
          return reply.code(400).send({ error: `not extension names: ${bad.join(", ")}` });
        }
        const applied = await ctx.settings.setUploadPriorityExtensions(body.extensions);
        await ctx.audit.record(actor(req), "upload_schedule.priority", undefined, {
          extensions: applied,
        });
        return { ok: true, priority: applied };
      },
    );

    /**
     * Which extensions the uploader holds work for.
     *
     * Distinct from the global pause, which stops the platform: this holds one
     * publisher while everybody else keeps draining. Nothing is cancelled or
     * re-dated -- the tasks stay PENDING and the uploader simply steps over
     * them -- so un-pausing needs no repair.
     *
     * Note it does not stop the queue GROWING: runs still decide and enqueue.
     * It stops work reaching MangaDex, which is the thing an operator is
     * usually trying to stop.
     */
    scope.post(
      "/api/v1/admin/upload-schedule/paused",
      { preHandler: requireScope("settings:write") },
      async (req, reply) => {
        const body = parseOrThrow(
          z.object({ extensions: z.array(z.string().max(64)).max(50) }).strict(),
          req.body ?? {},
        );
        const bad = body.extensions.filter((name) => !EXTENSION_NAME_RE.test(name));
        if (bad.length > 0) {
          return reply.code(400).send({ error: `not extension names: ${bad.join(", ")}` });
        }
        const applied = await ctx.settings.setUploadPausedExtensions(body.extensions);
        await ctx.audit.record(actor(req), "upload_schedule.paused", undefined, {
          extensions: applied,
        });
        return { ok: true, paused: applied };
      },
    );

    scope.post(
      "/api/v1/admin/upload-schedule",
      { preHandler: requireScope("settings:write") },
      async (req) => {
        const body = uploadScheduleBody.parse(req.body);
        await ctx.settings.setUploadSchedule(body);
        const applied = await ctx.settings.getUploadSchedule();
        await ctx.audit.record(actor(req), "upload_schedule.set", "global", applied);
        return { ok: true, global: applied };
      },
    );

    /** One extension's override; an empty body clears it, as above. */
    scope.post(
      "/api/v1/admin/upload-schedule/:name",
      { preHandler: requireScope("settings:write") },
      async (req, reply) => {
        const { name } = req.params as { name: string };
        if (!EXTENSION_NAME_RE.test(name)) return reply.code(400).send({ error: "bad name" });
        const body = uploadScheduleBody.parse(req.body ?? {});
        const clearing = Object.keys(body).length === 0;
        await ctx.settings.setUploadScheduleOverride(name, clearing ? null : body);
        const applied = await ctx.settings.getUploadSchedule(name);
        await ctx.audit.record(actor(req), "upload_schedule.set", name, {
          cleared: clearing,
          ...applied,
        });
        return { ok: true, extension: name, cleared: clearing, effective: applied };
      },
    );

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
    /**
     * Every mapping, across every extension: searchable, paged and sortable.
     *
     * The per-extension listing below stays, and stays the one you edit in. This
     * one exists for the questions that are not about an extension at all:
     *
     *   - "which publishers feed this MangaDex title?" — `mdMangaId`, or paste
     *     the link into `q`. Two extensions on one title is legitimate and
     *     common (a series two catalogues both carry), so this reports it
     *     rather than flagging it: `sources` counts the mappings sharing a
     *     title, and `shared=only` lists just those.
     *   - "where did this mapping come from?" — `source` is searched by `q`
     *     too, so `auto:official-link` gathers everything nobody reviewed.
     *
     * Server-paged for the same reason the queue is: three and a half thousand
     * mappings is more than a browser should be sorting, and an operator
     * ordering by one column means the whole map, not the page in hand.
     */
    scope.get("/api/v1/admin/tracked", { preHandler: requireScope("tracked:read") }, async (req, reply) => {
      const query = parseOrThrow(
        z.object({
          /** Free text over the external id, the MangaDex id and the source. */
          q: z.string().trim().max(200).optional(),
          extension: z.string().trim().max(64).optional(),
          /** "" is a real catalogue (the flat id space), so this is not blank-checked. */
          namespace: z.string().trim().max(MAX_NAMESPACE_LENGTH).optional(),
          /** Exact, and the reason this endpoint exists. Also accepts a title link. */
          mdMangaId: z.string().trim().max(2048).optional(),
          shared: z.enum(["all", "only"]).default("all"),
          /**
           * Who made the mapping.
           *
           * `automatic` is the one worth asking for: a mapping nothing human
           * looked at is the first thing to check when a series turns out to be
           * wired to the wrong title, and until now the only way to gather them
           * was to guess the source string into the search box.
           */
          madeBy: z.enum(["all", "automatic", "person"]).default("all"),
          paused: z.enum(["all", "only", "none"]).default("all"),
          limit: z.coerce.number().int().min(1).max(500).default(100),
          cursor: z.string().max(512).optional(),
          orderBy: z.enum(TRACKED_SORTS).optional(),
          dir: z.enum(["asc", "desc"]).default("asc"),
        }),
        req.query ?? {},
      );

      const filter: Prisma.Sql[] = [];
      if (query.extension) filter.push(Prisma.sql`t.extension = ${query.extension}`);
      if (query.namespace !== undefined) filter.push(Prisma.sql`t.namespace = ${query.namespace}`);
      if (query.mdMangaId) {
        // A pasted title link is the form this id arrives in; refusing it and
        // asking for "just the uuid" is asking the operator to do a parse the
        // server already knows how to do.
        const title = parseMdTitleId(query.mdMangaId);
        if ("error" in title) return reply.code(400).send({ error: title.error });
        filter.push(Prisma.sql`t.md_manga_id = ${title.id}`);
      }
      if (query.q) {
        const like = `%${query.q}%`;
        filter.push(
          Prisma.sql`(t.manga_id ILIKE ${like} OR t.md_manga_id ILIKE ${like} OR t.source ILIKE ${like} OR t.extension ILIKE ${like})`,
        );
      }
      if (query.shared === "only") filter.push(Prisma.sql`t.md_manga_id IN ${SHARED_TITLES}`);
      // The `auto:` prefix, not every source beginning with "auto": a title this
      // service created after somebody pressed Approve is recorded as plain
      // `auto`, and a person did choose that one.
      if (query.madeBy === "automatic") filter.push(Prisma.sql`t.source LIKE 'auto:%'`);
      if (query.madeBy === "person") filter.push(Prisma.sql`t.source NOT LIKE 'auto:%'`);
      // Paused is a moment in time, not a flag: a cooldown expires by itself.
      if (query.paused === "only") filter.push(Prisma.sql`t.recheck_after > now()`);
      if (query.paused === "none") filter.push(Prisma.sql`(t.recheck_after IS NULL OR t.recheck_after <= now())`);

      const page = [...filter];
      const sorted = sortedBy(
        TRACKED_SORT_COLUMNS,
        query.orderBy ? { name: query.orderBy, dir: query.dir, cursor: query.cursor ?? null } : null,
        TRACKED_ID,
      );
      if (sorted) {
        const after = sorted.order.after(sorted.after);
        if (after) page.push(after);
      } else if (query.cursor) {
        const at = await ctx.prisma.trackedManga.findUnique({
          where: { id: query.cursor },
          select: { id: true, createdAt: true },
        });
        if (!at) return reply.code(400).send({ error: `unknown cursor: ${query.cursor}` });
        page.push(Prisma.sql`(t.created_at, t.id) < (${at.createdAt}, ${at.id})`);
      }

      const predicate = (parts: Prisma.Sql[]) =>
        parts.length > 0 ? Prisma.sql`WHERE ${Prisma.join(parts, " AND ")}` : Prisma.empty;

      const [rows, counted] = await Promise.all([
        ctx.prisma.$queryRaw<(UntrackedRow & Record<string, unknown>)[]>(Prisma.sql`
          SELECT ${TRACKED_COLUMNS}${sorted ? Prisma.sql`, ${sorted.order.select}` : Prisma.empty}
          FROM tracked_manga t
          ${predicate(page)}
          ORDER BY ${sorted ? sorted.order.orderBy : Prisma.sql`t.created_at DESC, t.id DESC`}
          LIMIT ${query.limit}
        `),
        ctx.prisma.$queryRaw<{ total: bigint }[]>(
          Prisma.sql`SELECT count(*) AS total FROM tracked_manga t ${predicate(filter)}`,
        ),
      ]);

      const stripped = sorted ? rows.map((row) => sorted.order.strip(row)) : rows;

      /*
       * How many mappings share each title on this page.
       *
       * One grouped query over the page's ids rather than a per-row subquery in
       * the listing: the count has to be of the WHOLE map, not of the rows that
       * survived the filter, and this is the cheap way to say that. Titles
       * absent from the answer have exactly one mapping — their own.
       */
      const ids = [...new Set(stripped.map((row) => String(row["mdMangaId"])))];
      const shared = ids.length
        ? await ctx.prisma.trackedManga.groupBy({
            by: ["mdMangaId"],
            where: { mdMangaId: { in: ids } },
            _count: { _all: true },
          })
        : [];
      const sourcesFor = new Map(shared.map((group) => [group.mdMangaId, group._count._all]));

      const last = rows[rows.length - 1];
      return {
        nextCursor:
          rows.length === query.limit && last
            ? sorted
              ? encodeSortCursor(sorted.name, sorted.dir, sorted.order.cursorOf(last))
              : String(last["id"])
            : null,
        tracked: stripped.map((row) => ({
          ...row,
          sources: sourcesFor.get(String(row["mdMangaId"])) ?? 1,
        })),
        total: Number(counted[0]?.total ?? 0),
        limit: query.limit,
        orderedBy: query.orderBy ?? null,
        dir: query.dir,
        sortable: TRACKED_SORTS,
      };
    });

    /**
     * Which extensions have mappings at all, with their counts.
     *
     * The listing above pages, so it cannot be counted per extension from the
     * client, and the console needs the picker filled in before the first page
     * comes back.
     */
    scope.get("/api/v1/admin/tracked/extensions", { preHandler: requireScope("tracked:read") }, async () => {
      const groups = await ctx.prisma.trackedManga.groupBy({
        by: ["extension"],
        _count: { _all: true },
        orderBy: { extension: "asc" },
      });
      const namespaces = await ctx.prisma.trackedManga.groupBy({
        by: ["namespace"],
        _count: { _all: true },
        orderBy: { namespace: "asc" },
      });
      return {
        extensions: groups.map((group) => ({ extension: group.extension, count: group._count._all })),
        namespaces: namespaces.map((group) => ({ namespace: group.namespace, count: group._count._all })),
      };
    });

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
      const body = parseOrThrow(
        z.object({
          mangaId: z.string().min(1).max(512),
          // Accepts a mangadex.org/title/… link and stores only the id in it.
          mdMangaId: MdTitleId,
          /** The extension's catalogue; omit for the single flat id space. */
          namespace: z.string().max(MAX_NAMESPACE_LENGTH).optional(),
        }),
        req.body,
      );
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
     * Series currently suppressed from runs, soonest to return first.
     *
     * Separate from the `tracked` listing rather than a filter on it, because
     * this is the review surface: "what have I turned off, and when does it
     * come back" is the question a pause creates, and it should not require
     * paging the whole catalogue to answer.
     */
    scope.get("/api/v1/admin/extensions/:name/tracked/paused", { preHandler: requireScope("tracked:read") }, async (req, reply) => {
      const { name } = req.params as { name: string };
      if (!EXTENSION_NAME_RE.test(name)) return reply.code(400).send({ error: "bad name" });
      const paused = await ctx.trackedManga.listPaused(name);
      return { paused, defaultCooldownDays: DEFAULT_COOLDOWN_DAYS };
    });

    /**
     * Suppress series from runs until their cooldown expires.
     *
     * Bulk, because the operation that matters is bulk: on a publisher whose
     * free set is a frozen prefix, "every series with one free chapter" is
     * hundreds of rows, and pausing them one call at a time is a loop the
     * operator should not have to write.
     *
     * `tracked:write` rather than `tracked:append`: a pause changes what runs
     * do to titles that already exist, which is the same class of authority as
     * repointing a mapping, not the same as adding a new series.
     */
    scope.post("/api/v1/admin/extensions/:name/tracked/pause", { preHandler: requireScope("tracked:write") }, async (req, reply) => {
      const { name } = req.params as { name: string };
      if (!EXTENSION_NAME_RE.test(name)) return reply.code(400).send({ error: "bad name" });
      const body = z
        .object({
          mangaIds: z.array(z.string().min(1).max(512)).min(1).max(MAX_BATCH_ROWS),
          namespace: z.string().max(MAX_NAMESPACE_LENGTH).optional(),
          days: z.number().int().min(1).max(MAX_COOLDOWN_DAYS).default(DEFAULT_COOLDOWN_DAYS),
          /** False makes it a one-shot hold that expires for good. */
          renew: z.boolean().default(true),
          reason: z.string().max(500).optional(),
        })
        .strict()
        .parse(req.body ?? {});

      const namespace = normaliseNamespace(body.namespace);
      const result = await ctx.trackedManga.pause(name, {
        targets: body.mangaIds.map((mangaId) => ({ mangaId, namespace })),
        days: body.days,
        renew: body.renew,
        ...(body.reason === undefined ? {} : { reason: body.reason }),
        actor: actor(req),
      });
      await ctx.audit.record(actor(req), "tracked_manga.pause", `${name}:${body.mangaIds.length} series`, {
        mangaIds: body.mangaIds.slice(0, 50),
        count: body.mangaIds.length,
        namespace,
        days: body.days,
        renew: body.renew,
        reason: body.reason ?? null,
      });
      return { ok: true, ...result };
    });

    /** Put paused series back in play immediately. */
    scope.post("/api/v1/admin/extensions/:name/tracked/unpause", { preHandler: requireScope("tracked:write") }, async (req, reply) => {
      const { name } = req.params as { name: string };
      if (!EXTENSION_NAME_RE.test(name)) return reply.code(400).send({ error: "bad name" });
      const body = z
        .object({
          mangaIds: z.array(z.string().min(1).max(512)).min(1).max(MAX_BATCH_ROWS),
          namespace: z.string().max(MAX_NAMESPACE_LENGTH).optional(),
        })
        .strict()
        .parse(req.body ?? {});

      const namespace = normaliseNamespace(body.namespace);
      const result = await ctx.trackedManga.unpause(
        name,
        body.mangaIds.map((mangaId) => ({ mangaId, namespace })),
      );
      await ctx.audit.record(actor(req), "tracked_manga.unpause", `${name}:${body.mangaIds.length} series`, {
        mangaIds: body.mangaIds.slice(0, 50),
        count: body.mangaIds.length,
        namespace,
      });
      return { ok: true, ...result };
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
    scope.get("/api/v1/admin/untracked", { preHandler: requireScope("untracked:read") }, async (req, reply) => {
      const query = z
        .object({
          state: z.enum(["NEW", "CREATING", "CREATED", "TRACKED", "FAILED", "SKIPPED"]).optional(),
          /** Free text over the series name, the source's id, and the extension. */
          q: z.string().trim().max(200).optional(),
          /**
           * Exact extension. Separate from `q`, which only matches the name as
           * a substring: "omoi" as free text also hits every series with omoi
           * in its title, and cannot express "this source and no other".
           */
          extension: z.string().trim().max(64).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
          /**
           * Keyset position. In the default ordering that is the id of the last
           * row of the previous page; under `orderBy` it is the cursor that
           * ordering issued, which carries the key values as well as the id.
           */
          cursor: z.string().max(512).optional(),
          /**
           * Order the whole queue by one column rather than newest-first. What
           * the console's header buttons send: ordering only the fifty rows
           * already fetched would answer "the first of this page" to a question
           * asked about the whole queue.
           */
          orderBy: z.enum(UNTRACKED_SORTS).optional(),
          dir: z.enum(["asc", "desc"]).default("asc"),
          /**
           * What to do with rows whose series is ALREADY in the series map
           * while the row itself still says otherwise.
           *
           * These are stale, and dangerously so: the row reads NEW, so the
           * pipeline offers it for title creation, and approving it creates a
           * SECOND MangaDex title for a series that already has one. That has
           * happened here, and cleaning it up meant deleting chapters off a
           * live title. So they are out of the listing by default, `show`
           * puts them back, and `only` is the cleanup view.
           */
          mapped: z.enum(["hide", "show", "only"]).default("hide"),
        })
        .parse(req.query ?? {});

      // A state filter and a page cap are not enough to find one series: a
      // busy queue holds thousands of NEW rows and the operator arrives
      // knowing the name. Matching the external id and the extension too
      // costs nothing and covers how the rows are actually referred to.
      const filter: Prisma.Sql[] = [];
      if (query.state) filter.push(Prisma.sql`u.state = ${query.state}::"UntrackedState"`);
      if (query.extension) filter.push(Prisma.sql`u.extension = ${query.extension}`);
      if (query.q) {
        const like = `%${query.q}%`;
        filter.push(
          Prisma.sql`(u.manga_name ILIKE ${like} OR u.manga_id ILIKE ${like} OR u.extension ILIKE ${like})`,
        );
      }
      // Mapped is mapped, whatever the row's own state says.
      //
      // This used to carve out state TRACKED, on the grounds that such a row is
      // finished rather than stale. True, and beside the point: this is a
      // TRIAGE queue, and a series that already has a MangaDex title is not
      // triage — it is history. Two thousand finished rows sitting in the queue
      // is how the eighty that need a decision get lost. `show` and `only` are
      // how you look at the finished ones, and the console switches to `show`
      // by itself when you ask for a state that only finished rows are in.
      const resolved = Prisma.sql`t.md_manga_id IS NOT NULL`;
      if (query.mapped === "hide") filter.push(Prisma.sql`NOT (${resolved})`);
      if (query.mapped === "only") filter.push(resolved);

      const page = [...filter];
      const sorted = sortedBy(
        UNTRACKED_SORT_COLUMNS,
        query.orderBy ? { name: query.orderBy, dir: query.dir, cursor: query.cursor ?? null } : null,
        UNTRACKED_ID,
      );
      if (sorted) {
        const after = sorted.order.after(sorted.after);
        if (after) page.push(after);
      } else if (query.cursor) {
        // The default ordering's cursor is a row id, so the row's own sort key
        // is read first. An unknown cursor is a client error rather than an
        // empty page, which would read as "there is nothing after this".
        const at = await ctx.prisma.untrackedManga.findUnique({
          where: { id: query.cursor },
          select: { id: true, createdAt: true },
        });
        if (!at) return reply.code(400).send({ error: `unknown cursor: ${query.cursor}` });
        page.push(Prisma.sql`(u.created_at, u.id) < (${at.createdAt}, ${at.id})`);
      }

      const predicate = (parts: Prisma.Sql[]) =>
        parts.length > 0 ? Prisma.sql`WHERE ${Prisma.join(parts, " AND ")}` : Prisma.empty;

      const [rows, counted] = await Promise.all([
        ctx.prisma.$queryRaw<(UntrackedRow & Record<string, unknown>)[]>(Prisma.sql`
          SELECT ${UNTRACKED_COLUMNS}${sorted ? Prisma.sql`, ${sorted.order.select}` : Prisma.empty}
          FROM untracked_manga u
          ${UNTRACKED_TRACKED_JOIN}
          ${predicate(page)}
          -- Tie-broken by id: created_at alone is not unique here — a run
          -- reports a whole catalogue at once, so hundreds of rows can share a
          -- millisecond, and a keyset on a non-unique key silently skips or
          -- repeats rows at every page boundary.
          ORDER BY ${sorted ? sorted.order.orderBy : Prisma.sql`u.created_at DESC, u.id DESC`}
          LIMIT ${query.limit}
        `),
        // The total is what makes paging honest: without it a caller cannot
        // tell "that is all of them" from "here is the first page of two
        // thousand", which is exactly what the old fixed cap looked like.
        ctx.prisma.$queryRaw<{ total: bigint }[]>(
          Prisma.sql`SELECT count(*) AS total FROM untracked_manga u ${UNTRACKED_TRACKED_JOIN} ${predicate(filter)}`,
        ),
      ]);

      const last = rows[rows.length - 1];
      return {
        // Null on the last page, so a caller can stop without a second request
        // that comes back empty.
        nextCursor:
          rows.length === query.limit && last
            ? sorted
              ? encodeSortCursor(sorted.name, sorted.dir, sorted.order.cursorOf(last))
              : last.id
            : null,
        untracked: (sorted ? rows.map((row) => sorted.order.strip(row)) : rows).map((row) =>
          withTrackedMapping(row),
        ),
        total: Number(counted[0]?.total ?? 0),
        limit: query.limit,
        orderedBy: query.orderBy ?? null,
        dir: query.dir,
        sortable: UNTRACKED_SORTS,
      };
    });

    /**
     * How many rows each source has in this state, for the queue's own picker.
     *
     * WHY IT IS NOT OPTIONAL DECORATION. The queue is ordered newest-first, and
     * a scrape adds a publisher's whole catalogue in one insert — 116 omoi rows
     * share a single millisecond — so the first two pages of "all extensions"
     * are one source, every time, and the 92 comikey rows behind them are
     * invisible. The picker listed every published extension with no numbers,
     * so "omoi is all there is" and "comikey's are on page three" looked
     * identical, and choosing a source with nothing waiting looked like a bug.
     *
     * Counts respect the state and the mapped filter, which are what change
     * them; not the free-text search, which is a needle in whichever haystack
     * this describes.
     */
    scope.get("/api/v1/admin/untracked/extensions", { preHandler: requireScope("untracked:read") }, async (req) => {
      const query = parseOrThrow(
        z.object({
          state: z.enum(["NEW", "CREATING", "CREATED", "TRACKED", "FAILED", "SKIPPED"]).optional(),
          mapped: z.enum(["hide", "show", "only"]).default("hide"),
        }),
        req.query ?? {},
      );

      const rows = await ctx.prisma.$queryRaw<{ extension: string; total: bigint }[]>(Prisma.sql`
        SELECT u.extension, count(*) AS total
        FROM untracked_manga u
        ${UNTRACKED_TRACKED_JOIN}
        WHERE ${Prisma.join(
          [
            query.state ? Prisma.sql`u.state = ${query.state}::"UntrackedState"` : Prisma.sql`TRUE`,
            query.mapped === "hide"
              ? Prisma.sql`t.md_manga_id IS NULL`
              : query.mapped === "only"
                ? Prisma.sql`t.md_manga_id IS NOT NULL`
                : Prisma.sql`TRUE`,
          ],
          " AND ",
        )}
        GROUP BY u.extension
        ORDER BY count(*) DESC, u.extension ASC
      `);

      return {
        state: query.state ?? null,
        mapped: query.mapped,
        // Ordered by how much is waiting: the source with a backlog is the one
        // to open, and reading that off an alphabetical list is work.
        extensions: rows.map((row) => ({ extension: row.extension, count: Number(row.total) })),
        total: rows.reduce((sum, row) => sum + Number(row.total), 0),
      };
    });

    /**
     * Candidate MangaDex titles for a series, so an operator can map an
     * untracked row onto a title that already exists instead of creating a
     * second one for it.
     *
     * Read-only and live: MangaDex is the authority on what it holds, and a
     * cached answer here would be a cached answer about whether a duplicate is
     * about to be created.
     */
    scope.get("/api/v1/admin/mangadex/search", { preHandler: requireScope("untracked:read") }, async (req, reply) => {
      if (!ctx.titleService) {
        return reply.code(503).send({ error: "title service not available on this instance" });
      }
      const query = z
        .object({
          q: z.string().trim().min(1).max(200),
          /** The scraped name, when the query has been widened away from it. */
          reportedName: z.string().trim().max(512).optional(),
          limit: z.coerce.number().int().min(1).max(25).default(10),
        })
        .parse(req.query ?? {});
      const results = await ctx.titleService.searchTitles(
        query.q,
        query.limit,
        query.reportedName,
      );
      return { results };
    });

    /**
     * Which extension, and which of its series, a publisher link is.
     *
     * The other half of "paste the link": an operator arriving with a source
     * page had to know which extension covers that site and what that extension
     * calls the series, and neither is guessable — comikey names a series with
     * a slug, viz with a number. Answered entirely from our own rows, so it
     * costs nothing and can be run before deciding anything.
     *
     * `tracked:read` because that is what it reads: the series map, the queue,
     * and the published manifests' allowed_hosts.
     */
    scope.get("/api/v1/admin/source/resolve", { preHandler: requireScope("tracked:read") }, async (req) => {
      const query = parseOrThrow(z.object({ url: z.string().trim().min(1).max(2048) }), req.query ?? {});
      return resolveSourceUrl(sourceLinkDeps(), query.url);
    });

    /**
     * Map straight from the two links an operator has: the publisher's page and
     * the MangaDex title.
     *
     * This is the whole mapping act in one call — resolve the source link to an
     * extension and id, write the mapping, and close the queue row it came from
     * when there is one. Doing it in three separate calls is what made mapping a
     * job for whoever already knew the catalogue.
     *
     * Guarded exactly like the routes it stands in for, and refuses rather than
     * guesses wherever they would:
     *
     *   - `tracked:append` to add a mapping, `tracked:write` to move one. A
     *     source link resolving onto an already-mapped series is a REPOINT, and
     *     a silent one, so it needs the same scope it would through any other
     *     door.
     *   - closing the queue row additionally needs `untracked:write`. Without
     *     it the mapping is still written and the answer says the row was left
     *     alone; that is honest, and the mapping is the part that unblocks
     *     uploads.
     *   - a link that resolves to no id at all is a 409 naming what it did
     *     work out, because "comikey, but I cannot tell which series" is a
     *     useful answer an operator can finish by hand.
     */
    scope.post(
      "/api/v1/admin/source/map",
      { preHandler: requireScope("tracked:append") },
      async (req, reply) => {
        const body = parseOrThrow(
          z
            .object({
              url: z.string().trim().min(1).max(2048),
              mdMangaId: MdTitleId,
              /** Report what it would do and write nothing. */
              dryRun: z.boolean().default(false),
              /** Override the resolver, for a link it cannot read on its own. */
              extension: z.string().max(64).optional(),
              mangaId: z.string().min(1).max(512).optional(),
              namespace: z.string().max(MAX_NAMESPACE_LENGTH).optional(),
            })
            .strict(),
          req.body ?? {},
        );

        const resolution = await resolveSourceUrl(sourceLinkDeps(), body.url);
        const extension = body.extension ?? resolution.match?.extension ?? null;
        const mangaId = body.mangaId ?? resolution.match?.mangaId ?? null;
        if (!extension || !mangaId) {
          return reply.code(409).send({
            error:
              resolution.reason ??
              (extension
                ? `that link is ${extension}, but nothing here says which of its series; ` +
                  "pass mangaId as well"
                : "could not tell which extension that link belongs to"),
            resolution,
          });
        }
        if (!EXTENSION_NAME_RE.test(extension)) return reply.code(400).send({ error: "bad extension name" });
        const namespace = normaliseNamespace(body.namespace ?? resolution.match?.namespace ?? undefined);
        if (namespace !== DEFAULT_NAMESPACE && !NAMESPACE_RE.test(namespace)) {
          return reply.code(400).send({ error: `namespace must match ${String(NAMESPACE_RE)}` });
        }

        const identity = { extension, namespace, mangaId };
        const existing = await ctx.prisma.trackedManga.findUnique({
          where: { extension_namespace_mangaId: identity },
        });
        if (existing && existing.mdMangaId === body.mdMangaId) {
          return {
            ok: true,
            changed: false,
            outcome: "unchanged" as const,
            ...identity,
            mdMangaId: body.mdMangaId,
            resolution,
          };
        }
        if (existing && !hasScope(req.principal!, "tracked:write")) {
          return reply.code(403).send({
            error:
              `${mangaId} is already mapped to ${existing.mdMangaId}; changing an existing ` +
              "mapping needs scope tracked:write",
            resolution,
          });
        }

        // The queue row is what makes this more than a tracked-map write: it
        // carries the state the untracked pipeline reads, and a row left NEW
        // behind a mapping is a series that gets offered for creation again.
        //
        // Only the row for the series actually being mapped, though. An
        // override says the resolver got it wrong, and the row it found belongs
        // to whatever it resolved: closing that one would mark some OTHER
        // series TRACKED against a title nothing mapped it to, and leave it out
        // of the queue for good.
        const resolvedIdentity =
          resolution.match?.extension === extension && resolution.match?.mangaId === mangaId;
        const row = resolvedIdentity ? (resolution.match?.untracked ?? null) : null;
        const closable = row !== null && row.state !== "CREATING";
        const mayCloseRow = hasScope(req.principal!, "untracked:write");

        if (body.dryRun) {
          return {
            ok: true,
            dryRun: true,
            changed: true,
            outcome: existing ? ("repointed" as const) : ("added" as const),
            ...identity,
            mdMangaId: body.mdMangaId,
            previousMdMangaId: existing?.mdMangaId ?? null,
            untrackedRow: closable && mayCloseRow ? row!.id : null,
            resolution,
          };
        }

        // Through the title service where there is a row, because that is the
        // path that checks the title exists on MangaDex before wiring uploads
        // to it, and that keeps the row's state and this write in one place.
        let mangadexChecked = false;
        if (closable && mayCloseRow && ctx.titleService && namespace === DEFAULT_NAMESPACE && !existing) {
          const mapped = await ctx.titleService.mapToExisting(row!.id, body.mdMangaId, actor(req));
          if (!mapped.ok) return reply.code(409).send({ error: mapped.error, resolution });
          mangadexChecked = true;
        } else {
          if (ctx.titleService) {
            // Same check the row path gets for free: a title id MangaDex does
            // not know wires uploads to nothing.
            const title = await ctx.titleService.titleById(body.mdMangaId);
            if (!title) {
              return reply.code(409).send({
                error: `MangaDex has no title ${body.mdMangaId}; it may be deleted, merged, or a typo`,
                resolution,
              });
            }
            mangadexChecked = true;
          }
          await ctx.prisma.trackedManga.upsert({
            where: { extension_namespace_mangaId: identity },
            create: { ...identity, mdMangaId: body.mdMangaId, source: actor(req) },
            update: { mdMangaId: body.mdMangaId, source: actor(req) },
          });
          if (closable && mayCloseRow) {
            await ctx.prisma.untrackedManga.update({
              where: { id: row!.id },
              data: { state: "TRACKED", mdMangaId: body.mdMangaId },
            });
          }
        }

        await ctx.audit.record(actor(req), "tracked_manga.set", trackedSubject(extension, namespace, mangaId), {
          mangaId,
          mdMangaId: body.mdMangaId,
          namespace,
          via: resolution.match?.via ?? "manual",
          sourceUrl: resolution.normalised,
          repointedFrom: existing?.mdMangaId ?? null,
        });

        return {
          ok: true,
          changed: true,
          outcome: existing ? ("repointed" as const) : ("added" as const),
          ...identity,
          mdMangaId: body.mdMangaId,
          previousMdMangaId: existing?.mdMangaId ?? null,
          mangadexChecked,
          untrackedRow: closable ? (mayCloseRow ? row!.id : null) : null,
          untrackedNote:
            closable && !mayCloseRow
              ? "the queue row for this series was left as it is: closing it needs untracked:write"
              : undefined,
          resolution,
        };
      },
    );

    /**
     * Map a whole paste of them at once.
     *
     * WHY IT IS ITS OWN ROUTE. A backlog is not mapped one series at a time.
     * Someone works through a publisher's new-releases page with twenty tabs
     * open, and doing that through the single-link route means twenty requests,
     * twenty confirmations, and no way to see what the twenty would do before
     * any of them happens. The single route stays for the one-off; this one is
     * for the backlog, and it is a preview-then-apply exactly like the tracked
     * map's own paste box, for the same reason: a paste of twenty can add,
     * repoint, no-op and fail in the same batch.
     *
     * Reuses the pieces that already decide these things rather than deciding
     * them again: `parseSourceMapLines` for the paste, one shared resolver for
     * the links, `existingTitles` for one MangaDex round trip instead of N, and
     * `trackedManga.applyBatch` for the write and the per-row outcomes — so a
     * row's verdict here means exactly what the same verdict means there.
     */
    scope.post(
      "/api/v1/admin/source/map/batch",
      { preHandler: requireScope("tracked:append") },
      async (req, reply) => {
        const body = parseOrThrow(
          z
            .object({
              /** Pasted `<publisher link> <mangadex link>` lines. */
              text: z.string().max(512 * 1024).optional(),
              /** The same thing pre-split, for a caller that has structure already. */
              pairs: z
                .array(
                  z.object({
                    sourceUrl: z.string().min(1).max(2048),
                    mdMangaId: z.string().min(1).max(2048),
                  }),
                )
                .max(MAX_SOURCE_BATCH)
                .optional(),
              dryRun: z.boolean().default(false),
            })
            .strict(),
          req.body ?? {},
        );

        const parsed = body.text ? parseSourceMapLines(body.text) : { rows: [], errors: [] };
        const fromPairs: SourceMapLine[] = [];
        const parseErrors = [...parsed.errors];
        (body.pairs ?? []).forEach((pair, index) => {
          const title = parseMdTitleId(pair.mdMangaId);
          if ("error" in title) {
            parseErrors.push({ line: index + 1, text: pair.mdMangaId, reason: title.error });
            return;
          }
          fromPairs.push({ line: index + 1, sourceUrl: pair.sourceUrl, mdMangaId: title.id });
        });
        const rows = [...parsed.rows, ...fromPairs];
        if (rows.length === 0 && parseErrors.length === 0) {
          return reply.code(400).send({ error: "nothing to do: provide text or pairs" });
        }
        if (rows.length > MAX_SOURCE_BATCH) {
          return reply
            .code(413)
            .send({ error: `at most ${MAX_SOURCE_BATCH} links per batch; each one is resolved separately` });
        }

        // One resolver for the whole paste: the manifests and each extension's
        // id rule are the same for every row, and re-deriving them per row is
        // most of what a batch would otherwise cost.
        const resolver = createSourceResolver(sourceLinkDeps());
        const resolved = [];
        for (const row of rows) {
          resolved.push({ row, resolution: await resolver.resolve(row.sourceUrl) });
        }

        /** Rows that named a series, and rows that could not. */
        const placed = resolved.filter((r) => r.resolution.match?.mangaId);
        const results: Record<string, unknown>[] = resolved
          .filter((r) => !r.resolution.match?.mangaId)
          .map((r) => ({
            line: r.row.line,
            sourceUrl: r.row.sourceUrl,
            mdMangaId: r.row.mdMangaId,
            extension: r.resolution.match?.extension ?? null,
            outcome: "unresolved" as const,
            detail:
              r.resolution.reason ??
              (r.resolution.match
                ? `${r.resolution.match.extension} is the extension, but nothing here says which series`
                : "could not tell which extension that link belongs to"),
          }));

        // One MangaDex round trip for the whole paste rather than one per row.
        // Skipped entirely where the instance holds no credential: refusing a
        // batch because we cannot check is worse than mapping it unchecked, and
        // the single-link route makes the same call.
        let missingTitles = new Set<string>();
        if (ctx.titleService && placed.length > 0) {
          const known = await ctx.titleService.existingTitles(placed.map((r) => r.row.mdMangaId));
          missingTitles = new Set(placed.map((r) => r.row.mdMangaId).filter((id) => !known.has(id)));
        }

        const writable = placed.filter((r) => !missingTitles.has(r.row.mdMangaId));
        for (const r of placed) {
          if (!missingTitles.has(r.row.mdMangaId)) continue;
          results.push({
            line: r.row.line,
            sourceUrl: r.row.sourceUrl,
            mdMangaId: r.row.mdMangaId,
            extension: r.resolution.match!.extension,
            mangaId: r.resolution.match!.mangaId,
            outcome: "invalid" as const,
            detail: `MangaDex has no title ${r.row.mdMangaId}; it may be deleted, merged, or a typo`,
          });
        }

        // Grouped because the store's batch is per-extension, and a paste off a
        // publisher's page can still span two of them (a site one extension
        // covers in English and another in Spanish).
        const byExtension = new Map<string, typeof writable>();
        for (const r of writable) {
          const list = byExtension.get(r.resolution.match!.extension) ?? [];
          list.push(r);
          byExtension.set(r.resolution.match!.extension, list);
        }

        const canWrite = hasScope(req.principal!, "tracked:write");
        const mayCloseRows = hasScope(req.principal!, "untracked:write");
        const summary = { added: 0, updated: 0, unchanged: 0, failed: 0 };
        /** Queue rows to close, collected while merging outcomes back. */
        const closable: string[] = [];

        for (const [extension, group] of byExtension) {
          const batch = await ctx.trackedManga.applyBatch(
            extension,
            {
              set: group.map((r) => ({
                mangaId: r.resolution.match!.mangaId!,
                mdMangaId: r.row.mdMangaId,
                namespace: r.resolution.match!.namespace ?? undefined,
              })),
            },
            { canWrite, source: actor(req), dryRun: body.dryRun },
          );
          summary.added += batch.added;
          summary.updated += batch.updated;
          summary.unchanged += batch.unchanged;
          summary.failed += batch.failed;

          // Outcomes come back per (namespace, mangaId), which is what a row
          // resolved to; matching on that is what lets two pasted lines for the
          // same series both be told what happened.
          for (const r of group) {
            const match = r.resolution.match!;
            const outcome = batch.results.find(
              (result) =>
                result.mangaId === match.mangaId && (result.namespace ?? "") === (match.namespace ?? ""),
            );
            if (
              !body.dryRun &&
              mayCloseRows &&
              match.untracked &&
              match.untracked.state !== "CREATING" &&
              (outcome?.outcome === "added" || outcome?.outcome === "updated")
            ) {
              closable.push(match.untracked.id);
            }
            results.push({
              line: r.row.line,
              sourceUrl: r.row.sourceUrl,
              extension,
              namespace: match.namespace ?? "",
              mangaId: match.mangaId,
              mdMangaId: r.row.mdMangaId,
              via: match.via,
              queued: match.untracked ? match.untracked.mangaName : null,
              outcome: outcome?.outcome ?? "invalid",
              detail: outcome?.detail,
            });
          }
        }

        // A row left NEW behind a mapping is a series that gets offered for
        // creation again, so closing them is part of the write, not a nicety.
        if (closable.length > 0) {
          await ctx.prisma.untrackedManga.updateMany({
            where: { id: { in: closable } },
            data: { state: "TRACKED" },
          });
        }

        if (!body.dryRun && summary.added + summary.updated > 0) {
          await ctx.audit.record(actor(req), "tracked_manga.batch", "source-links", {
            added: summary.added,
            updated: summary.updated,
            unchanged: summary.unchanged,
            failed: summary.failed,
            rows: rows.length,
            closedQueueRows: closable.length,
          });
        }

        results.sort((a, b) => Number(a.line ?? 0) - Number(b.line ?? 0));
        return {
          dryRun: body.dryRun,
          parseErrors,
          ...summary,
          // Counted apart from `failed`, which is the store's word for a row it
          // refused; these never reached it.
          unresolved: results.filter((r) => r.outcome === "unresolved").length,
          closedQueueRows: closable.length,
          untrackedNote:
            !body.dryRun && !mayCloseRows && writable.some((r) => r.resolution.match?.untracked)
              ? "queue rows for these series were left as they are: closing them needs untracked:write"
              : undefined,
          results,
        };
      },
    );

    /**
     * One MangaDex title, by id or by the link it came in.
     *
     * The paste path's counterpart to the search: an operator who already has
     * the title open pastes its link instead of searching for it again, and
     * this is what lets the name be shown before the mapping is written. Same
     * scope and same live-read reasoning as the search above.
     */
    scope.get("/api/v1/admin/mangadex/title/:id", { preHandler: requireScope("untracked:read") }, async (req, reply) => {
      if (!ctx.titleService) {
        return reply.code(503).send({ error: "title service not available on this instance" });
      }
      const { id } = parseOrThrow(z.object({ id: MdTitleId }), req.params);
      const query = parseOrThrow(
        z.object({ reportedName: z.string().trim().max(512).optional() }),
        req.query ?? {},
      );
      const title = await ctx.titleService.titleById(id, query.reportedName);
      if (!title) {
        return reply.code(404).send({ error: `MangaDex has no title ${id}; it may be deleted, merged, or a typo` });
      }
      return { title };
    });

    /**
     * Run the official-English-link auto-map over the queue on demand.
     *
     * The scheduler already does a batch a tick, but a backlog built up before
     * this existed drains at that rate for a long time, and an operator wants
     * to see what it would do before it does it. `dryRun` is the default for
     * exactly that reason: this writes to the series map, and the map decides
     * where chapters get uploaded.
     */
    scope.post(
      "/api/v1/admin/untracked/automap",
      { preHandler: [requireScope("untracked:write"), requireScope("tracked:append")] },
      async (req, reply) => {
        if (!ctx.titleService) {
          return reply.code(503).send({ error: "title service not available on this instance" });
        }
        const body = z
          .object({
            dryRun: z.boolean().default(true),
            limit: z.number().int().min(1).max(200).default(25),
            extension: z.string().max(64).optional(),
            /**
             * Which evidence to map on. `link` is the default because it is
             * what this endpoint has always done and the stronger of the two:
             * MangaDex recording this exact page as a title's official English
             * release. `title` reaches the rest of the queue, where the entry
             * carries no link but holds the publisher's name verbatim.
             */
            strategy: z.enum(["link", "title"]).default("link"),
          })
          .strict()
          .parse(req.body ?? {});

        const report =
          body.strategy === "title"
            ? await ctx.titleService.autoMapByTitle(body)
            : await ctx.titleService.autoMapByOfficialLink(body);
        if (!body.dryRun && report.mapped.length > 0) {
          await ctx.audit.record(actor(req), "untracked.automap", body.extension ?? "all", {
            strategy: body.strategy,
            mapped: report.mapped.length,
            ambiguous: report.ambiguous,
            considered: report.considered,
          });
        }
        return {
          ok: true,
          dryRun: body.dryRun,
          strategy: body.strategy,
          considered: report.considered,
          ambiguous: report.ambiguous,
          unmatched: report.unmatched,
          remaining: report.remaining,
          mapped: report.mapped.map(({ row, mdMangaId, via }) => ({
            id: row.id,
            extension: row.extension,
            mangaName: row.mangaName,
            mangaUrl: row.mangaUrl,
            mdMangaId,
            // Which evidence this rested on. The three link places and the name
            // pass are not equally strong, and an operator reviewing a preview
            // is deciding exactly that.
            via,
            titleUrl: `https://mangadex.org/title/${mdMangaId}`,
          })),
        };
      },
    );

    /**
     * Map an untracked series onto an existing MangaDex title: the "this is
     * already on MangaDex" answer to the approve button's "create it".
     *
     * Needs untracked:write like the other queue actions, and tracked:append
     * because it does write the series map — the whole point of the action.
     */
    scope.post(
      "/api/v1/admin/untracked/:id/map",
      { preHandler: [requireScope("untracked:write"), requireScope("tracked:append")] },
      async (req, reply) => {
        const { id } = req.params as { id: string };
        if (!ctx.titleService) {
          return reply.code(503).send({ error: "title service not available on this instance" });
        }
        const body = parseOrThrow(z.object({ mdMangaId: MdTitleId }).strict(), req.body ?? {});
        const result = await ctx.titleService.mapToExisting(id, body.mdMangaId, actor(req));
        if (!result.ok) return reply.code(409).send({ error: result.error });
        return { ok: true, mdMangaId: result.mdMangaId };
      },
    );

    scope.post("/api/v1/admin/untracked/:id/approve", { preHandler: requireScope("untracked:write") }, async (req, reply) => {
      const { id } = req.params as { id: string };

      /*
       * A stale queue row is how a duplicate title gets made.
       *
       * The row says NEW because nothing updated it when the series was mapped
       * by another route — a hand-written map entry, a batch paste, the
       * auto-map. Approving it then creates a second MangaDex title for a
       * series that already has one, and un-duplicating a catalogue afterwards
       * means deleting chapters off a live title. The map is the authority, so
       * it is asked here rather than trusted to have kept the row in step.
       *
       * The check is on this extension's own identity: another publisher's
       * mapping onto the same MangaDex title is a legitimate second source, not
       * a duplicate, and must not block anything.
       */
      const row = await ctx.prisma.untrackedManga.findUnique({
        where: { id },
        select: { extension: true, mangaId: true },
      });
      if (row) {
        const mapped = await ctx.prisma.trackedManga.findUnique({
          where: {
            extension_namespace_mangaId: {
              extension: row.extension,
              namespace: DEFAULT_NAMESPACE,
              mangaId: row.mangaId,
            },
          },
          select: { mdMangaId: true },
        });
        if (mapped) {
          return reply.code(409).send({
            error:
              `${row.extension}:${row.mangaId} is already mapped to ${mapped.mdMangaId}; ` +
              "creating a title for it would make a duplicate. This queue row is out of date " +
              "with the series map — skip it, or map it onto that same title to close it.",
            mdMangaId: mapped.mdMangaId,
          });
        }
      }

      // After the duplicate check, deliberately: refusing to make a second
      // title for a series that already has one needs no MangaDex credential,
      // and "this instance holds none" is the less useful of the two answers.
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
     * Skip a batch of them.
     *
     * The single-row route is what the queue offered, and the queue is
     * thousands of rows deep: parking a publisher's back catalogue meant one
     * request per series, each with its own confirmation, and a 409 in the
     * middle left the operator to work out which half had gone through.
     *
     * Reports rather than refuses. A batch of fifty picked off a listing will
     * routinely contain a row somebody else already skipped, or one that has
     * since been mapped, and failing the whole batch over it would make the
     * button useless exactly when it is worth having; so the answer names what
     * it left alone and why, and the skippable rows are skipped either way.
     */
    scope.post("/api/v1/admin/untracked/skip", { preHandler: requireScope("untracked:write") }, async (req) => {
      const body = parseOrThrow(
        z.object({ ids: z.array(z.string().uuid()).min(1).max(500) }).strict(),
        req.body ?? {},
      );

      const rows = await ctx.prisma.untrackedManga.findMany({
        where: { id: { in: body.ids } },
        select: { id: true, state: true, mangaName: true },
      });
      const found = new Set(rows.map((row) => row.id));
      const skippable = rows.filter((row) => row.state === "NEW" || row.state === "FAILED");

      const skipped = skippable.length
        ? await ctx.prisma.untrackedManga.updateMany({
            where: { id: { in: skippable.map((row) => row.id) }, state: { in: ["NEW", "FAILED"] } },
            data: { state: "SKIPPED" },
          })
        : { count: 0 };

      if (skipped.count > 0) {
        await ctx.audit.record(actor(req), "untracked.skip", `${skipped.count} series`, {
          ids: skippable.map((row) => row.id),
        });
      }

      return {
        ok: true,
        skipped: skipped.count,
        // Both kinds of "not this one", kept apart: a row in the wrong state is
        // a fact about the queue, an id that matched nothing is a fact about
        // the request, and rolling them into one number hides which happened.
        unchanged: rows
          .filter((row) => row.state !== "NEW" && row.state !== "FAILED")
          .map((row) => ({ id: row.id, mangaName: row.mangaName, state: row.state })),
        missing: body.ids.filter((id) => !found.has(id)),
      };
    });

    /**
     * Put skipped series back in the queue.
     *
     * Skipping was a one-way door: `approve` refuses anything that is not NEW
     * or FAILED, the CLI's `--state` only filters a listing, and nothing else
     * writes the column. A series parked by mistake — or one skipped while its
     * publisher was misbehaving, which is the common case — could only be
     * recovered by editing the database by hand.
     *
     * Rows whose series is ALREADY TRACKED are reported rather than reset. A
     * skipped row goes stale the moment someone maps that series manually, and
     * moving it back to NEW would have the title service create a second
     * MangaDex entry for a series that already has one. That has already
     * happened once here by a different route, and cleaning it up meant
     * deleting chapters off a live title.
     */
    scope.post("/api/v1/admin/untracked/unskip", { preHandler: requireScope("untracked:write") }, async (req) => {
      const body = z
        .object({
          ids: z.array(z.string().uuid()).max(500).optional(),
          extension: z.string().max(64).optional(),
          dryRun: z.boolean().default(true),
        })
        .strict()
        .parse(req.body ?? {});

      const candidates = await ctx.prisma.untrackedManga.findMany({
        where: {
          state: "SKIPPED",
          ...(body.ids ? { id: { in: body.ids } } : {}),
          ...(body.extension ? { extension: body.extension } : {}),
        },
      });

      // One query rather than per row: the tracked map is the authority on
      // whether a series already has a MangaDex title, and it is what makes
      // "already tracked" answerable without asking MangaDex.
      const tracked = await ctx.prisma.trackedManga.findMany({
        where: { mangaId: { in: candidates.map((row) => row.mangaId) } },
        select: { extension: true, mangaId: true, mdMangaId: true },
      });
      const trackedBy = new Map(tracked.map((row) => [`${row.extension}:${row.mangaId}`, row.mdMangaId]));

      const requeue: typeof candidates = [];
      const alreadyTracked: { id: string; mangaId: string; mangaName: string; mdMangaId: string }[] = [];
      for (const row of candidates) {
        const mdMangaId = trackedBy.get(`${row.extension}:${row.mangaId}`);
        if (mdMangaId) {
          alreadyTracked.push({
            id: row.id,
            mangaId: row.mangaId,
            mangaName: row.mangaName,
            mdMangaId,
          });
        } else {
          requeue.push(row);
        }
      }

      const summary = {
        matched: candidates.length,
        requeued: requeue.length,
        alreadyTracked,
        series: requeue.map((row) => ({
          id: row.id,
          extension: row.extension,
          mangaId: row.mangaId,
          mangaName: row.mangaName,
          mangaLanguage: row.mangaLanguage,
        })),
      };

      if (body.dryRun) {
        return {
          ok: true,
          dryRun: true,
          ...summary,
          note: "nothing was changed. Repeat with {dryRun: false} to move these back to NEW",
        };
      }

      // Back to NEW with a fresh budget: a row skipped after a failure kept its
      // attempt count, and re-queueing it with the budget already spent would
      // fail it again on the first try.
      const updated = await ctx.prisma.untrackedManga.updateMany({
        where: { id: { in: requeue.map((row) => row.id) }, state: "SKIPPED" },
        data: { state: "NEW", attempts: 0, lastError: null },
      });
      await ctx.audit.recordMany(
        requeue.map((row) => ({
          actor: actor(req),
          action: "untracked.unskip",
          subject: row.id,
          detail: { extension: row.extension, mangaId: row.mangaId, mangaName: row.mangaName },
        })),
      );
      return { ok: true, dryRun: false, ...summary, updated: updated.count };
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
