import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Prisma, type UploadTaskKind, type UploadTaskState } from "@prisma/client";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { adminAuthHook, requireScope } from "../auth.js";
import { sessionAuthenticator, impersonationResolver} from "../session.js";
import { chapterFromJson, chapterToTaskPayload, CHAPTER_JSON_KEYS } from "../../md/chapterRows.js";
import {
  BULK_CAP,
  PURGE_CAP,
  REMOVABLE_STATES,
  RETRYABLE_STATES,
  UPLOAD_TASK_KINDS,
  UPLOAD_TASK_STATES,
  decodeTaskCursor,
  TASK_SORTS,
  taskDedupeKey,
  type ReorderMode,
  type UploadTaskFilter,
  type UploadTaskStateRow,
  type TaskSort,
} from "../../store/uploadTasks.js";

/**
 * Operator control of the four MangaDex upload queues: list, retry, remove,
 * purge, reprioritise, hand-enqueue and correct. routes/ops.ts keeps the
 * incident-triage subset; see docs/operations.md §"Queue management".
 *
 * Three invariants run through every handler:
 *
 *  1. LEASED rows are untouchable. A lease means an uploader is mid-flight
 *     against MangaDex, and forcing the row would race it into a duplicate
 *     upload or a lost result. Every mutating statement's WHERE clause excludes
 *     LEASED by naming the states it accepts, so this holds by construction.
 *  2. No read-then-write. Each mutation is one guarded statement (or one
 *     transaction) whose WHERE names the expected prior state, like
 *     store/jobs.ts. A row that moved produces a refusal naming its current
 *     state, never a clobber.
 *  3. Destruction is explicit. Deletes need `confirm: true`; a purge needs
 *     `dryRun: false` as well; and deleting a DONE row needs
 *     `includeCompleted: true` on top of both.
 */

/** Every mutating handler answers with one of these per requested row. */
type Outcome =
  | "retried"
  | "removed"
  | "reordered"
  | "not_found"
  | "leased"
  | "wrong_state"
  | "lost_race";

interface ItemResult {
  id: string;
  ok: boolean;
  outcome: Outcome;
  /** Current state, when the row still exists. */
  state?: string | null;
  leaseId?: string | null;
  leaseExpiresAt?: Date | null;
  reason?: string;
}

/** Cap on a hand-written chapter payload. Real ones are a few hundred bytes. */
const MAX_CHAPTER_BYTES = 128 * 1024;

/** Rows shown alongside a purge dry-run so the operator recognises the set. */
const PURGE_SAMPLE = 20;

/**
 * Validate, answering 400 instead of 500. Same helper as routes/ops.ts,
 * duplicated because that module does not export it.
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

/** `?kind=UPLOAD&kind=EDIT` and `"kind": "UPLOAD"` both mean a one-or-more set. */
function oneOrMany<T extends readonly [string, ...string[]]>(values: T) {
  return z
    .union([z.enum(values), z.array(z.enum(values)).min(1)])
    .transform((value) => (Array.isArray(value) ? [...new Set(value)] : [value]));
}

const KindFilter = oneOrMany(UPLOAD_TASK_KINDS);
const StateFilter = oneOrMany(UPLOAD_TASK_STATES);

/**
 * A boolean that may arrive as a query-string word. Not `z.coerce.boolean()`,
 * which is `Boolean(value)`, so the string "false" coerces to true.
 */
const Flag = z.preprocess(
  (value) => (typeof value === "string" ? value === "true" || value === "1" : value),
  z.boolean(),
);

const FilterShape = {
  kind: KindFilter.optional(),
  state: StateFilter.optional(),
  /** Case-insensitive substring; a `%` is a wildcard the operator meant. */
  dedupeKey: z.string().min(1).max(256).optional(),
  attemptMin: z.coerce.number().int().min(0).max(1000).optional(),
  attemptMax: z.coerce.number().int().min(0).max(1000).optional(),
  // Predicates over the queued chapter payload rather than a column. Because
  // they live in `FilterShape` they narrow the bulk verbs (retry / remove /
  // purge / reorder) exactly as they narrow the list, and they are the same
  // three names `/queues/chapters` takes.
  extension: z.string().min(1).max(128).optional(),
  language: z.string().min(1).max(32).optional(),
  /** Case-insensitive substring over series, title, number, or either MD id. */
  q: z.string().min(1).max(256).optional(),
};

const FilterSchema = z.object(FilterShape);

function toFilter(query: z.infer<typeof FilterSchema>): UploadTaskFilter {
  return {
    kinds: query.kind,
    states: query.state,
    dedupeKey: query.dedupeKey,
    attemptMin: query.attemptMin,
    attemptMax: query.attemptMax,
    extension: query.extension,
    language: query.language,
    q: query.q,
  };
}

/**
 * The states a filter-driven bulk action may actually select. A filter names a
 * set, so intersecting it with what the operation can legally touch is the
 * correct reading of intent: "retry the failed UPLOADs" is what
 * `{filter: {kind: "UPLOAD"}}` means on the retry endpoint. An explicit
 * `{ids: […]}` is never narrowed, since there the operator named a row and
 * deserves to be told why it was refused.
 */
function narrowStates(
  requested: readonly UploadTaskState[] | undefined,
  allowed: readonly UploadTaskState[],
): UploadTaskState[] {
  const base = requested && requested.length > 0 ? requested : UPLOAD_TASK_STATES;
  return base.filter((state) => allowed.includes(state));
}

/** Chapter payload for a hand-built task: every canonical key, plus sidecars. */
const ChapterPayload = z
  .object({
    ...Object.fromEntries(
      CHAPTER_JSON_KEYS.map((key) => [key, z.string().max(4096).nullish()]),
    ),
    imageArtifacts: z.array(z.string().uuid()).max(1000).optional(),
  })
  // EDIT rows carry `payload`/`oldInfo` and UNAVAILABLE rows carry
  // `unavailableAt` beside the chapter fields; taskWorkers reads those directly,
  // so stripping unknown keys would make a hand-built EDIT unexecutable.
  .passthrough();

/**
 * What would stop `taskWorkers.execute` from running this task at all. Exported
 * and pure so the rules can be unit-tested against the worker they mirror: each
 * message corresponds to a `TaskError` that would otherwise be discovered after
 * the task was queued and claimed, and for UPLOAD after a MangaDex upload
 * session was already open.
 */
export function manualTaskProblems(
  kind: UploadTaskKind,
  payload: Record<string, unknown>,
): string[] {
  const chapter = chapterFromJson(payload);
  const problems: string[] = [];

  if (kind === "UPLOAD") {
    if (!chapter.mdMangaId) problems.push("chapter.mdMangaId is required for an UPLOAD task");
    if (!chapter.mdGroupId) problems.push("chapter.mdGroupId is required for an UPLOAD task");
    // MangaDex rejects a commit with an empty translatedLanguage, and the
    // uploader passes this field straight through.
    if (!chapter.chapterLanguage) {
      problems.push("chapter.chapterLanguage is required for an UPLOAD task");
    }
    if (taskDedupeKey(kind, chapter) === null) {
      problems.push(
        "an UPLOAD task needs at least one of chapter.chapterId, chapter.chapterNumber or " +
          "chapter.chapterLanguage: the three of them are its dedupe key",
      );
    }
  } else if (!chapter.mdChapterId) {
    problems.push(`chapter.mdChapterId is required for a ${kind} task (it is the dedupe key)`);
  }

  if (kind === "EDIT") {
    const edit = payload["payload"];
    const isObject = typeof edit === "object" && edit !== null && !Array.isArray(edit);
    if (!isObject || Object.keys(edit as Record<string, unknown>).length === 0) {
      problems.push(
        "an EDIT task needs a non-empty `payload` object: the fields to change on the " +
          "MangaDex chapter (volume, chapter, title, translatedLanguage, groups)",
      );
    }
  }

  return problems;
}

/**
 * Second-stage guard for hand-enqueueing a task, which can put a real MangaDex
 * upload in front of the uploader. `runs:write` alone is not the right bar since
 * the Discord bot holds scopes in that family, so this sits at ADMIN-or-above by
 * role.
 */
async function requireAdminRole(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.adminRole !== "OWNER" && req.adminRole !== "ADMIN") {
    await reply.code(403).send({
      error: `admin role or above required; this credential is ${req.adminRole ?? "unauthenticated"}`,
    });
  }
}

/** HTTP status for a single-row outcome, so one code path serves both shapes. */
function statusFor(outcome: Outcome): number {
  if (outcome === "not_found") return 404;
  return outcome === "leased" || outcome === "wrong_state" || outcome === "lost_race" ? 409 : 200;
}

export function registerQueueRoutes(app: FastifyInstance, ctx: AppContext): void {
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

    /** Same attribution rules as routes/admin.ts and routes/ops.ts. */
    const actor = (req: FastifyRequest): string => {
      const claimed = (req.headers["x-actor"] as string | undefined)?.slice(0, 64);
      const principal = req.principal;
      if (principal?.kind === "api-token") {
        return claimed ? `${principal.name} for ${claimed}` : principal.name;
      }
      if (principal?.kind === "session") return principal.name;
      return `admin:${claimed ?? "root"}`;
    };

    /**
     * Turn "these ids were asked for, these changed" into one result per
     * requested id. The state lookup happens only for ids the guarded statement
     * did not change, and only to explain the refusal.
     */
    async function explain(
      ids: readonly string[],
      changed: readonly string[],
      success: Outcome,
      allowed: readonly string[],
    ): Promise<ItemResult[]> {
      const changedSet = new Set(changed);
      const unchanged = ids.filter((id) => !changedSet.has(id));
      const states = await ctx.uploadTasks.statesOf(unchanged);
      return ids.map((id) => {
        if (changedSet.has(id)) return { id, ok: true, outcome: success };
        const row: UploadTaskStateRow | undefined = states.get(id);
        if (!row) return { id, ok: false, outcome: "not_found", reason: "no such upload task" };
        if (row.state === "LEASED") {
          return {
            id,
            ok: false,
            outcome: "leased",
            state: row.state,
            leaseId: row.leaseId,
            leaseExpiresAt: row.leaseExpiresAt,
            reason:
              `an uploader holds lease ${row.leaseId ?? "(unknown)"} on this task until ` +
              `${row.leaseExpiresAt?.toISOString() ?? "an unknown time"}; wait for it to expire ` +
              `(POST /api/v1/admin/upload-tasks/requeue-stale reclaims expired ones) rather than racing it`,
          };
        }
        return {
          id,
          ok: false,
          outcome: "wrong_state",
          state: row.state,
          reason: `task is ${row.state}; this operation accepts ${allowed.join(" or ")}`,
        };
      });
    }

    const taskIdParam = z.object({ id: z.string().uuid() });

    // ---- read ----

    /**
     * Depth per kind and state, on its own. The list endpoint returns the same
     * summary, but the Overview panel should not pay for a page of rows to get it.
     */
    scope.get("/api/v1/admin/queues", { preHandler: requireScope("runs:read") }, async () => {
      const summary = await ctx.uploadTasks.depths();
      return {
        summary,
        total: summary.reduce((sum, row) => sum + row.count, 0),
        kinds: UPLOAD_TASK_KINDS,
        states: UPLOAD_TASK_STATES,
      };
    });

    /**
     * The queue in the order it will drain, filtered, with a total and a cursor.
     *
     * Ordering is the claim query's, `not_before` then `created_at` then `id`,
     * so this list is "what runs next", which is what a reorder is checked
     * against. `sort=desc` reverses that same total ordering to put the newest
     * work first, for a reader watching a queue rather than auditing a reorder;
     * `order` in the response always names the ordering actually applied.
     * routes/ops.ts orders the same rows by `updated_at DESC`, which answers
     * "what changed last"; none of the three are interchangeable. The summary is
     * global rather than filtered so a narrow filter cannot hide a queue that is
     * backing up.
     *
     * `chapter` is omitted here; fetch one row for it.
     */
    scope.get("/api/v1/admin/queues/tasks", { preHandler: requireScope("runs:read") }, async (req) => {
      const query = parseOrThrow(
        z
          .object({
            ...FilterShape,
            limit: z.coerce.number().int().min(1).max(500).default(100),
            cursor: z.string().max(512).optional(),
            sort: z.enum(["asc", "desc"]).default("asc"),
            /**
             * Order the whole queue by one column instead of by claim order.
             * Separate from `sort`, which only reverses the claim order: this
             * is what the console's header buttons send, and sorting just the
             * page already fetched would answer a narrower question than the
             * one a header click asks.
             */
            orderBy: z.enum(TASK_SORTS).optional(),
            dir: z.enum(["asc", "desc"]).default("asc"),
          })
          .refine(
            (value) =>
              value.attemptMin === undefined ||
              value.attemptMax === undefined ||
              value.attemptMin <= value.attemptMax,
            { message: "attemptMin must not exceed attemptMax", path: ["attemptMin"] },
          ),
        req.query ?? {},
      );

      // A cursor names a position in one ordering, so only the decoder for the
      // ordering in force can read it; `orderBy` is what says which that is.
      const column = query.orderBy
        ? { name: query.orderBy, dir: query.dir, cursor: query.cursor ?? null }
        : null;
      const cursor = !column && query.cursor ? decodeTaskCursor(query.cursor) : null;
      if (!column && query.cursor && !cursor) {
        throw Object.assign(new Error("invalid cursor: not a cursor this endpoint issued"), {
          statusCode: 400,
        });
      }

      const sort: TaskSort = query.sort;
      const [page, summary] = await Promise.all([
        ctx.uploadTasks.list(toFilter(query), { limit: query.limit, cursor, sort, column }),
        ctx.uploadTasks.depths(),
      ]);

      return {
        tasks: page.tasks,
        total: page.total,
        limit: query.limit,
        nextCursor: page.nextCursor,
        sort,
        orderedBy: column?.name ?? null,
        dir: query.dir,
        sortable: TASK_SORTS,
        // The claim order, and what `POST /queues/reorder` rewrites; reversed
        // when `sort=desc` asked for the newest first. A column sort replaces
        // it outright, and says so.
        order: column
          ? `${column.name},id (${column.dir}ending)`
          : sort === "desc"
            ? "notBefore,createdAt,id DESC"
            : "notBefore,createdAt,id",
        summary,
      };
    });

    /** One row, `chapter` payload included: the detail and edit view. */
    scope.get(
      "/api/v1/admin/queues/tasks/:id",
      { preHandler: requireScope("runs:read") },
      async (req, reply) => {
        const { id } = parseOrThrow(taskIdParam, req.params);
        const task = await ctx.uploadTasks.get(id);
        if (!task) return reply.code(404).send({ error: "unknown upload task" });
        return { task };
      },
    );

    // ---- retry ----

    const RetryBody = z
      .object({
        ids: z.array(z.string().uuid()).min(1).max(BULK_CAP).optional(),
        filter: FilterSchema.optional(),
      })
      .refine((value) => (value.ids ? 1 : 0) + (value.filter ? 1 : 0) === 1, {
        message: "provide exactly one of `ids` or `filter`",
      });

    async function retry(
      ids: readonly string[],
    ): Promise<{ results: ItemResult[]; changed: number }> {
      const changed = await ctx.uploadTasks.retryMany(ids);
      const results = await explain(ids, changed, "retried", RETRYABLE_STATES);
      return { results, changed: changed.length };
    }

    /**
     * Requeue one task the uploader gave up on. Mirrors
     * `POST /admin/upload-tasks/:id/retry` in routes/ops.ts; it exists here so a
     * client can use one base path for every queue verb.
     */
    scope.post(
      "/api/v1/admin/queues/tasks/:id/retry",
      { preHandler: requireScope("runs:write") },
      async (req, reply) => {
        const { id } = parseOrThrow(taskIdParam, req.params);
        const { results } = await retry([id]);
        const result = results[0]!;
        if (!result.ok) return reply.code(statusFor(result.outcome)).send({ error: result.reason, ...result });
        await ctx.audit.record(actor(req), "queue.retry", id);
        return { ...result, ok: true, state: "PENDING" };
      },
    );

    /**
     * Bulk requeue, by id list or by filter. Always 200 with one result per
     * requested id, even when some were refused; `changed` says how many moved.
     * Callers wanting a hard failure on a single row should use the single-id
     * route, which answers 409.
     */
    scope.post("/api/v1/admin/queues/retry", { preHandler: requireScope("runs:write") }, async (req) => {
      const body = parseOrThrow(RetryBody, req.body ?? {});
      let ids: string[];
      let capped = false;
      if (body.ids) {
        ids = body.ids;
      } else {
        const filter = toFilter(body.filter!);
        // Narrowed to the retryable states: see `narrowStates`.
        const resolved = await ctx.uploadTasks.idsMatching(
          { ...filter, states: narrowStates(filter.states, RETRYABLE_STATES) },
          BULK_CAP + 1,
        );
        capped = resolved.length > BULK_CAP;
        ids = resolved.slice(0, BULK_CAP);
      }

      const { results, changed } = await retry(ids);
      await ctx.audit.record(actor(req), "queue.retry.bulk", undefined, {
        requested: ids.length,
        changed,
        capped,
        ...(body.filter ? { filter: body.filter } : { ids }),
      });
      return {
        ok: true,
        requested: ids.length,
        changed,
        refused: results.filter((r) => !r.ok).length,
        capped,
        ...(capped ? { cap: BULK_CAP, note: `more rows matched than the ${BULK_CAP}-row cap; call again` } : {}),
        results,
      };
    });

    // ---- remove ----

    const RemoveBody = z
      .object({
        ids: z.array(z.string().uuid()).min(1).max(BULK_CAP).optional(),
        filter: FilterSchema.optional(),
        confirm: z.literal(true, {
          errorMap: () => ({ message: "deleting queue rows is permanent; pass confirm: true" }),
        }),
        includeCompleted: z.boolean().default(false),
      })
      .refine((value) => (value.ids ? 1 : 0) + (value.filter ? 1 : 0) === 1, {
        message: "provide exactly one of `ids` or `filter`",
      });

    /**
     * A DONE upload task plus its `upload_logs` rows are what make reprocessing
     * idempotent. Deleting the row removes the first of the two, so the next run
     * will enqueue the chapter again, and only the upload-log check stands
     * between that and a duplicate on MangaDex, which exists on the UPLOAD path
     * alone.
     */
    const COMPLETED_WARNING =
      "deleted DONE rows: the unique (kind, dedupe_key) row is the first half of the " +
      "double-upload guard, so the next run may re-enqueue these chapters. For UPLOAD the " +
      "COMMITTED upload_logs entry is the remaining defence (it re-checks MangaDex before " +
      "skipping); for EDIT/DELETE/UNAVAILABLE there is none, and the task will simply run again.";

    async function remove(
      ids: readonly string[],
      includeCompleted: boolean,
    ): Promise<{
      results: ItemResult[];
      deleted: { id: string; kind: string; dedupeKey: string; state: string }[];
    }> {
      const deleted = await ctx.uploadTasks.removeMany(ids, { includeCompleted });
      const allowed = includeCompleted ? [...REMOVABLE_STATES, "DONE"] : [...REMOVABLE_STATES];
      const results = await explain(
        ids,
        deleted.map((row) => row.id),
        "removed",
        allowed,
      );
      return { results, deleted };
    }

    /** Delete one row. `confirm` may travel in the body or the query string. */
    scope.delete(
      "/api/v1/admin/queues/tasks/:id",
      { preHandler: requireScope("runs:write") },
      async (req, reply) => {
        const { id } = parseOrThrow(taskIdParam, req.params);
        const options = parseOrThrow(
          z.object({
            confirm: Flag.optional(),
            includeCompleted: Flag.default(false),
          }),
          { ...(req.query as Record<string, unknown>), ...(req.body as Record<string, unknown>) },
        );
        if (options.confirm !== true) {
          return reply
            .code(400)
            .send({ error: "deleting a queue row is permanent; pass confirm: true" });
        }

        const { results, deleted } = await remove([id], options.includeCompleted);
        const result = results[0]!;
        if (!result.ok) {
          // A DONE row refused for want of the flag needs to say which flag.
          const hint =
            result.state === "DONE" && !options.includeCompleted
              ? { hint: `pass includeCompleted: true to delete a DONE row. ${COMPLETED_WARNING}` }
              : {};
          return reply.code(statusFor(result.outcome)).send({ error: result.reason, ...result, ...hint });
        }

        const row = deleted[0]!;
        await ctx.audit.record(actor(req), "queue.remove", id, {
          kind: row.kind,
          dedupeKey: row.dedupeKey,
          state: row.state,
          includeCompleted: options.includeCompleted,
        });
        return {
          ok: true,
          deleted: row,
          ...(row.state === "DONE" ? { warning: COMPLETED_WARNING } : {}),
        };
      },
    );

    /** Bulk delete, by id list or by filter. Same 200-with-outcomes shape as retry. */
    scope.post("/api/v1/admin/queues/remove", { preHandler: requireScope("runs:write") }, async (req) => {
      const body = parseOrThrow(RemoveBody, req.body ?? {});
      const allowedStates: readonly UploadTaskState[] = body.includeCompleted
        ? [...REMOVABLE_STATES, "DONE"]
        : REMOVABLE_STATES;

      let ids: string[];
      let capped = false;
      if (body.ids) {
        ids = body.ids;
      } else {
        const filter = toFilter(body.filter!);
        const resolved = await ctx.uploadTasks.idsMatching(
          { ...filter, states: narrowStates(filter.states, allowedStates) },
          BULK_CAP + 1,
        );
        capped = resolved.length > BULK_CAP;
        ids = resolved.slice(0, BULK_CAP);
      }

      const { results, deleted } = await remove(ids, body.includeCompleted);
      await ctx.audit.record(actor(req), "queue.remove.bulk", undefined, {
        requested: ids.length,
        deleted: deleted.length,
        includeCompleted: body.includeCompleted,
        capped,
        rows: deleted,
        ...(body.filter ? { filter: body.filter } : {}),
      });
      return {
        ok: true,
        requested: ids.length,
        // Named rather than counted: these rows no longer exist to look up.
        deleted,
        refused: results.filter((r) => !r.ok).length,
        capped,
        ...(capped ? { cap: BULK_CAP, note: `more rows matched than the ${BULK_CAP}-row cap; call again` } : {}),
        ...(deleted.some((row) => row.state === "DONE") ? { warning: COMPLETED_WARNING } : {}),
        results,
      };
    });

    // ---- purge ----

    /**
     * Empty a queue, or a state within one.
     *
     * `dryRun` defaults to true, and that default is the safety property: the
     * first call reports what would go and writes nothing, not even an audit
     * row. Deleting takes `dryRun: false` and `confirm: true`.
     *
     * LEASED rows are never in the set (store/uploadTasks.purge excludes them in
     * the statement) and DONE rows need `includeCompleted: true`. A filter
     * selecting only protected states is a 400 saying so, rather than a cheerful
     * "0 deleted" that hides the reason.
     */
    scope.post("/api/v1/admin/queues/purge", { preHandler: requireScope("runs:write") }, async (req, reply) => {
      const body = parseOrThrow(
        z.object({
          ...FilterShape,
          dryRun: z.boolean().default(true),
          confirm: z.boolean().default(false),
          includeCompleted: z.boolean().default(false),
        }),
        req.body ?? {},
      );

      const filter = toFilter(body);
      const deletable: readonly UploadTaskState[] = body.includeCompleted
        ? [...REMOVABLE_STATES, "DONE"]
        : REMOVABLE_STATES;
      const effective = narrowStates(filter.states, deletable);
      if (effective.length === 0) {
        return reply.code(400).send({
          error:
            `nothing purgeable in ${(filter.states ?? []).join(", ")}: LEASED rows belong to a ` +
            "running uploader and are never purged, and DONE rows need includeCompleted: true",
          purgeableStates: deletable,
        });
      }

      const selected = { ...filter, states: effective };
      const [matched, deletableCount, breakdown] = await Promise.all([
        // Everything the operator's own filter selects, protected rows included,
        // so the difference is visible rather than silently absent.
        ctx.uploadTasks.countMatching(filter),
        ctx.uploadTasks.countMatching(selected),
        ctx.uploadTasks.breakdown(selected),
      ]);

      if (body.dryRun) {
        const sample = await ctx.uploadTasks.list(selected, { limit: PURGE_SAMPLE });
        return {
          dryRun: true,
          matched,
          wouldDelete: Math.min(deletableCount, PURGE_CAP),
          protectedRows: matched - deletableCount,
          capped: deletableCount > PURGE_CAP,
          cap: PURGE_CAP,
          breakdown,
          sample: sample.tasks,
          note:
            "nothing was changed. Repeat with {dryRun: false, confirm: true} to delete " +
            "exactly this set" +
            (deletableCount > PURGE_CAP ? `, ${PURGE_CAP} rows at a time` : ""),
        };
      }

      if (!body.confirm) {
        return reply.code(400).send({
          error: "a live purge needs confirm: true alongside dryRun: false",
          wouldDelete: Math.min(deletableCount, PURGE_CAP),
        });
      }

      const deleted = await ctx.uploadTasks.purge(selected, {
        includeCompleted: body.includeCompleted,
        cap: PURGE_CAP,
      });
      const remaining = await ctx.uploadTasks.countMatching(selected);
      await ctx.audit.record(actor(req), "queue.purge", undefined, {
        // Every filter key, not a hand-listed subset: this record is the only
        // surviving evidence of a purge, and one narrowed by extension or
        // language must not be audited as the wider set it would otherwise be.
        filter: Object.fromEntries(
          Object.keys(FilterShape)
            .map((key) => [key, body[key as keyof typeof body]])
            .filter(([, value]) => value !== undefined),
        ),
        includeCompleted: body.includeCompleted,
        matched,
        deleted: deleted.length,
        remaining,
        // The ids and dedupe keys, because after this statement they are the only
        // record that these rows existed.
        rows: deleted,
      });
      return {
        dryRun: false,
        ok: true,
        deleted: deleted.length,
        remaining,
        capped: remaining > 0,
        cap: PURGE_CAP,
        breakdown,
        rows: deleted,
        ...(deleted.some((row) => row.state === "DONE") ? { warning: COMPLETED_WARNING } : {}),
        ...(remaining > 0
          ? { note: `${remaining} matching rows were left by the ${PURGE_CAP}-row cap; call again` }
          : {}),
      };
    });

    // ---- reorder ----

    /**
     * Change what the uploader picks up next. The queue is ordered by
     * `not_before`, so position is that timestamp and every mode is arithmetic
     * on it. See `UploadTaskStore.reorder` for why there is no priority column.
     *
     *  - `front`    the listed tasks are claimed next, in the order given, and
     *               are due immediately even if the rest of the queue is backing
     *               off into the future.
     *  - `back`     they go behind every other pending row.
     *  - `sequence` they keep their place in the queue but are reordered among
     *               themselves, from the earliest instant the group already had.
     *  - `defer`    each is pushed `deferSeconds` further out, measured from now
     *               for a row that is already due.
     *
     * PENDING only. A FAILED or DEAD_LETTER row is not in the queue at all, so
     * its `not_before` means nothing until it is retried.
     */
    scope.post("/api/v1/admin/queues/reorder", { preHandler: requireScope("runs:write") }, async (req) => {
      const body = parseOrThrow(
        z
          .object({
            ids: z.array(z.string().uuid()).min(1).max(BULK_CAP),
            mode: z.enum(["front", "back", "sequence", "defer"]),
            deferSeconds: z.number().int().min(1).max(30 * 24 * 3600).optional(),
          })
          .refine((value) => value.mode !== "defer" || value.deferSeconds !== undefined, {
            message: "mode 'defer' needs deferSeconds",
            path: ["deferSeconds"],
          })
          // Refused rather than ignored: silently dropping it would answer 200 to
          // a caller who asked for a 60-second push and got a queue jump.
          .refine((value) => value.mode === "defer" || value.deferSeconds === undefined, {
            message: "deferSeconds only applies to mode 'defer'",
            path: ["deferSeconds"],
          }),
        req.body ?? {},
      );

      // De-duplicated, order preserved: the same id twice would be assigned two
      // different instants by the same statement.
      const ids = [...new Set(body.ids)];
      const moved = await ctx.uploadTasks.reorder(ids, body.mode as ReorderMode, body.deferSeconds);
      const results = await explain(
        ids,
        moved.map((row) => row.id),
        "reordered",
        ["PENDING"],
      );

      await ctx.audit.record(actor(req), "queue.reorder", undefined, {
        mode: body.mode,
        deferSeconds: body.deferSeconds ?? null,
        requested: ids.length,
        moved: moved.length,
        ids,
      });
      return {
        ok: true,
        mode: body.mode,
        requested: ids.length,
        moved: moved.length,
        refused: results.filter((r) => !r.ok).length,
        // The resulting instants, in claim order, so a caller can verify the
        // change rather than trust it.
        ordered: [...moved].sort((a, b) => a.notBefore.getTime() - b.notBefore.getTime()),
        results,
      };
    });

    // ---- restagger ----

    /**
     * Re-space the whole pending queue to a fixed rate.
     *
     * Separate from `/reorder` because it is a different shape of operation: no
     * id list, because it acts on the queue rather than on a selection, and no
     * mode, because the only parameter is the gap. `/reorder` cannot do it —
     * every mode there lands the listed rows on one instant, so a bunched queue
     * stays bunched.
     *
     * The case this exists for: a queue that was pulled forward, or planned
     * before the schedule paced anything, is hundreds of rows all due at once,
     * and the uploader drains it back to back. `spacingMinutes` fixes that when
     * work is planned; nothing fixed it for work already queued.
     *
     * `runs:write` and the audit record match `/reorder`: this rewrites when
     * every pending row runs, which is the same authority.
     */
    scope.post("/api/v1/admin/queues/restagger", { preHandler: requireScope("runs:write") }, async (req) => {
      const body = parseOrThrow(
        z
          .object({
            /** Seconds between consecutive uploads. 60 is one a minute. */
            gapSeconds: z.coerce.number().int().min(1).max(24 * 3600),
            kind: z.enum(UPLOAD_TASK_KINDS).default("UPLOAD"),
          })
          .strict(),
        req.body ?? {},
      );

      const moved = await ctx.uploadTasks.restagger(body.gapSeconds, body.kind);
      await ctx.audit.record(actor(req), "queue.restagger", body.kind, {
        gapSeconds: body.gapSeconds,
        moved,
      });
      return {
        ok: true,
        kind: body.kind,
        gapSeconds: body.gapSeconds,
        moved,
        // What the operator actually asked for, echoed as the thing they can
        // check: the last row is `moved - 1` gaps out.
        spansSeconds: moved > 0 ? (moved - 1) * body.gapSeconds : 0,
      };
    });

    // ---- manual add ----

    /**
     * Queue a task by hand. This reaches all the way to MangaDex: an UPLOAD row
     * queued here will create a real chapter under the group in the payload.
     * Hence ADMIN-or-above on top of `runs:write`, the full payload in the audit
     * detail, and validation against what `taskWorkers` requires.
     *
     * The dedupe key is derived by `taskDedupeKey` and the insert is the same ON
     * CONFLICT DO NOTHING, so a duplicate is a 409 naming the existing task: that
     * unique constraint is what makes a double upload impossible.
     */
    scope.post(
      "/api/v1/admin/queues/tasks",
      { preHandler: [requireAdminRole, requireScope("runs:write")] },
      async (req, reply) => {
        const body = parseOrThrow(
          z.object({
            kind: z.enum(UPLOAD_TASK_KINDS),
            chapter: ChapterPayload,
            notBefore: z.coerce.date().optional(),
            maxAttempts: z.number().int().min(1).max(50).optional(),
          }),
          req.body ?? {},
        );

        const kind = body.kind as UploadTaskKind;
        const raw = body.chapter as Record<string, unknown>;
        const artifacts = Array.isArray(raw["imageArtifacts"])
          ? (raw["imageArtifacts"] as string[])
          : [];
        // Built by the same function the processor writes its rows with, so a
        // hand-made payload is the shape the uploader expects, sidecars
        // (`payload`, `oldInfo`, `unavailableAt`) included.
        const payload = chapterToTaskPayload(raw, artifacts);

        const problems = manualTaskProblems(kind, payload);
        if (JSON.stringify(payload).length > MAX_CHAPTER_BYTES) {
          problems.push(`chapter payload exceeds ${MAX_CHAPTER_BYTES} bytes`);
        }
        if (problems.length > 0) {
          return reply.code(422).send({ error: "chapter payload cannot be executed", problems });
        }

        // Missing page artifacts would fail the task after the upload session was
        // open; the queue-time answer is cheaper and reversible.
        if (artifacts.length > 0) {
          const found = await ctx.prisma.artifact.findMany({
            where: { id: { in: artifacts } },
            select: { id: true },
          });
          const missing = artifacts.filter((id) => !found.some((row) => row.id === id));
          if (missing.length > 0) {
            return reply.code(422).send({
              error: "chapter references page artifacts that do not exist",
              problems: missing.map((id) => `artifact ${id} is not in the artifact store`),
            });
          }
        }

        const dedupeKey = taskDedupeKey(kind, chapterFromJson(payload));
        if (dedupeKey === null) {
          // Unreachable via manualTaskProblems; kept so a future kind cannot slip
          // through with no identity at all.
          return reply.code(422).send({ error: "cannot derive a dedupe key for this chapter" });
        }

        const created = await ctx.uploadTasks.createManual(kind, dedupeKey, payload, {
          notBefore: body.notBefore,
          maxAttempts: body.maxAttempts,
        });
        if (!created) {
          const existing = await ctx.prisma.uploadTask.findUnique({
            where: { kind_dedupeKey: { kind, dedupeKey } },
            select: { id: true, state: true, attempt: true, createdAt: true },
          });
          return reply.code(409).send({
            error: `a ${kind} task for ${dedupeKey} is already queued`,
            dedupeKey,
            existing,
          });
        }

        await ctx.audit.record(actor(req), "queue.task_create", created.id, {
          kind,
          dedupeKey,
          notBefore: created.notBefore,
          maxAttempts: created.maxAttempts,
          // The whole payload: this is a manual write to MangaDex and the audit
          // row must be enough to reconstruct exactly what was asked for.
          chapter: payload,
        });
        return reply.code(201).send({ ok: true, task: created });
      },
    );

    // ---- edit a queued task ----

    /**
     * Correct a task that has not run yet: the chapter payload, when it becomes
     * due, and its attempt budget.
     *
     * PENDING only. A LEASED row is being executed right now, and a DONE or dead
     * row is history. `chapter` is a shallow merge so a caller can fix one field
     * without restating the payload; passing `null` for a key clears it.
     *
     * If the merge changes an identity field the dedupe key is recomputed, and a
     * collision is a 409 rather than a silent overwrite of another chapter's slot.
     */
    scope.patch(
      "/api/v1/admin/queues/tasks/:id",
      { preHandler: requireScope("runs:write") },
      async (req, reply) => {
        const { id } = parseOrThrow(taskIdParam, req.params);
        const body = parseOrThrow(
          z
            .object({
              chapter: ChapterPayload.optional(),
              notBefore: z.coerce.date().optional(),
              maxAttempts: z.number().int().min(1).max(50).optional(),
            })
            .refine(
              (value) =>
                value.chapter !== undefined ||
                value.notBefore !== undefined ||
                value.maxAttempts !== undefined,
              { message: "nothing to change: pass chapter, notBefore or maxAttempts" },
            ),
          req.body ?? {},
        );

        const current = await ctx.uploadTasks.get(id);
        if (!current) return reply.code(404).send({ error: "unknown upload task" });
        if (current.state !== "PENDING") {
          return reply.code(409).send({
            error:
              current.state === "LEASED"
                ? `an uploader holds lease ${current.leaseId ?? "(unknown)"} on this task; ` +
                  "a task being executed cannot be edited"
                : `task is ${current.state}; only a PENDING task can be edited` +
                  (current.state === "FAILED" || current.state === "DEAD_LETTER"
                    ? "; retry it first, which returns it to PENDING"
                    : ""),
            state: current.state,
          });
        }

        const before =
          typeof current.chapter === "object" && current.chapter !== null && !Array.isArray(current.chapter)
            ? (current.chapter as Record<string, unknown>)
            : {};
        const merged = body.chapter ? { ...before, ...(body.chapter as Record<string, unknown>) } : before;
        const artifacts = Array.isArray(merged["imageArtifacts"])
          ? (merged["imageArtifacts"] as string[])
          : [];
        const payload = chapterToTaskPayload(merged, artifacts);

        const kind = current.kind as UploadTaskKind;
        const problems = manualTaskProblems(kind, payload);
        if (JSON.stringify(payload).length > MAX_CHAPTER_BYTES) {
          problems.push(`chapter payload exceeds ${MAX_CHAPTER_BYTES} bytes`);
        }
        if (problems.length > 0) {
          return reply.code(422).send({ error: "the edited payload cannot be executed", problems });
        }

        const dedupeKey = taskDedupeKey(kind, chapterFromJson(payload));
        if (dedupeKey === null) {
          return reply.code(422).send({ error: "the edit would leave the task with no dedupe key" });
        }

        try {
          const ok = await ctx.uploadTasks.patchPending(id, {
            chapter: payload,
            dedupeKey,
            notBefore: body.notBefore,
            maxAttempts: body.maxAttempts,
            expectedUpdatedAt: current.updatedAt,
          });
          if (!ok) {
            // The row moved between the read and the write: claimed, swept, or
            // edited by someone else. Refuse rather than clobber.
            const now = await ctx.uploadTasks.get(id);
            return reply.code(409).send({
              error: `lost the race: this task is now ${now?.state ?? "gone"}; re-read it and try again`,
              // Same discriminator every other refusal carries, so a client can
              // switch on `outcome` uniformly across the whole module.
              outcome: "lost_race" satisfies Outcome,
              ok: false,
              state: now?.state ?? null,
            });
          }
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
            const existing = await ctx.prisma.uploadTask.findUnique({
              where: { kind_dedupeKey: { kind, dedupeKey } },
              select: { id: true, state: true },
            });
            return reply.code(409).send({
              error:
                `the edit would give this task the dedupe key ${dedupeKey}, which a ${kind} ` +
                "task already holds",
              dedupeKey,
              existing,
            });
          }
          throw err;
        }

        const updated = await ctx.uploadTasks.get(id);
        await ctx.audit.record(actor(req), "queue.task_edit", id, {
          kind,
          dedupeKeyBefore: current.dedupeKey,
          dedupeKeyAfter: dedupeKey,
          notBefore: body.notBefore ?? null,
          maxAttempts: body.maxAttempts ?? null,
          chapterBefore: before,
          chapterAfter: payload,
        });
        return { ok: true, task: updated, dedupeKeyChanged: current.dedupeKey !== dedupeKey };
      },
    );
  });
}
