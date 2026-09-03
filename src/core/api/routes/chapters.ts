import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { adminAuthHook, requireScope } from "../auth.js";
import { sessionAuthenticator, impersonationResolver} from "../session.js";
import { normaliseMangadexLanguage } from "../../../contracts/languages.js";
import { EXTENSION_NAME_RE, Manifest, hostAllowed } from "../../../contracts/manifest.js";
import type { RemovalMode } from "../../store/settings.js";
import { chapterToTaskPayload } from "../../md/chapterRows.js";
import { ReconcileRunner } from "../../md/reconcileRunner.js";
import { DuplicateRunner } from "../../md/duplicateRunner.js";
import { ChapterCollisionStore, MAX_COLLISION_PAGE } from "../../store/chapterCollisions.js";
import { REMOVAL_CONFIRMATIONS } from "../../store/removalChecks.js";
import type { MdExtendedApi } from "../../md/client.js";
import { generateChapterCard } from "../../md/card.js";
import { unavailableCardOptions } from "../../md/unavailableCard.js";
import type { MdChapterDetail } from "../../md/client.js";
import { botUserIdFromClientId, isCarded } from "../../md/types.js";
import {
  ARCHIVES,
  CHAPTER_ARCHIVES,
  CHAPTER_SORTS,
  SERIES_SORTS,
  chapterOf,
  decodeChapterCursor,
  type ChapterArchive,
  type ChapterFilter,
  type ChapterRow,
} from "../../store/chapters.js";
import { CHAPTER_SETS, RUN_CHAPTER_SORTS, type ChapterSet } from "../../store/runChapters.js";
import {
  decodeTaskCursor,
  QUEUED_CHAPTER_SORTS,
  taskDedupeKey,
  UPLOAD_TASK_KINDS,
  UPLOAD_TASK_STATES,
} from "../../store/uploadTasks.js";
import { manualTaskProblems } from "./queues.js";

/**
 * The three places a chapter can be looked at, and the three things an operator
 * can do to one that is already published.
 *
 *   1. `GET /runs/:id/chapters`   what an extension found on a given run, read
 *                                 back out of the stored result envelope.
 *   2. `GET /queues/chapters`     what is about to be sent to MangaDex, in the
 *                                 order the uploader will claim it.
 *   3. `GET /chapters`            what is on MangaDex already, plus the archives
 *                                 of what has been edited, marked unavailable or
 *                                 deleted.
 *
 * The first two are pure projections and own no storage.
 *
 * Every mutating route queues an UploadTask and returns 202. core-uploader is
 * the only process that writes to MangaDex, which is what makes "one open upload
 * session per account" enforceable, gives every change a retry budget and a
 * dead-letter, and stops two API replicas racing into a duplicate.
 *
 * Guards, in the order they bite:
 *   1. `chapters:read` to look, `chapters:write` to queue anything.
 *   2. ADMIN-or-above by role on every mutating route.
 *   3. A settled queue row for the chapter is superseded; a PENDING or LEASED
 *      one is a 409 naming it.
 *   4. Deleting needs `confirm: true`.
 */

const MAX_PAGE = 200;
const DEFAULT_PAGE = 50;

/**
 * Cap on a page of the two read-only projections. Higher than `MAX_PAGE` because
 * those rows are not archive rows an action can be taken against, and neither
 * endpoint can mutate anything.
 */
const MAX_PROJECTION_PAGE = 500;

/** Titles shown in a run's per-series breakdown. */
const MANGA_BREAKDOWN_LIMIT = 200;

/** Titles one `/chapters/series` answer carries. */
const SERIES_LIMIT = 500;

/**
 * How far back a re-check looks for evidence that an extension publishes a
 * full catalogue listing. Enough that one odd run cannot answer for the
 * extension, few enough that the check stays a single indexed read.
 */
const RECHECK_RUNS_INSPECTED = 5;

/**
 * Hard ceiling on one bulk action. Lower than the 1000 routes/queues.ts allows,
 * because that cap bounds a change to queue rows and this one bounds a change to
 * public pages. Small enough that the dry run listing every affected chapter is
 * still readable.
 */
const CHAPTER_BULK_CAP = 200;

const MD_CHAPTER_URL = "https://mangadex.org/chapter/";
const MD_MANGA_URL = "https://mangadex.org/title/";

/**
 * A MangaDex chapter id as it appears in our tables. Not `z.string().uuid()`:
 * chapters migrated from the legacy Mongo collections carry whatever id that
 * database held. The charset is still closed.
 */
const MdChapterId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "not a MangaDex chapter id");

/** Validate, answering 400 instead of 500. Same helper as the sibling modules. */
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

/**
 * A boolean that may arrive as a query-string word. Not `z.coerce.boolean()`,
 * which maps the string "false" to true.
 */
const Flag = z.preprocess(
  (value) => (typeof value === "string" ? value === "true" || value === "1" : value),
  z.boolean(),
);

/**
 * The fields a chapter edit may change, in MangaDex's vocabulary rather than our
 * column names, so there is no translation layer for the two to drift across.
 * `null` clears a field; omitting it leaves it alone. Lengths mirror the
 * MangaDex API's own limits.
 */
const EditPayload = z
  .object({
    volume: z.string().max(8).nullish(),
    chapter: z.string().max(8).nullish(),
    title: z.string().max(255).nullish(),
    translatedLanguage: z.string().min(2).max(16).optional(),
    groups: z.array(z.string().uuid()).min(1).max(5).optional(),
    externalUrl: z.string().max(2048).nullish(),
  })
  .strict();

/**
 * What a bulk edit may change: the fields a set of chapters can legitimately
 * share. Title, chapter number and external URL are one chapter's identity, so
 * they are not expressible here.
 */
const BulkEditPayload = z
  .object({
    volume: z.string().max(8).nullish(),
    translatedLanguage: z.string().min(2).max(16).optional(),
    groups: z.array(z.string().uuid()).min(1).max(5).optional(),
  })
  .strict();

export function registerChapterRoutes(app: FastifyInstance, ctx: AppContext): void {
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

    /** Same attribution rules as routes/admin.ts, ops.ts and queues.ts. */
    /**
     * The background reconcile runner.
     *
     * `md` is passed rather than read off `ctx` so the caller's own null check
     * is what narrows it; there is exactly one deployment shape without a
     * MangaDex client and both routes below answer for it explicitly.
     */
    const runner = (md: MdExtendedApi): ReconcileRunner =>
      new ReconcileRunner({
        prisma: ctx.prisma,
        md,
        log: ctx.log,
        audit: ctx.audit,
        settings: ctx.settings,
      });

    /** The background duplicate scanner; same shape, its own lock. */
    const duplicates = (md: MdExtendedApi): DuplicateRunner =>
      new DuplicateRunner({
        prisma: ctx.prisma,
        md,
        log: ctx.log,
        audit: ctx.audit,
        settings: ctx.settings,
        // Duplicates are hard-deleted, so the scan is gated on being able to
        // prove we uploaded the chapter. Explicit config wins; otherwise the
        // owner's user id is read out of a personal client id.
        botUserId: ctx.config.mdBotUserId ?? botUserIdFromClientId(ctx.config.mdClientId),
      });

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
     * ADMIN-or-above and closed to api tokens, on top of `chapters:write`. The
     * scope says the credential works on the chapter catalogue; the role says
     * the principal may change a public one.
     *
     * Tokens are refused outright because `adminAuthHook` gives every api token
     * `adminRole = "ADMIN"`. An allow-list on the role, not "refuse
     * CONTRIBUTOR": a deny-list on a role enum grants every role added later.
     */
    async function requireAdminRole(req: FastifyRequest, reply: FastifyReply): Promise<void> {
      if (req.principal?.kind === "api-token") {
        await reply.code(403).send({ error: TOKEN_REFUSAL, requiredRole: "ADMIN" });
        return;
      }
      if (req.adminRole !== "OWNER" && req.adminRole !== "ADMIN") {
        await reply.code(403).send({ error: ROLE_REFUSAL, requiredRole: "ADMIN" });
      }
    }

    const chapterParam = z.object({ mdChapterId: MdChapterId });

    /**
     * Find the chapter wherever it is recorded. Order matters: `uploaded` is the
     * live mirror and wins, then the two archives that still describe something
     * on MangaDex, and `deleted` last, since a hit there alone means the chapter
     * is gone.
     */
    async function locate(
      mdChapterId: string,
    ): Promise<{ archive: ChapterArchive; row: ChapterRow } | null> {
      for (const archive of ["uploaded", "unavailable", "edited", "deleted"] as const) {
        const row = await ctx.chapters.get(archive, mdChapterId);
        if (row) return { archive, row };
      }
      return null;
    }

    /** What MangaDex says right now, or why we could not ask. */
    async function liveChapter(
      mdChapterId: string,
    ): Promise<{ detail: MdChapterDetail | null; error: string | null }> {
      if (!ctx.md) {
        return {
          detail: null,
          error: "this API instance holds no MangaDex credentials, so the live chapter was not read",
        };
      }
      try {
        const detail = await ctx.md.chapterById(mdChapterId, ["scanlation_group", "manga"]);
        return {
          detail,
          error: detail ? null : `MangaDex has no chapter ${mdChapterId}; it may already be gone`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.log.warn({ err, mdChapterId }, "live MangaDex chapter read failed");
        return { detail: null, error: message };
      }
    }

    /**
     * Queue one chapter action. The payload is built by `chapterToTaskPayload`,
     * the same function the processor writes its queue rows with, and validated
     * by `manualTaskProblems`, the validator routes/queues.ts uses, so a task
     * that would throw on claim is refused now and the two paths cannot drift.
     */
    async function queueAction(
      req: FastifyRequest,
      reply: FastifyReply,
      opts: {
        kind: "EDIT" | "DELETE" | "UNAVAILABLE" | "RESTORE";
        row: ChapterRow;
        sidecars: Record<string, unknown>;
        audit: string;
        auditDetail: Record<string, unknown>;
        warnings?: string[];
      },
    ): Promise<FastifyReply> {
      const chapter = chapterOf(opts.row);
      const payload: Record<string, unknown> = {
        ...chapterToTaskPayload(
          chapter as unknown as Record<string, unknown>,
          chapter.imageArtifacts,
        ),
        ...opts.sidecars,
      };

      const problems = manualTaskProblems(opts.kind, payload);
      if (problems.length > 0) {
        // Reachable for a row whose md_chapter_id is somehow absent, and for an
        // EDIT whose payload the schema allowed but which reduces to nothing.
        return reply.code(422).send({ error: "this chapter cannot be queued", problems });
      }

      const dedupeKey = taskDedupeKey(opts.kind, chapter);
      if (dedupeKey === null) {
        return reply.code(422).send({ error: "cannot derive a queue key for this chapter" });
      }

      const queued = await ctx.uploadTasks.requeueForChapter(opts.kind, dedupeKey, payload);
      if (!queued) {
        // The slot is held by work already queued or in flight. Read the row only
        // now, and only to name it, never to decide whether to write.
        const existing = (await ctx.uploadTasks.forDedupeKey(dedupeKey)).find(
          (task) => task.kind === opts.kind,
        );
        return reply.code(409).send({
          error:
            existing?.state === "LEASED"
              ? `an uploader is executing a ${opts.kind} for this chapter right now ` +
                `(lease ${existing.leaseId ?? "unknown"}); wait for it to finish and look at the ` +
                "result before queueing another"
              : `a ${opts.kind} for this chapter is already queued and has not run yet; ` +
                "cancel or edit it from the Queues view rather than queueing a second one",
          outcome: existing?.state === "LEASED" ? "leased" : "already_queued",
          task: existing ?? null,
        });
      }

      await ctx.audit.record(actor(req), opts.audit, opts.row.mdChapterId, {
        ...opts.auditDetail,
        extension: opts.row.extension,
        mdMangaId: opts.row.mdMangaId,
        chapterNumber: opts.row.chapterNumber,
        chapterLanguage: opts.row.chapterLanguage,
        taskId: queued.task.id,
        supersededCompletedTask: queued.superseded,
      });

      // 202: the change is queued, not applied. The uploader may still fail it.
      return reply.code(202).send({
        ok: true,
        queued: true,
        action: opts.kind,
        task: queued.task,
        /** True when a completed or failed task for this chapter was reset in place. */
        superseded: queued.superseded,
        mdChapterId: opts.row.mdChapterId,
        // Named for what it points at: `chapterUrl` on a chapter means the
        // publisher's link everywhere else in this codebase.
        mangadexUrl: `${MD_CHAPTER_URL}${opts.row.mdChapterId}`,
        warnings: opts.warnings ?? [],
        note: "core-uploader drains this queue; watch it under Queues, filtered by this chapter id.",
      });
    }

    // ------------------------------------------------------- found, per run

    const runIdParam = z.object({ id: z.string().uuid() });
    const SetQuery = z.enum(CHAPTER_SETS).default("updated");

    /**
     * How much each segment of a run reported, and which titles it was for.
     * Segments with no committed envelope come back with null counts rather than
     * being absent, so a partial picture cannot read as the whole one.
     */
    scope.get(
      "/api/v1/admin/runs/:id/chapters/summary",
      { preHandler: requireScope("runs:read") },
      async (req, reply) => {
        const { id } = parseOrThrow(runIdParam, req.params);
        const query = parseOrThrow(z.object({ set: SetQuery }), req.query ?? {});
        const run = await ctx.prisma.run.findUnique({
          where: { id },
          select: { id: true, extension: true, kind: true, state: true, createdAt: true },
        });
        if (!run) return reply.code(404).send({ error: "unknown run" });

        const [segments, byManga, mangaTitles] = await Promise.all([
          ctx.runChapters.segmentCounts(id),
          ctx.runChapters.byManga(id, query.set as ChapterSet, MANGA_BREAKDOWN_LIMIT),
          ctx.runChapters.titlesFor(id, query.set as ChapterSet),
        ]);

        const reported = segments.filter((segment) => segment.updated !== null);
        return {
          run,
          set: query.set,
          segments,
          // Named rather than left to the client to sum: the difference between
          // "found nothing" and "has not reported yet" is the point of this
          // endpoint.
          segmentsTotal: segments.length,
          segmentsReported: reported.length,
          complete: reported.length === segments.length && segments.length > 0,
          totals: {
            updated: reported.reduce((sum, segment) => sum + (segment.updated ?? 0), 0),
            all: segments.some((segment) => segment.all !== null)
              ? segments.reduce((sum, segment) => sum + (segment.all ?? 0), 0)
              : null,
            untrackedManga: reported.reduce((sum, segment) => sum + (segment.untrackedManga ?? 0), 0),
          },
          byManga,
          // Counted in the database over every title, NOT `byManga.length`,
          // which is the size of a LIMITed page: a run touching 900 titles
          // reported "200 titles" for as long as that was the number shown.
          mangaTitles,
          mangaCapped: byManga.length < mangaTitles,
          /** How many of the titles the breakdown below actually lists. */
          mangaShown: byManga.length,
        };
      },
    );

    /**
     * The chapters one run found, in the order the extension reported them.
     *
     * `set=updated` (the default) is what the extension flagged as new or
     * changed. `set=all` is the optional full-catalogue snapshot that drives
     * removal detection; it is empty rather than absent when an extension does
     * not send one, and the summary endpoint says which case a run is in.
     */
    scope.get(
      "/api/v1/admin/runs/:id/chapters",
      { preHandler: requireScope("runs:read") },
      async (req, reply) => {
        const { id } = parseOrThrow(runIdParam, req.params);
        const query = parseOrThrow(
          z.object({
            set: SetQuery,
            q: z.string().min(1).max(256).optional(),
            mdMangaId: z.string().uuid().optional(),
            language: z.string().min(2).max(16).optional(),
            segmentIndex: z.coerce.number().int().min(0).max(10_000).optional(),
            limit: z.coerce.number().int().min(1).max(MAX_PROJECTION_PAGE).default(100),
            offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
            /** One column, over every chapter the run found: see `/chapters`. */
            orderBy: z.enum(RUN_CHAPTER_SORTS).optional(),
            dir: z.enum(["asc", "desc"]).default("asc"),
          }),
          req.query ?? {},
        );

        const run = await ctx.prisma.run.findUnique({
          where: { id },
          select: { id: true, extension: true, state: true },
        });
        if (!run) return reply.code(404).send({ error: "unknown run" });

        const page = await ctx.runChapters.list(
          id,
          query.set as ChapterSet,
          {
            q: query.q,
            mdMangaId: query.mdMangaId,
            language: query.language,
            segmentIndex: query.segmentIndex,
          },
          {
            limit: query.limit,
            offset: query.offset,
            column: query.orderBy ? { name: query.orderBy, dir: query.dir } : null,
          },
        );

        return {
          run,
          set: query.set,
          chapters: page.chapters,
          total: page.total,
          limit: query.limit,
          offset: query.offset,
          orderedBy: query.orderBy ?? null,
          dir: query.dir,
          sortable: RUN_CHAPTER_SORTS,
          // Offset paging is safe here: a committed envelope never changes, so
          // page 2 is stable whichever column it is ordered by.
          order: query.orderBy ? `${query.orderBy} ${query.dir}` : "segmentIndex,position",
        };
      },
    );

    // ------------------------------------------------- queued, in claim order

    /**
     * The upload queue read as chapters rather than as rows.
     *
     * `position` is the place in the claim order across everything matching the
     * filter, not within the page, and stays that way whichever direction the
     * page is read in. Ordering follows the claim query's ORDER BY by default;
     * `sort=desc` reverses it so the newest queued chapters come first. See
     * `UploadTaskStore.listChapters`.
     *
     * Defaults to PENDING; pass `state` explicitly to see what has already run.
     */
    scope.get(
      "/api/v1/admin/queues/chapters",
      { preHandler: requireScope("runs:read") },
      async (req) => {
        const query = parseOrThrow(
          z.object({
            kind: oneOrMany(UPLOAD_TASK_KINDS).optional(),
            state: oneOrMany(UPLOAD_TASK_STATES).optional(),
            q: z.string().min(1).max(256).optional(),
            dedupeKey: z.string().min(1).max(256).optional(),
            // The same two facets `/queues/tasks` takes, so a filter means the
            // same thing on either tab.
            extension: z.string().min(1).max(128).optional(),
            language: z.string().min(1).max(32).optional(),
            limit: z.coerce.number().int().min(1).max(MAX_PROJECTION_PAGE).default(100),
            cursor: z.string().max(512).optional(),
            sort: z.enum(["asc", "desc"]).default("asc"),
            /** One column, over the whole queue: see `/queues/tasks`. */
            orderBy: z.enum(QUEUED_CHAPTER_SORTS).optional(),
            dir: z.enum(["asc", "desc"]).default("asc"),
          }),
          req.query ?? {},
        );

        const column = query.orderBy
          ? { name: query.orderBy, dir: query.dir, cursor: query.cursor ?? null }
          : null;
        const cursor = !column && query.cursor ? decodeTaskCursor(query.cursor) : null;
        if (!column && query.cursor && !cursor) {
          throw Object.assign(new Error("invalid cursor: not a cursor this endpoint issued"), {
            statusCode: 400,
          });
        }

        const filter = {
          kinds: query.kind,
          states: query.state ?? (["PENDING"] as const),
          q: query.q,
          dedupeKey: query.dedupeKey,
          extension: query.extension,
          language: query.language,
        };
        const [page, summary] = await Promise.all([
          ctx.uploadTasks.listChapters(filter, {
            limit: query.limit,
            cursor,
            sort: query.sort,
            column,
          }),
          ctx.uploadTasks.depths(),
        ]);

        return {
          chapters: page.chapters,
          total: page.total,
          limit: query.limit,
          nextCursor: page.nextCursor,
          sort: query.sort,
          orderedBy: column?.name ?? null,
          dir: query.dir,
          sortable: QUEUED_CHAPTER_SORTS,
          order: column
            ? `${column.name},id (${column.dir}ending)`
            : query.sort === "desc"
              ? "notBefore,createdAt,id DESC"
              : "notBefore,createdAt,id",
          states: filter.states,
          summary,
        };
      },
    );

    // ------------------------------------------------------------------ read

    /**
     * One page of an archive, newest first. `archive` selects which of the four
     * tables is being read; they share a shape, so they share an endpoint.
     */
    /**
     * Bring the archives back in line with what MangaDex actually holds.
     *
     * The one endpoint here that does NOT queue an upload task, and the reason
     * it is allowed to write directly: it changes nothing on MangaDex. It reads
     * the catalogue and corrects our record of it. Queueing would be actively
     * wrong: a chapter it finds is already unavailable, already gone, or
     * already live and merely unrecorded, so running the workers over them
     * would re-upload cards, re-issue deletes and re-upload chapters for work
     * that is already done.
     *
     * The auth split is deliberate and is the only one in this module. A dry
     * run reads MangaDex and reports, so it sits at `chapters:read` and any
     * scoped token may run it; that is what makes the state observable from a
     * monitoring probe or the bot. Applying moves rows between tables, so it
     * takes the same guard as every other mutating route here: ADMIN-or-above
     * and closed to api tokens.
     */
    scope.post(
      "/api/v1/admin/chapters/reconcile",
      { preHandler: requireScope("chapters:read") },
      async (req, reply) => {
        const body = parseOrThrow(
          z.object({
            dryRun: z.boolean().default(true),
            extensions: z.array(z.string().max(64)).max(50).default([]),
            /** Skip the uploaded_chapters sweep: the slow half, and the only
             *  one that can find deletions. */
            skipDeleted: z.boolean().default(false),
            /** Report the untracked live chapters without adopting any of them. */
            skipAdopt: z.boolean().default(false),
            /** Report the carded chapters without archiving any of them. */
            skipUnavailable: z.boolean().default(false),
          }),
          req.body ?? {},
        );

        if (!ctx.md) {
          return reply.code(503).send({ error: "this deployment has no MangaDex client" });
        }
        // The role check is here rather than in a preHandler because it depends
        // on the body: a preHandler would refuse the dry run too.
        if (!body.dryRun) {
          if (req.principal?.kind === "api-token") {
            return reply.code(403).send({ error: TOKEN_REFUSAL, requiredRole: "ADMIN" });
          }
          if (req.adminRole !== "OWNER" && req.adminRole !== "ADMIN") {
            return reply.code(403).send({ error: ROLE_REFUSAL, requiredRole: "ADMIN" });
          }
        }

        const { started, status } = await runner(ctx.md).start(
          {
            dryRun: body.dryRun,
            extensions: body.extensions,
            skipDeleted: body.skipDeleted,
            skipAdopt: body.skipAdopt,
            skipUnavailable: body.skipUnavailable,
          },
          actor(req),
        );
        // 202, because the work has not happened yet. `started: false` is not
        // an error: it means a pass was already in flight, which is the honest
        // answer to a second click on a four-minute button.
        return reply.code(202).send({ ok: true, started, ...status });
      },
    );

    /**
     * Where the current or last reconcile pass is up to.
     *
     * Read-only and cheap, because it is polled: it reads one `settings` row
     * and never touches MangaDex. `chapters:read` like the dry run it reports
     * on, so a monitoring probe or the bot can watch a pass it did not start.
     */
    scope.get(
      "/api/v1/admin/chapters/reconcile",
      { preHandler: requireScope("chapters:read") },
      async () => {
        if (!ctx.md) {
          return { ok: true, state: "idle", note: "this deployment has no MangaDex client" };
        }
        return { ok: true, ...(await runner(ctx.md).status()) };
      },
    );

    /**
     * Find the chapters MangaDex holds twice, per series.
     *
     * Deliberately independent of an extension run. `deleteDuplicates` in the
     * processor already catches the duplicate a run just created, but it can
     * only look at the series that run visited, with the overrides that run
     * carried — so "does this series have duplicates?" was unanswerable for
     * exactly the series that accumulate them: the ones whose publisher is
     * gone, and the ones no recent run was scoped to. This reads MangaDex and
     * nothing else, so it answers at any time, for any series.
     *
     * The auth split is the reconcile pass's, for the same reason. Reporting
     * reads MangaDex and writes nothing, so it sits at `chapters:read` and any
     * scoped token may run it. `apply` queues a hard delete per duplicate,
     * which is the most destructive thing this module can be asked to do, so it
     * takes the delete route's full guard: ADMIN-or-above, closed to api
     * tokens, and `confirm: true` on top — deletion cannot be undone, and an
     * unscoped scan can find hundreds at once.
     */
    /**
     * Removals that several runs have not yet agreed on.
     *
     * The question this answers is "the publisher dropped this chapter days ago
     * -- why is it still up?", and before this the only answer was in the
     * processor's logs. A held removal is deliberate: absence is a vote, and a
     * chapter is carded only once separate runs days apart have all said the
     * same thing (see RemovalCheckStore).
     */
    scope.get(
      "/api/v1/admin/chapters/removal-checks",
      { preHandler: requireScope("chapters:read") },
      async (req) => {
        const query = parseOrThrow(
          z.object({
            extension: z.string().max(64).optional(),
            limit: z.coerce.number().int().min(1).max(500).default(100),
          }),
          req.query ?? {},
        );
        const pending = await ctx.removalChecks.pending(query.extension, query.limit);
        return {
          confirmations: REMOVAL_CONFIRMATIONS,
          pending: pending.map((row) => ({
            mdChapterId: row.mdChapterId,
            extension: row.extension,
            mdMangaId: row.mdMangaId,
            pass: row.pass,
            mode: row.mode,
            misses: row.misses,
            remaining: Math.max(0, REMOVAL_CONFIRMATIONS - row.misses),
            firstMissedAt: row.firstMissedAt,
            lastMissedAt: row.lastMissedAt,
            nextVoteAt: row.notBefore,
          })),
        };
      },
    );

    /**
     * Forget one extension's tally outright.
     *
     * Ordinarily unnecessary: a recovered extension lists its chapters again
     * and each tally is dropped on sight. This is for the operator who already
     * knows it was an outage and does not want the votes sitting there until
     * the next run, and it can only ever make the platform LESS likely to
     * remove something, which is why it needs no confirm flag.
     */
    scope.post(
      "/api/v1/admin/chapters/removal-checks/clear",
      { preHandler: requireScope("chapters:write") },
      async (req) => {
        const body = parseOrThrow(
          z.object({ extension: z.string().min(1).max(64) }),
          req.body ?? {},
        );
        const cleared = await ctx.removalChecks.clearExtension(body.extension);
        await ctx.audit.record(actor(req), "chapter.removal_checks.clear", body.extension, {
          extension: body.extension,
          cleared,
        });
        return { ok: true, extension: body.extension, cleared };
      },
    );

    scope.post(
      "/api/v1/admin/chapters/duplicates",
      { preHandler: requireScope("chapters:read") },
      async (req, reply) => {
        const body = parseOrThrow(
          z.object({
            /** Queue a DELETE for every duplicate. Default reports only. */
            apply: z.boolean().default(false),
            confirm: z.boolean().default(false),
            extensions: z.array(z.string().max(64)).max(50).default([]),
            /** Scope to these MangaDex titles; also makes the scan ask per series. */
            mangaIds: z.array(z.string().uuid()).max(200).default([]),
          }),
          req.body ?? {},
        );

        if (!ctx.md) {
          return reply.code(503).send({ error: "this deployment has no MangaDex client" });
        }
        // Body-dependent, so it cannot be a preHandler: that would refuse the
        // report as well, which is the half everything else here is built on.
        if (body.apply) {
          if (req.principal?.kind === "api-token") {
            return reply.code(403).send({ error: TOKEN_REFUSAL, requiredRole: "ADMIN" });
          }
          if (req.adminRole !== "OWNER" && req.adminRole !== "ADMIN") {
            return reply.code(403).send({ error: ROLE_REFUSAL, requiredRole: "ADMIN" });
          }
          if (!body.confirm) {
            return reply.code(400).send({
              error:
                "deleting duplicates from MangaDex cannot be undone; pass confirm: true",
              alternative:
                "the same call without `apply` reports every duplicate it would delete, " +
                "including which chapter of each pair would survive",
            });
          }
        }

        const { started, status } = await duplicates(ctx.md).start(
          { apply: body.apply, extensions: body.extensions, mangaIds: body.mangaIds },
          actor(req),
        );
        // 202: the scan has not happened yet, and with `apply` neither has the
        // deletion — core-uploader drains the DELETE tasks it queues.
        return reply.code(202).send({ ok: true, started, ...status });
      },
    );

    /**
     * Where the current or last duplicate scan is up to.
     *
     * Read-only and cheap, because it is polled: one `settings` row, no
     * MangaDex call.
     */
    scope.get(
      "/api/v1/admin/chapters/duplicates",
      { preHandler: requireScope("chapters:read") },
      async () => {
        if (!ctx.md) {
          return { ok: true, state: "idle", note: "this deployment has no MangaDex client" };
        }
        return { ok: true, ...(await duplicates(ctx.md).status()) };
      },
    );

    /**
     * Chapters we uploaded onto a number our own group already holds.
     *
     * A warning list, not a failure list, so it is deliberately NOT in the
     * Errors feed: nothing here failed, and every one of these uploads was
     * intended. It answers the question that had no home before — "did we just
     * publish a second copy of something?" — which is the question the comikey
     * re-upload needed somebody to be able to ask.
     */
    scope.get(
      "/api/v1/admin/chapters/collisions",
      { preHandler: requireScope("chapters:read") },
      async (req) => {
        const query = parseOrThrow(
          z.object({
            extension: z.string().max(64).optional(),
            includeAcknowledged: z.coerce.boolean().default(false),
            limit: z.coerce.number().int().min(1).max(MAX_COLLISION_PAGE).default(DEFAULT_PAGE),
            offset: z.coerce.number().int().min(0).default(0),
          }),
          req.query ?? {},
        );

        const page = await new ChapterCollisionStore(ctx.prisma).list({
          extension: query.extension ?? null,
          includeAcknowledged: query.includeAcknowledged,
          limit: query.limit,
          offset: query.offset,
        });
        return { ok: true, ...page };
      },
    );

    /**
     * Mark collisions as looked at, or put one back.
     *
     * Hides, never deletes, the same contract as the error feed: the row stays
     * for the audit trail and `includeAcknowledged` lists it again.
     */
    scope.post(
      "/api/v1/admin/chapters/collisions/acknowledge",
      { preHandler: requireScope("chapters:write") },
      async (req, reply) => {
        if (req.principal?.kind === "api-token") {
          return reply.code(403).send({ error: TOKEN_REFUSAL, requiredRole: "ADMIN" });
        }
        if (req.adminRole !== "OWNER" && req.adminRole !== "ADMIN") {
          return reply.code(403).send({ error: ROLE_REFUSAL, requiredRole: "ADMIN" });
        }

        const body = parseOrThrow(
          z
            .object({
              ids: z.array(z.string().uuid()).min(1).max(MAX_COLLISION_PAGE),
              /** Undo, for one judged too quickly. */
              undo: z.boolean().default(false),
            })
            .strict(),
          req.body ?? {},
        );

        const store = new ChapterCollisionStore(ctx.prisma);
        const who = actor(req);
        const changed = body.undo
          ? await store.unacknowledge(body.ids)
          : await store.acknowledge(body.ids, who);
        await ctx.audit.record(
          who,
          body.undo ? "chapter.collision.unacknowledge" : "chapter.collision.acknowledge",
          undefined,
          { ids: body.ids.slice(0, 50), changed },
        );
        return { ok: true, changed };
      },
    );

    /**
     * Chapters we decided should NOT be carded, and what became of that.
     *
     * A RESTORE task means somebody (or a removal audit) judged the card wrong.
     * Whether the card is actually off is not the task's state -- a restore can
     * report DONE and change nothing, which is how 23 chapters were recorded as
     * restored while every one kept its card. The honest signal is which
     * archive the chapter sits in now: `unavailable` means still carded,
     * `uploaded` means the card really came off.
     */
    scope.get(
      "/api/v1/admin/chapters/restores",
      { preHandler: requireScope("chapters:read") },
      async (req) => {
        const query = parseOrThrow(
          z.object({
            outcome: z.enum(["all", "still-carded", "restored"]).default("all"),
            limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(DEFAULT_PAGE),
          }),
          req.query ?? {},
        );

        const tasks = await ctx.prisma.uploadTask.findMany({
          where: { kind: "RESTORE" },
          orderBy: { updatedAt: "desc" },
          take: query.limit,
          select: { id: true, state: true, attempt: true, lastError: true, updatedAt: true, chapter: true },
        });

        const rowOf = (value: unknown): Record<string, unknown> =>
          value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
        const idOf = (task: (typeof tasks)[number]): string | null => {
          const id = rowOf(task.chapter)["mdChapterId"];
          return typeof id === "string" ? id : null;
        };

        const ids = tasks.map(idOf).filter((id): id is string => id !== null);
        const [carded, live, deleted] = await Promise.all([
          ctx.prisma.unavailableChapter.findMany({
            where: { mdChapterId: { in: ids } },
            select: { mdChapterId: true },
          }),
          ctx.prisma.uploadedChapter.findMany({
            where: { mdChapterId: { in: ids } },
            select: { mdChapterId: true },
          }),
          ctx.prisma.deletedChapter.findMany({
            where: { mdChapterId: { in: ids } },
            select: { mdChapterId: true },
          }),
        ]);
        const cardedIds = new Set(carded.map((r) => r.mdChapterId));
        const liveIds = new Set(live.map((r) => r.mdChapterId));
        const deletedIds = new Set(deleted.map((r) => r.mdChapterId));

        const rows = tasks
          .map((task) => {
            const mdChapterId = idOf(task);
            const chapter = rowOf(task.chapter);
            const outcome = !mdChapterId
              ? "unknown"
              : cardedIds.has(mdChapterId)
                ? "still-carded"
                : deletedIds.has(mdChapterId)
                  ? "gone"
                  : liveIds.has(mdChapterId)
                    ? "restored"
                    : "unknown";
            return {
              mdChapterId,
              outcome,
              taskState: task.state,
              attempt: task.attempt,
              lastError: task.lastError,
              at: task.updatedAt,
              extension: chapter["extensionName"] ?? null,
              mangaName: chapter["mangaName"] ?? null,
              mdMangaId: chapter["mdMangaId"] ?? null,
              chapterNumber: chapter["chapterNumber"] ?? null,
              chapterLanguage: chapter["chapterLanguage"] ?? null,
              chapterUrl: chapter["chapterUrl"] ?? null,
            };
          })
          .filter((row) => query.outcome === "all" || row.outcome === query.outcome);

        return {
          restores: rows,
          counts: {
            stillCarded: rows.filter((r) => r.outcome === "still-carded").length,
            restored: rows.filter((r) => r.outcome === "restored").length,
            gone: rows.filter((r) => r.outcome === "gone").length,
          },
          limit: query.limit,
        };
      },
    );

    scope.get("/api/v1/admin/chapters", { preHandler: requireScope("chapters:read") }, async (req) => {
      const query = parseOrThrow(
        z.object({
          archive: z.enum(CHAPTER_ARCHIVES).default("uploaded"),
          extension: z.string().max(64).optional(),
          language: z.string().max(16).optional(),
          mdMangaId: z.string().max(64).optional(),
          mdChapterId: z.string().max(64).optional(),
          chapterId: z.string().max(128).optional(),
          chapterNumber: z.string().max(32).optional(),
          search: z.string().min(1).max(256).optional(),
          since: z.coerce.date().optional(),
          until: z.coerce.date().optional(),
          limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(DEFAULT_PAGE),
          cursor: z.string().max(512).optional(),
          /**
           * Order the whole archive by one column, rather than the default
           * newest-first. The console's header buttons send this: sorting only
           * the rows already fetched would answer "the oldest of this page",
           * which is not what clicking a column header asks.
           */
          orderBy: z.enum(CHAPTER_SORTS).optional(),
          dir: z.enum(["asc", "desc"]).default("asc"),
        }),
        req.query ?? {},
      );

      // The cursor belongs to whichever ordering is in force, so only one of
      // the two decoders can be right; `orderBy` is what says which.
      const sort = query.orderBy
        ? { name: query.orderBy, dir: query.dir, cursor: query.cursor ?? null }
        : null;
      const cursor = !sort && query.cursor ? decodeChapterCursor(query.cursor) : null;
      if (!sort && query.cursor && !cursor) {
        throw Object.assign(new Error("invalid cursor: not a cursor this endpoint issued"), {
          statusCode: 400,
        });
      }

      const filter: ChapterFilter = {
        extension: query.extension,
        chapterLanguage: query.language,
        mdMangaId: query.mdMangaId,
        mdChapterId: query.mdChapterId,
        chapterId: query.chapterId,
        chapterNumber: query.chapterNumber,
        search: query.search,
        since: query.since,
        until: query.until,
      };

      const [page, totals] = await Promise.all([
        ctx.chapters.list(query.archive, filter, { limit: query.limit, cursor, sort }),
        ctx.chapters.totals(),
      ]);

      return {
        archive: query.archive,
        chapters: page.chapters,
        total: page.total,
        limit: query.limit,
        nextCursor: page.nextCursor,
        orderedBy: sort?.name ?? null,
        dir: query.dir,
        sortable: CHAPTER_SORTS,
        order: sort ? `${sort.name},id (${sort.dir}ending)` : "at,id (descending)",
        // Global rather than filtered, so a narrow filter cannot hide that an
        // extension has three hundred chapters marked unavailable.
        totals,
        archives: CHAPTER_ARCHIVES,
      };
    });

    /** Per-extension counts for one archive: the filter picker's contents. */
    scope.get(
      "/api/v1/admin/chapters/extensions",
      { preHandler: requireScope("chapters:read") },
      async (req) => {
        const { archive } = parseOrThrow(
          z.object({ archive: z.enum(CHAPTER_ARCHIVES).default("uploaded") }),
          req.query ?? {},
        );
        return { archive, extensions: await ctx.chapters.byExtension(archive) };
      },
    );

    /**
     * The series present in one archive, most-affected first.
     *
     * The counterpart to `/chapters/extensions`, for the axis an operator
     * actually arrives on when one title is wrong: "this series' cards are
     * stale" is the shape of the complaint, and a series-scoped re-card is the
     * answer to it. Answering here rather than by paging `/chapters` is the
     * difference between reading one row and reading every chapter of a title
     * to count them.
     */
    scope.get(
      "/api/v1/admin/chapters/series",
      { preHandler: requireScope("chapters:read") },
      async (req) => {
        const query = parseOrThrow(
          z
            .object({
              archive: z.enum(CHAPTER_ARCHIVES).default("uploaded"),
              extension: z.string().max(64).optional(),
              language: z.string().max(16).optional(),
              chapterNumber: z.string().max(32).optional(),
              search: z.string().min(1).max(256).optional(),
              limit: z.coerce.number().int().min(1).max(SERIES_LIMIT).default(100),
              offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
              /** One column, over every title matching: see `/chapters`. */
              orderBy: z.enum(SERIES_SORTS).optional(),
              dir: z.enum(["asc", "desc"]).default("asc"),
            })
            .strict(),
          req.query ?? {},
        );
        const page = await ctx.chapters.bySeries(
          query.archive,
          {
            extension: query.extension,
            chapterLanguage: query.language,
            chapterNumber: query.chapterNumber,
            search: query.search,
          },
          {
            limit: query.limit,
            offset: query.offset,
            column: query.orderBy ? { name: query.orderBy, dir: query.dir } : null,
          },
        );
        return {
          archive: query.archive,
          series: page.series,
          // Every title matching the filter, not just this page's worth. Paged
          // on an offset rather than a cursor because the ordering is an
          // aggregate over the whole set: there is no row-level key to resume
          // from, and a title's position only moves when its chapter count
          // does, which is not something that happens mid-scroll.
          total: page.total,
          limit: query.limit,
          offset: query.offset,
          orderedBy: query.orderBy ?? null,
          dir: query.dir,
          sortable: SERIES_SORTS,
          hasMore: query.offset + page.series.length < page.total,
        };
      },
    );

    /**
     * One chapter, everywhere it is recorded, plus what MangaDex says now and
     * anything already queued against it: what we think we published, what is
     * actually there, and whether a change is already in flight.
     */
    scope.get(
      "/api/v1/admin/chapters/:mdChapterId",
      { preHandler: requireScope("chapters:read") },
      async (req, reply) => {
        const { mdChapterId } = parseOrThrow(chapterParam, req.params);
        const [history, tasks, live] = await Promise.all([
          ctx.chapters.history(mdChapterId),
          ctx.uploadTasks.forDedupeKey(mdChapterId),
          liveChapter(mdChapterId),
        ]);

        const found = history.uploaded ?? history.unavailable ?? history.edited ?? history.deleted;
        if (!found) return reply.code(404).send({ error: "no chapter with that MangaDex id" });

        const attrs = live.detail?.attributes ?? null;
        return {
          mdChapterId,
          chapter: found,
          // Which tables hold it, so an inconsistency (deleted AND uploaded) is
          // visible rather than resolved silently by the lookup order above.
          archives: {
            uploaded: history.uploaded?.at ?? null,
            unavailable: history.unavailable?.at ?? null,
            deleted: history.deleted?.at ?? null,
            edited: history.edited?.at ?? null,
          },
          edits: history.edited?.edits ?? [],
          mangadex: attrs
            ? {
                id: mdChapterId,
                volume: attrs.volume,
                chapter: attrs.chapter,
                title: attrs.title,
                translatedLanguage: attrs.translatedLanguage,
                externalUrl: attrs.externalUrl,
                version: attrs.version,
                createdAt: attrs.createdAt,
                groups: (live.detail?.relationships ?? [])
                  .filter((rel) => rel.type === "scanlation_group")
                  .map((rel) => rel.id),
              }
            : null,
          mangadexError: live.error,
          /** Queue rows keyed on this chapter id, whatever their kind or state. */
          tasks,
          links: {
            chapter: `${MD_CHAPTER_URL}${mdChapterId}`,
            manga: found.mdMangaId ? `${MD_MANGA_URL}${found.mdMangaId}` : null,
            source: found.chapterUrl ?? null,
          },
          /** What a mutating call would be refused for, so the UI can say why first. */
          actionsBlockedReason: actionsBlockedReason(req, history.deleted !== null && !history.uploaded),
        };
      },
    );

    /**
     * The unavailable card as it would be posted, rendered now.
     *
     * Built by `unavailableCardOptions`, the same function the uploader calls,
     * from the live chapter when MangaDex is readable and from the stored row
     * otherwise. Nothing is written and nothing is queued.
     */
    scope.get(
      "/api/v1/admin/chapters/:mdChapterId/card.png",
      { preHandler: requireScope("chapters:read") },
      async (req, reply) => {
        const { mdChapterId } = parseOrThrow(chapterParam, req.params);
        const query = parseOrThrow(
          z.object({
            footerNote: z.string().max(600).optional(),
            unavailableAt: z.coerce.date().optional(),
          }),
          req.query ?? {},
        );

        const located = await locate(mdChapterId);
        if (!located) return reply.code(404).send({ error: "no chapter with that MangaDex id" });

        const { detail } = await liveChapter(mdChapterId);
        const png = await generateChapterCard(
          unavailableCardOptions({
            chapter: chapterOf(located.row),
            detail,
            unavailableAt: (query.unavailableAt ?? new Date()).toISOString(),
            footerNote: query.footerNote ?? null,
          }),
        );
        return reply
          .header("content-type", "image/png")
          // The server's global onSend already sets no-store; this restates it
          // for any intermediary that reads only one of them.
          .header("cache-control", "no-store, private")
          .send(png);
      },
    );

    // --------------------------------------------------------------- mutate

    /**
     * Queue an edit of the chapter's MangaDex metadata.
     *
     * The body carries only what should change; the uploader lays it over
     * whatever MangaDex currently holds and sends the whole resource, because
     * `PUT /chapter/{id}` replaces rather than patches. That merge happens at
     * execution time so MangaDex's `version` is the one current when the write
     * lands.
     *
     * `oldInfo` records what the fields looked like when the operator decided,
     * which is what makes the `edited_chapters` history readable afterwards.
     */
    scope.patch(
      "/api/v1/admin/chapters/:mdChapterId",
      { preHandler: [requireScope("chapters:write"), requireAdminRole] },
      async (req, reply) => {
        const { mdChapterId } = parseOrThrow(chapterParam, req.params);
        const body = parseOrThrow(EditPayload, req.body ?? {});
        if (Object.keys(body).length === 0) {
          return reply.code(400).send({
            error:
              "nothing to change: send at least one of volume, chapter, title, " +
              "translatedLanguage, groups or externalUrl",
          });
        }

        const located = await locate(mdChapterId);
        if (!located) return reply.code(404).send({ error: "no chapter with that MangaDex id" });
        const gone = goneReason(located);
        if (gone) return reply.code(409).send({ error: gone });

        const warnings: string[] = [];
        const payload: Record<string, unknown> = { ...body };

        if (body.translatedLanguage !== undefined) {
          const language = normaliseMangadexLanguage(body.translatedLanguage);
          if (!language) {
            return reply.code(400).send({
              error:
                `translatedLanguage ${JSON.stringify(body.translatedLanguage)} is not a language ` +
                `MangaDex accepts (expected e.g. "en", "ja", "pt-br")`,
            });
          }
          payload.translatedLanguage = language;
        }

        if (body.externalUrl !== undefined && body.externalUrl !== null && body.externalUrl !== "") {
          const url = body.externalUrl.trim();
          let parsed: URL;
          try {
            parsed = new URL(url);
          } catch {
            return reply.code(400).send({ error: "externalUrl is not a valid absolute URL" });
          }
          if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
            return reply
              .code(400)
              .send({ error: `externalUrl scheme ${parsed.protocol} is not allowed (http or https only)` });
          }
          // A host outside the manifest allowlist warns rather than refuses,
          // because a publisher legitimately moves domains and only the person
          // typing it can judge that. The refusal case (routes/ops.ts,
          // links.raw on a title) is a field we own outright.
          const manifest = await manifestFor(located.row.extension);
          if (manifest && !hostAllowed(url, manifest.allowed_hosts)) {
            warnings.push(
              `${parsed.host} is not in ${located.row.extension}'s allowed_hosts ` +
                `(${manifest.allowed_hosts.join(", ")})`,
            );
          }
          payload.externalUrl = url;
        }

        // What the fields look like now, preferring MangaDex over our mirror:
        // the history is only worth keeping if "old" is what was really there.
        const { detail } = await liveChapter(mdChapterId);
        const attrs = detail?.attributes;
        const oldInfo: Record<string, unknown> = {};
        for (const field of Object.keys(payload)) {
          if (field === "groups") {
            oldInfo.groups = detail
              ? detail.relationships.filter((rel) => rel.type === "scanlation_group").map((rel) => rel.id)
              : located.row.mdGroupId
                ? [located.row.mdGroupId]
                : null;
          } else if (field === "chapter") {
            oldInfo.chapter = attrs?.chapter ?? located.row.chapterNumber ?? null;
          } else if (field === "volume") {
            oldInfo.volume = attrs?.volume ?? located.row.chapterVolume ?? null;
          } else if (field === "title") {
            oldInfo.title = attrs?.title ?? located.row.chapterTitle ?? null;
          } else if (field === "translatedLanguage") {
            oldInfo.translatedLanguage = attrs?.translatedLanguage ?? located.row.chapterLanguage ?? null;
          } else if (field === "externalUrl") {
            oldInfo.externalUrl = attrs?.externalUrl ?? located.row.chapterUrl ?? null;
          }
        }

        return queueAction(req, reply, {
          kind: "EDIT",
          row: located.row,
          sidecars: { payload, oldInfo },
          audit: "chapter.edit",
          auditDetail: { payload, oldInfo, archive: located.archive },
          warnings,
        });
      },
    );

    /**
     * Queue "replace this chapter with an unavailable card": render the card,
     * attach it as the chapter's only page through an edit session, repoint
     * `externalUrl` away from the dead publisher link, and archive the row into
     * `unavailable_chapters`.
     *
     * `force` makes this repeatable. Without it an already-carded chapter is a
     * no-op, which is correct for the automated pass and useless for an operator
     * replacing a card that says the wrong thing, so it is refused with the flag
     * it needs rather than silently doing nothing.
     */
    scope.post(
      "/api/v1/admin/chapters/:mdChapterId/unavailable",
      { preHandler: [requireScope("chapters:write"), requireAdminRole] },
      async (req, reply) => {
        const { mdChapterId } = parseOrThrow(chapterParam, req.params);
        const body = parseOrThrow(
          z.object({
            force: z.boolean().default(false),
            footerNote: z.string().max(600).optional(),
          }),
          req.body ?? {},
        );

        const located = await locate(mdChapterId);
        if (!located) return reply.code(404).send({ error: "no chapter with that MangaDex id" });
        const gone = goneReason(located);
        if (gone) return reply.code(409).send({ error: gone });

        const already = await ctx.chapters.get("unavailable", mdChapterId);
        if (already && !body.force) {
          return reply.code(409).send({
            error:
              `this chapter was already marked unavailable on ${already.at.toISOString()}; ` +
              "pass force: true to render and post a fresh card over the old one",
            outcome: "already_unavailable",
            unavailableAt: already.at,
          });
        }

        return queueAction(req, reply, {
          kind: "UNAVAILABLE",
          row: located.row,
          sidecars: {
            unavailableAt: new Date().toISOString(),
            ...(body.force ? { force: true } : {}),
            ...(body.footerNote ? { footerNote: body.footerNote } : {}),
          },
          audit: "chapter.unavailable",
          auditDetail: {
            force: body.force,
            footerNote: body.footerNote ?? null,
            archive: located.archive,
            regenerated: already !== null,
          },
        });
      },
    );

    /**
     * Queue a hard delete from MangaDex: the one irreversible action the
     * platform takes. Hence `confirm: true`, the admin role, a full audit row,
     * and an archive write to `deleted_chapters` in the uploader before the live
     * row is dropped.
     *
     * Marking a chapter unavailable is nearly always the better answer, which is
     * what the `alternative` field says on every refusal for want of `confirm`.
     */
    scope.delete(
      "/api/v1/admin/chapters/:mdChapterId",
      { preHandler: [requireScope("chapters:write"), requireAdminRole] },
      async (req, reply) => {
        const { mdChapterId } = parseOrThrow(chapterParam, req.params);
        const options = parseOrThrow(
          z.object({ confirm: Flag.optional(), reason: z.string().max(500).optional() }),
          { ...(req.query as Record<string, unknown>), ...(req.body as Record<string, unknown>) },
        );
        if (options.confirm !== true) {
          return reply.code(400).send({
            error:
              "deleting a chapter from MangaDex cannot be undone; pass confirm: true",
            alternative:
              "POST /api/v1/admin/chapters/{id}/unavailable keeps the entry and replaces its page " +
              "with a card explaining that the publisher removed it",
          });
        }

        const located = await locate(mdChapterId);
        if (!located) return reply.code(404).send({ error: "no chapter with that MangaDex id" });
        const gone = goneReason(located);
        if (gone) return reply.code(409).send({ error: gone });

        return queueAction(req, reply, {
          kind: "DELETE",
          row: located.row,
          sidecars: {},
          audit: "chapter.delete",
          auditDetail: {
            reason: options.reason ?? null,
            archive: located.archive,
            // The whole row: after the uploader runs, `deleted_chapters` and
            // this audit entry are the only records that the chapter existed.
            chapter: located.row,
          },
        });
      },
    );

    // ----------------------------------------------------------------- bulk

    /**
     * The same three actions over a set of chapters, named either by `ids` (an
     * enumeration the operator built) or by `filter` (a description, which can
     * match more than whoever wrote it imagined). So:
     *
     *  - `dryRun` defaults to TRUE. A live run needs `dryRun: false` and
     *    `confirm: true`, two fields that cannot both be set by accident.
     *  - The cap is 200 per call, applied inside id resolution, so an over-wide
     *    filter cannot become an unbounded read on its way to an unbounded write.
     *
     * The dry run resolves the same rows and checks the same refusals, so it is
     * a preview rather than an estimate. The live path still does not
     * read-then-write: every insert is the same guarded upsert, and a chapter
     * whose state changed between preview and write comes back refused.
     */
    interface BulkItem {
      mdChapterId: string;
      ok: boolean;
      outcome:
        | "queued"
        | "requeued"
        | "would_queue"
        | "already_queued"
        | "leased"
        | "not_found"
        | "deleted"
        | "needs_force"
        | "invalid";
      taskId?: string;
      reason?: string;
      /** Enough to recognise the row in a preview without a second request. */
      mangaName?: string | null;
      chapterNumber?: string | null;
      chapterLanguage?: string | null;
      extension?: string | null;
    }

    const BulkFilter = z
      .object({
        archive: z.enum(CHAPTER_ARCHIVES).default("uploaded"),
        extension: z.string().max(64).optional(),
        language: z.string().max(16).optional(),
        mdMangaId: z.string().max(64).optional(),
        chapterNumber: z.string().max(32).optional(),
        search: z.string().min(1).max(256).optional(),
        since: z.coerce.date().optional(),
        until: z.coerce.date().optional(),
      })
      .strict();

    /** `ids` XOR `filter`, plus the two flags every bulk body carries. */
    const bulkBody = <T extends z.ZodRawShape>(extra: T) =>
      z
        .object({
          ids: z.array(MdChapterId).min(1).max(CHAPTER_BULK_CAP).optional(),
          filter: BulkFilter.optional(),
          dryRun: z.boolean().default(true),
          confirm: z.boolean().default(false),
          ...extra,
        })
        .strict()
        .refine((value) => (value.ids ? 1 : 0) + (value.filter ? 1 : 0) === 1, {
          message: "provide exactly one of `ids` or `filter`",
        });

    function toBulkFilter(filter: z.infer<typeof BulkFilter>): ChapterFilter {
      return {
        extension: filter.extension,
        chapterLanguage: filter.language,
        mdMangaId: filter.mdMangaId,
        chapterNumber: filter.chapterNumber,
        search: filter.search,
        since: filter.since,
        until: filter.until,
      };
    }

    /**
     * Locate many chapters at once, by the same archive precedence as `locate`.
     * Four queries whatever the size of the set, where the per-chapter `locate`
     * would be four each.
     */
    async function locateMany(
      ids: readonly string[],
    ): Promise<Map<string, { archive: ChapterArchive; row: ChapterRow }>> {
      const found = new Map<string, { archive: ChapterArchive; row: ChapterRow }>();
      // Reverse precedence order: later writes win, so `uploaded` (last) beats
      // `deleted` (first) for a chapter that is somehow in both.
      for (const archive of ["deleted", "edited", "unavailable", "uploaded"] as const) {
        for (const row of await ctx.chapters.manyByIds(archive, ids)) {
          found.set(row.mdChapterId, { archive, row });
        }
      }
      return found;
    }

    async function runBulk(
      req: FastifyRequest,
      reply: FastifyReply,
      opts: {
        kind: "EDIT" | "DELETE" | "UNAVAILABLE" | "RESTORE";
        body: { ids?: string[]; filter?: z.infer<typeof BulkFilter>; dryRun: boolean; confirm: boolean };
        /** Per-chapter task sidecars. Constant across the set by construction. */
        sidecars: Record<string, unknown>;
        /** UNAVAILABLE only: re-card chapters that already carry one. */
        force?: boolean;
        auditAction: string;
        auditDetail: Record<string, unknown>;
      },
    ): Promise<FastifyReply> {
      const { kind, body } = opts;
      // RESTORE selects from the carded chapters by definition, so a filter
      // that does not say otherwise means "the unavailable ones". Defaulting it
      // to `uploaded` like the other verbs would silently match nothing.
      const archive = body.filter?.archive ?? (opts.kind === "RESTORE" ? "unavailable" : "uploaded");

      let ids: string[];
      let capped = false;
      let matched: number;
      if (body.ids) {
        ids = [...new Set(body.ids)];
        matched = ids.length;
      } else {
        const filter = toBulkFilter(body.filter!);
        const resolved = await ctx.chapters.idsMatching(archive, filter, CHAPTER_BULK_CAP + 1);
        capped = resolved.length > CHAPTER_BULK_CAP;
        ids = resolved.slice(0, CHAPTER_BULK_CAP);
        matched = await ctx.chapters.countMatching(archive, filter);
      }

      const [located, unavailableRows, queued] = await Promise.all([
        locateMany(ids),
        // Only the UNAVAILABLE path needs this: `locate` may have resolved the
        // chapter from `uploaded`, which does not answer whether a card is
        // already posted.
        // RESTORE needs it for the opposite test: UNAVAILABLE refuses a chapter
        // that is already carded, RESTORE refuses one that is not.
        opts.kind === "UNAVAILABLE" || opts.kind === "RESTORE"
          ? ctx.chapters.manyByIds("unavailable", ids)
          : Promise.resolve([]),
        ctx.uploadTasks.forDedupeKeys(ids),
      ]);
      const alreadyUnavailable = new Set(unavailableRows.map((row) => row.mdChapterId));
      const taskByChapter = new Map(
        queued.filter((task) => task.kind === kind).map((task) => [task.dedupeKey, task]),
      );

      /** The refusal for one chapter, or null when the write should be tried. */
      const blockedReason = (id: string): { outcome: BulkItem["outcome"]; reason: string } | null => {
        const hit = located.get(id);
        if (!hit) return { outcome: "not_found", reason: "no chapter with that MangaDex id" };
        if (hit.archive === "deleted") return { outcome: "deleted", reason: DELETED_REASON };
        if (kind === "UNAVAILABLE" && alreadyUnavailable.has(id) && !opts.force) {
          return {
            outcome: "needs_force",
            reason: "already marked unavailable; pass force: true to post a fresh card over the old one",
          };
        }
        // Restoring a chapter that was never carded would open an edit session
        // to change nothing. Refused here rather than discovered by the worker,
        // so a filter that selected too much is visible in the dry run.
        if (kind === "RESTORE" && !alreadyUnavailable.has(id)) {
          return {
            outcome: "not_found",
            reason: "this chapter is not marked unavailable, so it has no card to remove",
          };
        }
        const task = taskByChapter.get(id);
        if (task?.state === "LEASED") {
          return { outcome: "leased", reason: `an uploader is executing a ${kind} for this chapter now` };
        }
        if (task?.state === "PENDING") {
          return { outcome: "already_queued", reason: `a ${kind} for this chapter is already queued` };
        }
        return null;
      };

      const describe = (id: string): Partial<BulkItem> => {
        const row = located.get(id)?.row;
        return row
          ? {
              mangaName: row.mangaName ?? null,
              chapterNumber: row.chapterNumber ?? null,
              chapterLanguage: row.chapterLanguage ?? null,
              extension: row.extension ?? null,
            }
          : {};
      };

      // ---- dry run: predict, write nothing, audit nothing ----
      if (body.dryRun) {
        const results: BulkItem[] = ids.map((id) => {
          const blocked = blockedReason(id);
          return blocked
            ? { mdChapterId: id, ok: false, ...blocked, ...describe(id) }
            : { mdChapterId: id, ok: true, outcome: "would_queue", ...describe(id) };
        });
        return reply.send({
          dryRun: true,
          action: kind,
          matched,
          resolved: ids.length,
          wouldQueue: results.filter((item) => item.ok).length,
          blocked: results.filter((item) => !item.ok).length,
          capped,
          cap: CHAPTER_BULK_CAP,
          breakdown: body.filter
            ? await ctx.chapters.byExtension(archive, toBulkFilter(body.filter))
            : undefined,
          results,
          note:
            "nothing was changed and nothing was queued. Repeat with {dryRun: false, confirm: true} " +
            "to queue exactly this set" +
            (capped ? `, ${CHAPTER_BULK_CAP} chapters at a time` : ""),
        });
      }

      if (!body.confirm) {
        return reply.code(400).send({
          error: "a live bulk action needs confirm: true alongside dryRun: false",
          wouldQueue: ids.filter((id) => blockedReason(id) === null).length,
        });
      }

      // ---- live: one guarded upsert per chapter ----
      const bulkId = randomUUID();
      const results: BulkItem[] = [];
      const auditRows: { actor: string; action: string; subject: string; detail: unknown }[] = [];
      const who = actor(req);
      const lostRace: string[] = [];

      for (const id of ids) {
        const blocked = blockedReason(id);
        if (blocked) {
          results.push({ mdChapterId: id, ok: false, ...blocked, ...describe(id) });
          continue;
        }
        const row = located.get(id)!.row;
        const chapter = chapterOf(row);
        const payload: Record<string, unknown> = {
          ...chapterToTaskPayload(chapter as unknown as Record<string, unknown>, chapter.imageArtifacts),
          ...opts.sidecars,
        };
        const problems = manualTaskProblems(kind, payload);
        const dedupeKey = taskDedupeKey(kind, chapter);
        if (problems.length > 0 || dedupeKey === null) {
          results.push({
            mdChapterId: id,
            ok: false,
            outcome: "invalid",
            reason: problems[0] ?? "cannot derive a queue key for this chapter",
            ...describe(id),
          });
          continue;
        }

        const created = await ctx.uploadTasks.requeueForChapter(kind, dedupeKey, payload);
        if (!created) {
          // The row moved between the prediction and this statement. The write
          // was still guarded, so nothing was clobbered; name it afterwards.
          lostRace.push(id);
          results.push({
            mdChapterId: id,
            ok: false,
            outcome: "already_queued",
            reason: "a task for this chapter was queued or claimed while this batch was running",
            ...describe(id),
          });
          continue;
        }
        results.push({
          mdChapterId: id,
          ok: true,
          outcome: created.superseded ? "requeued" : "queued",
          taskId: created.task.id,
          ...describe(id),
        });
        // Per chapter, so "who changed this one, and why?" stays answerable by
        // subject; a batch that wrote only a summary row would not answer it.
        auditRows.push({
          actor: who,
          action: opts.auditAction,
          subject: id,
          detail: {
            ...opts.auditDetail,
            bulk: bulkId,
            extension: row.extension,
            mdMangaId: row.mdMangaId,
            chapterNumber: row.chapterNumber,
            chapterLanguage: row.chapterLanguage,
            taskId: created.task.id,
            supersededCompletedTask: created.superseded,
            ...(kind === "DELETE" ? { chapter: row } : {}),
          },
        });
      }

      if (lostRace.length > 0) {
        // One query, purely to replace a generic message with the real state.
        const now = await ctx.uploadTasks.forDedupeKeys(lostRace);
        const byChapter = new Map(
          now.filter((task) => task.kind === kind).map((task) => [task.dedupeKey, task]),
        );
        for (const item of results) {
          const task = byChapter.get(item.mdChapterId);
          if (!task || item.ok) continue;
          if (task.state === "LEASED") {
            item.outcome = "leased";
            item.reason = `an uploader claimed a ${kind} for this chapter while this batch was running`;
          }
        }
      }

      const queuedCount = results.filter((item) => item.ok).length;
      await ctx.audit.recordMany([
        ...auditRows,
        {
          actor: who,
          action: `${opts.auditAction}.bulk`,
          subject: bulkId,
          detail: {
            ...opts.auditDetail,
            bulk: bulkId,
            requested: ids.length,
            queued: queuedCount,
            refused: results.length - queuedCount,
            capped,
            ...(body.filter ? { filter: body.filter } : { ids }),
          },
        },
      ]);

      // 200, not 202: a batch where eight chapters queued and two were refused is
      // a success and a partial failure at once, and only the per-chapter results
      // say which is which.
      return reply.send({
        ok: true,
        dryRun: false,
        action: kind,
        bulk: bulkId,
        matched,
        requested: ids.length,
        queued: queuedCount,
        refused: results.length - queuedCount,
        capped,
        ...(capped
          ? { cap: CHAPTER_BULK_CAP, note: `more chapters matched than the ${CHAPTER_BULK_CAP}-chapter cap; call again` }
          : {}),
        results,
      });
    }

    /**
     * Bulk edit. The fields are a subset of the single-chapter edit: volume,
     * language and groups are properties a set of chapters can legitimately
     * share, while title, chapter number and external URL are one chapter's
     * identity.
     *
     * `oldInfo` comes from our own rows rather than a live MangaDex read: two
     * hundred chapter reads would be slower than the batch and would spend the
     * ratelimit the uploader needs. The uploader still merges against the live
     * resource when it runs, so only the recorded "old" is our mirror's view.
     */
    scope.post(
      "/api/v1/admin/chapters/bulk/edit",
      { preHandler: [requireScope("chapters:write"), requireAdminRole] },
      async (req, reply) => {
        const body = parseOrThrow(bulkBody({ changes: BulkEditPayload }), req.body ?? {});
        if (Object.keys(body.changes).length === 0) {
          return reply.code(400).send({
            error: "nothing to change: send at least one of volume, translatedLanguage or groups",
            note:
              "title, chapter number and externalUrl are per-chapter identity and are only editable " +
              "one chapter at a time",
          });
        }

        const changes: Record<string, unknown> = { ...body.changes };
        if (body.changes.translatedLanguage !== undefined) {
          const language = normaliseMangadexLanguage(body.changes.translatedLanguage);
          if (!language) {
            return reply.code(400).send({
              error:
                `translatedLanguage ${JSON.stringify(body.changes.translatedLanguage)} is not a ` +
                `language MangaDex accepts (expected e.g. "en", "ja", "pt-br")`,
            });
          }
          changes.translatedLanguage = language;
        }

        return runBulk(req, reply, {
          kind: "EDIT",
          body,
          sidecars: { payload: changes, oldInfo: null },
          auditAction: "chapter.edit",
          auditDetail: { payload: changes, bulkKind: "edit" },
        });
      },
    );

    /** Bulk "replace with an unavailable card", including regenerating cards. */
    scope.post(
      "/api/v1/admin/chapters/bulk/unavailable",
      { preHandler: [requireScope("chapters:write"), requireAdminRole] },
      async (req, reply) => {
        const body = parseOrThrow(
          bulkBody({ force: z.boolean().default(false), footerNote: z.string().max(600).optional() }),
          req.body ?? {},
        );
        return runBulk(req, reply, {
          kind: "UNAVAILABLE",
          body,
          force: body.force,
          sidecars: {
            unavailableAt: new Date().toISOString(),
            ...(body.force ? { force: true } : {}),
            ...(body.footerNote ? { footerNote: body.footerNote } : {}),
          },
          auditAction: "chapter.unavailable",
          auditDetail: { force: body.force, footerNote: body.footerNote ?? null, bulkKind: "unavailable" },
        });
      },
    );

    /**
     * Take the card back off, leaving an ordinary external chapter.
     *
     * The counterpart to `bulk/unavailable`, and until now it did not exist:
     * carding was one-way, because `findExtraChapters` skips anything already
     * carded so nothing ever revisited one. A chapter carded by mistake stayed
     * carded, which is how 213 live RuriDragon chapters ended up under "no
     * longer available on the publisher" with a working link beneath it.
     *
     * The card image is removed and `externalUrl` is kept, since it is the
     * chapter's only remaining way to reach the publisher. `externalUrl` in the
     * body overrides it, for the case where the stored link is the one that was
     * wrong.
     */
    scope.post(
      "/api/v1/admin/chapters/bulk/restore",
      { preHandler: [requireScope("chapters:write"), requireAdminRole] },
      async (req, reply) => {
        const body = parseOrThrow(
          bulkBody({
            externalUrl: z.string().url().max(2048).optional(),
            reason: z.string().max(500).optional(),
          }),
          req.body ?? {},
        );
        return runBulk(req, reply, {
          kind: "RESTORE",
          body,
          sidecars: {
            ...(body.externalUrl ? { externalUrl: body.externalUrl } : {}),
          },
          auditAction: "chapter.restore",
          auditDetail: {
            reason: body.reason ?? null,
            externalUrl: body.externalUrl ?? null,
            bulkKind: "restore",
          },
        });
      },
    );

    // ------------------------------------------------- re-card the unavailable

    /**
     * Re-render the card image on chapters that ALREADY carry one.
     *
     * Marking a chapter unavailable and re-carding it queue the same
     * UNAVAILABLE task, but they are different operator verbs and reading them
     * as one produced two wrong answers:
     *
     *  - `POST /chapters/bulk/unavailable` stamps every card with `new Date()`,
     *    which is correct when the chapter is going unavailable now and wrong
     *    when it went unavailable in March; a re-card through it would silently
     *    rewrite the "available until" line on a year-old page. Here the date
     *    comes from the archive row, so the card still says when the publisher
     *    actually pulled the chapter.
     *  - the bulk cap is 200 with no continuation, and its ordering is
     *    `unavailable_at DESC` — the very column the uploader rewrites as it
     *    archives. "Re-card everything" through it re-cards the newest 200 for
     *    ever and never reaches the rest. This pages on the primary key and
     *    returns `nextAfterId`, so a sweep terminates.
     *
     * Otherwise it is the bulk contract: `ids` XOR `filter`, dry run by default,
     * a live run needs `dryRun: false` and `confirm: true`, one guarded upsert
     * per chapter, one audit row per chapter plus a summary.
     *
     * `filter: {}` means every unavailable chapter, which is the point of the
     * endpoint and is why the filter is required-but-emptiable rather than
     * defaulted: "re-card everything" has to be typed, not fallen into.
     */
    const RECARD_BATCH_CAP = 200;

    const RecardFilter = z
      .object({
        extension: z.string().max(64).optional(),
        language: z.string().max(16).optional(),
        mdMangaId: z.string().max(64).optional(),
        chapterNumber: z.string().max(32).optional(),
        search: z.string().min(1).max(256).optional(),
        since: z.coerce.date().optional(),
        until: z.coerce.date().optional(),
      })
      .strict();

    interface RecardItem {
      mdChapterId: string;
      ok: boolean;
      outcome:
        | "queued"
        | "requeued"
        | "would_queue"
        | "already_queued"
        | "leased"
        | "not_found"
        | "deleted"
        | "not_unavailable"
        | "invalid";
      taskId?: string;
      reason?: string;
      mangaName?: string | null;
      chapterNumber?: string | null;
      chapterLanguage?: string | null;
      extension?: string | null;
      /** When the chapter was archived; the date its fresh card will carry. */
      unavailableAt?: string;
    }

    scope.post(
      "/api/v1/admin/chapters/unavailable/recard",
      { preHandler: [requireScope("chapters:write"), requireAdminRole] },
      async (req, reply) => {
        const body = parseOrThrow(
          z
            .object({
              ids: z.array(MdChapterId).min(1).max(RECARD_BATCH_CAP).optional(),
              filter: RecardFilter.optional(),
              footerNote: z.string().max(600).optional(),
              dryRun: z.boolean().default(true),
              confirm: z.boolean().default(false),
              /** Continuation from a previous page's `nextAfterId`. */
              afterId: z.string().max(64).optional(),
              batch: z.number().int().min(1).max(RECARD_BATCH_CAP).default(RECARD_BATCH_CAP),
            })
            .strict()
            .refine((value) => (value.ids ? 1 : 0) + (value.filter ? 1 : 0) === 1, {
              message:
                "provide exactly one of `ids` or `filter` (`filter: {}` means every unavailable chapter)",
            })
            .refine((value) => !(value.ids && value.afterId), {
              message: "`afterId` continues a filter sweep; an explicit `ids` list has nothing to continue",
            }),
          req.body ?? {},
        );

        const filter: ChapterFilter | null = body.filter
          ? {
              extension: body.filter.extension,
              chapterLanguage: body.filter.language,
              mdMangaId: body.filter.mdMangaId,
              chapterNumber: body.filter.chapterNumber,
              search: body.filter.search,
              since: body.filter.since,
              until: body.filter.until,
            }
          : null;

        let ids: string[];
        let nextAfterId: string | null = null;
        let matched: number;
        if (body.ids) {
          ids = [...new Set(body.ids)];
          matched = ids.length;
        } else {
          const page = await ctx.chapters.idsForSweep(
            "unavailable",
            filter!,
            body.batch,
            body.afterId ?? null,
          );
          ids = page.ids;
          nextAfterId = page.nextAfterId;
          matched = await ctx.chapters.countMatching("unavailable", filter!);
        }

        // The unavailable archive answers "does this chapter have a card to
        // replace?"; `locateMany` answers "is it recorded as deleted?", which is
        // the one state where re-carding is meaningless.
        const [located, unavailableRows, queued] = await Promise.all([
          locateMany(ids),
          ctx.chapters.manyByIds("unavailable", ids),
          ctx.uploadTasks.forDedupeKeys(ids),
        ]);
        const archived = new Map(unavailableRows.map((row) => [row.mdChapterId, row]));
        const taskByChapter = new Map(
          queued.filter((task) => task.kind === "UNAVAILABLE").map((task) => [task.dedupeKey, task]),
        );

        const blockedReason = (id: string): { outcome: RecardItem["outcome"]; reason: string } | null => {
          const hit = located.get(id);
          if (!hit) return { outcome: "not_found", reason: "no chapter with that MangaDex id" };
          if (hit.archive === "deleted") return { outcome: "deleted", reason: DELETED_REASON };
          if (!archived.has(id)) {
            return {
              outcome: "not_unavailable",
              reason:
                "this chapter has no card to replace; use Mark unavailable, which posts the first one",
            };
          }
          const task = taskByChapter.get(id);
          if (task?.state === "LEASED") {
            return {
              outcome: "leased",
              reason: "an uploader is executing an UNAVAILABLE for this chapter now",
            };
          }
          if (task?.state === "PENDING") {
            return {
              outcome: "already_queued",
              reason: "an UNAVAILABLE for this chapter is already queued",
            };
          }
          return null;
        };

        const describe = (id: string): Partial<RecardItem> => {
          const row = archived.get(id) ?? located.get(id)?.row;
          return row
            ? {
                mangaName: row.mangaName ?? null,
                chapterNumber: row.chapterNumber ?? null,
                chapterLanguage: row.chapterLanguage ?? null,
                extension: row.extension ?? null,
                ...(archived.has(id) ? { unavailableAt: row.at.toISOString() } : {}),
              }
            : {};
        };

        // ---- dry run: predict, write nothing, audit nothing ----
        if (body.dryRun) {
          const preview: RecardItem[] = ids.map((id) => {
            const blocked = blockedReason(id);
            return blocked
              ? { mdChapterId: id, ok: false, ...blocked, ...describe(id) }
              : { mdChapterId: id, ok: true, outcome: "would_queue", ...describe(id) };
          });
          return reply.send({
            dryRun: true,
            action: "RECARD",
            matched,
            resolved: ids.length,
            wouldQueue: preview.filter((item) => item.ok).length,
            blocked: preview.filter((item) => !item.ok).length,
            batch: body.batch,
            nextAfterId,
            breakdown: filter ? await ctx.chapters.byExtension("unavailable", filter) : undefined,
            results: preview,
            note:
              "nothing was changed and nothing was queued. Repeat with {dryRun: false, confirm: true} " +
              "to queue exactly this set" +
              (nextAfterId ? ", then repeat with afterId for the rest" : ""),
          });
        }

        if (!body.confirm) {
          return reply.code(400).send({
            error: "a live re-card needs confirm: true alongside dryRun: false",
            wouldQueue: ids.filter((id) => blockedReason(id) === null).length,
          });
        }

        // ---- live: one guarded upsert per chapter ----
        const sweepId = randomUUID();
        const results: RecardItem[] = [];
        const auditRows: { actor: string; action: string; subject: string; detail: unknown }[] = [];
        const who = actor(req);

        for (const id of ids) {
          const blocked = blockedReason(id);
          if (blocked) {
            results.push({ mdChapterId: id, ok: false, ...blocked, ...describe(id) });
            continue;
          }
          const row = archived.get(id)!;
          const chapter = chapterOf(row);
          const payload: Record<string, unknown> = {
            ...chapterToTaskPayload(
              chapter as unknown as Record<string, unknown>,
              chapter.imageArtifacts,
            ),
            // The archive row's own instant, not now: this chapter went
            // unavailable when it went unavailable, and the card prints it.
            unavailableAt: row.at.toISOString(),
            // Without `force` the uploader recognises its own card and archives
            // the chapter again without touching the page, which is the exact
            // no-op this endpoint exists to get past.
            force: true,
            ...(body.footerNote ? { footerNote: body.footerNote } : {}),
          };
          const problems = manualTaskProblems("UNAVAILABLE", payload);
          const dedupeKey = taskDedupeKey("UNAVAILABLE", chapter);
          if (problems.length > 0 || dedupeKey === null) {
            results.push({
              mdChapterId: id,
              ok: false,
              outcome: "invalid",
              reason: problems[0] ?? "cannot derive a queue key for this chapter",
              ...describe(id),
            });
            continue;
          }

          const created = await ctx.uploadTasks.requeueForChapter("UNAVAILABLE", dedupeKey, payload);
          if (!created) {
            results.push({
              mdChapterId: id,
              ok: false,
              outcome: "already_queued",
              reason: "a task for this chapter was queued or claimed while this sweep was running",
              ...describe(id),
            });
            continue;
          }
          results.push({
            mdChapterId: id,
            ok: true,
            outcome: created.superseded ? "requeued" : "queued",
            taskId: created.task.id,
            ...describe(id),
          });
          auditRows.push({
            actor: who,
            action: "chapter.unavailable.recard",
            subject: id,
            detail: {
              sweep: sweepId,
              footerNote: body.footerNote ?? null,
              unavailableAt: row.at.toISOString(),
              extension: row.extension,
              mdMangaId: row.mdMangaId,
              chapterNumber: row.chapterNumber,
              chapterLanguage: row.chapterLanguage,
              taskId: created.task.id,
              supersededCompletedTask: created.superseded,
            },
          });
        }

        const queuedCount = results.filter((item) => item.ok).length;
        await ctx.audit.recordMany([
          ...auditRows,
          {
            actor: who,
            action: "chapter.unavailable.recard.sweep",
            subject: sweepId,
            detail: {
              sweep: sweepId,
              requested: ids.length,
              queued: queuedCount,
              refused: results.length - queuedCount,
              footerNote: body.footerNote ?? null,
              ...(filter
                ? { filter: body.filter, afterId: body.afterId ?? null, nextAfterId }
                : { ids }),
            },
          },
        ]);

        return reply.send({
          ok: true,
          dryRun: false,
          action: "RECARD",
          sweep: sweepId,
          matched,
          requested: ids.length,
          queued: queuedCount,
          refused: results.length - queuedCount,
          // Null once the sweep has reached the end of the archive; until then
          // the caller repeats with it to continue where this page stopped.
          nextAfterId,
          results,
          note: "core-uploader drains this queue; watch it under Queues, filtered by UNAVAILABLE.",
        });
      },
    );

    /**
     * Bulk delete. Nothing extra guards it beyond what the other two have: the
     * existing guards are already the strongest here (ADMIN role, no api tokens,
     * dry-run-by-default, an explicit confirm, a 200-chapter cap, the whole row
     * in the audit trail per chapter), and a fourth flag would train operators to
     * set flags without reading them. The dry run names every chapter it would
     * remove.
     */
    scope.post(
      "/api/v1/admin/chapters/bulk/delete",
      { preHandler: [requireScope("chapters:write"), requireAdminRole] },
      async (req, reply) => {
        const body = parseOrThrow(bulkBody({ reason: z.string().max(500).optional() }), req.body ?? {});
        return runBulk(req, reply, {
          kind: "DELETE",
          body,
          sidecars: {},
          auditAction: "chapter.delete",
          auditDetail: { reason: body.reason ?? null, bulkKind: "delete" },
        });
      },
    );

    /**
     * Ask the publisher whether one series' chapters are still there.
     *
     * The re-card route above re-renders a card for a chapter already known to
     * be gone. This is the question before that one: *is* it gone? Answering it
     * means reading the publisher, which happens on a worker running the
     * extension, so this does not answer — it starts a run that will.
     *
     * The run is scoped: one CLEAN job whose `segmentMangaIds` is this series'
     * external id. CLEAN because that is the contract's way of asking for a
     * full catalogue listing (`allChapters`), which is the only thing removal
     * detection can be computed from — an extension that reports only its
     * updates can never say that something is missing. Scoped because the
     * processor must not read the resulting snapshot as a statement about the
     * whole catalogue; `runs.scope_manga_ids` is what tells it so, and without
     * that flag this endpoint would unpublish every title the run never asked
     * about.
     *
     * From there nothing here is new: the processor diffs the publisher's
     * listing against what MangaDex holds under our group and queues the
     * difference, as `UNAVAILABLE` or `DELETE` per the removal mode — the same
     * pass, and the same guards, that a scheduled run uses.
     */
    scope.post(
      "/api/v1/admin/chapters/series/:mdMangaId/recheck",
      { preHandler: requireScope("runs:write") },
      async (req, reply) => {
        const { mdMangaId } = parseOrThrow(z.object({ mdMangaId: z.string().uuid() }), req.params);
        const body = parseOrThrow(
          z
            .object({
              extension: z.string().max(64).optional(),
              dryRun: z.boolean().default(true),
              confirm: z.boolean().default(false),
              idempotencyKey: z.string().max(256).optional(),
            })
            .strict(),
          req.body ?? {},
        );

        // The tracked map is the only thing that knows a MangaDex title by the
        // publisher's name for it, which is the name the extension answers to.
        const tracked = await ctx.prisma.trackedManga.findMany({
          where: { mdMangaId, ...(body.extension ? { extension: body.extension } : {}) },
          select: { extension: true, namespace: true, mangaId: true },
        });
        if (tracked.length === 0) {
          return reply.code(404).send({
            error: body.extension
              ? `${body.extension} does not track that MangaDex title`
              : "no extension tracks that MangaDex title, so nothing can be asked about it",
            mdMangaId,
          });
        }
        // Two extensions publishing the same title is legitimate, and each
        // holds its own answer; picking one for the operator would re-check a
        // publisher they did not mean.
        const extensions = [...new Set(tracked.map((row) => row.extension))];
        if (extensions.length > 1) {
          return reply.code(409).send({
            error: "more than one extension tracks that title; name the one to ask",
            extensions,
          });
        }
        const entry = tracked[0]!;
        // The same limit the scheduler refuses to partition around: an external
        // id travels to the worker as a bare string, so for an extension with
        // several catalogues it cannot say which one, and the worker would
        // either fetch the wrong series or filter this one out entirely.
        if (entry.namespace !== "") {
          return reply.code(409).send({
            error:
              `${entry.extension} keeps its tracked ids in named catalogues (this one is in ` +
              `"${entry.namespace}"), and a run's manga subset travels as a bare id that cannot ` +
              "name one. Re-check the whole extension instead.",
            extension: entry.extension,
            namespace: entry.namespace,
          });
        }

        const found = await recheckSubject(entry.extension);
        if ("error" in found) return reply.code(found.status).send({ error: found.error });
        const { bundle, manifest, removalMode, publishesCatalogue, runsInspected } = found;

        // What is on MangaDex right now under our group: the set the run's
        // answer will be diffed against, and the ceiling on what it can touch.
        // An API instance with no MangaDex credentials cannot count it, which
        // is a thinner preview and not a reason to refuse the run.
        const onMangadex = ctx.md
          ? await ctx.md.chaptersForManga(mdMangaId, manifest.mangadex_group_id)
          : null;
        const carded = onMangadex?.filter((chapter) => isCarded(chapter)).length ?? null;

        const preview = {
          target: "series" as const,
          mdMangaId,
          extension: entry.extension,
          mangaId: entry.mangaId,
          removalMode,
          onMangadex: onMangadex?.length ?? null,
          // Already carrying our card: the removal pass leaves these alone, so
          // they are not candidates however the publisher answers.
          carded,
          candidates: onMangadex === null || carded === null ? null : onMangadex.length - carded,
          publishesCatalogue,
          note: publishesCatalogue
            ? `${entry.extension} will be asked for its full listing of this series; chapters on ` +
              `MangaDex that it no longer lists are queued as ${queueKindFor(removalMode)}.`
            : noCatalogueNote(entry.extension, runsInspected),
        };

        return finishRecheck(req, reply, {
          body,
          preview,
          manifest,
          bundle,
          idempotencyKey: `recheck:${entry.extension}:${mdMangaId}:${new Date().toISOString()}`,
          scope: { mangaIds: [entry.mangaId], mdMangaIds: [mdMangaId] },
          auditAction: "chapter.series.recheck",
          auditSubject: mdMangaId,
        });
      },
    );

    /**
     * The same question over a whole extension.
     *
     * A series re-check is the precise instrument; this is the one to reach for
     * when a publisher has been reorganising, or when the last full sweep is old
     * enough that nobody trusts it. It is a plain CLEAN run — unscoped, because
     * here the snapshot really is a statement about the whole catalogue, which
     * is what licenses the two catalogue-wide removal passes a scoped run has to
     * skip.
     *
     * That makes it the same thing `POST /runs {kind: "CLEAN"}` creates, and the
     * reason to have it here anyway is the preview. A CLEAN run over an
     * extension is the largest blast radius an operator can produce from this
     * dashboard: it can mark every chapter of every series unavailable if the
     * publisher's listing comes back empty. Being told beforehand how many
     * series and chapters are in range, and whether the extension publishes a
     * catalogue listing at all, is the difference between a decision and a
     * gamble.
     */
    scope.post(
      "/api/v1/admin/chapters/extensions/:extension/recheck",
      { preHandler: requireScope("runs:write") },
      async (req, reply) => {
        const { extension } = parseOrThrow(
          z.object({ extension: z.string().regex(EXTENSION_NAME_RE) }),
          req.params,
        );
        const body = parseOrThrow(
          z
            .object({
              dryRun: z.boolean().default(true),
              confirm: z.boolean().default(false),
              idempotencyKey: z.string().max(256).optional(),
            })
            .strict(),
          req.body ?? {},
        );

        const found = await recheckSubject(extension);
        if ("error" in found) return reply.code(found.status).send({ error: found.error });
        const { bundle, manifest, removalMode, publishesCatalogue, runsInspected } = found;

        // Both cheap, and both the honest ceiling rather than a live count: a
        // group-wide MangaDex walk is the expensive pass `chapters reconcile`
        // exists to pay for, and making a preview cost that would teach
        // operators to skip the preview.
        const [trackedSeries, knownChapters] = await Promise.all([
          ctx.prisma.trackedManga.count({ where: { extension } }),
          ctx.prisma.uploadedChapter.count({ where: { extension } }),
        ]);

        const preview = {
          target: "extension" as const,
          extension,
          removalMode,
          trackedSeries,
          // What we have a row for, which is not the same as what MangaDex
          // holds — `chapters reconcile` is the pass that closes that gap.
          knownChapters,
          onMangadex: null,
          carded: null,
          candidates: null,
          publishesCatalogue,
          note: publishesCatalogue
            ? `${extension} will be re-scraped in full and asked for its current listing of all ` +
              `${trackedSeries} tracked series; anything on MangaDex it no longer lists is queued ` +
              `as ${queueKindFor(removalMode)}.`
            : noCatalogueNote(extension, runsInspected),
        };

        return finishRecheck(req, reply, {
          body,
          preview,
          manifest,
          bundle,
          idempotencyKey: `recheck:${extension}:all:${new Date().toISOString()}`,
          // No scope: over a whole extension the snapshot IS the catalogue, and
          // narrowing it would switch off the very passes that make a full
          // sweep worth more than a series-by-series one.
          scope: null,
          auditAction: "chapter.extension.recheck",
          auditSubject: extension,
        });
      },
    );

    // -------------------------------------------------------------- helpers

    /**
     * The extension side of a re-check: the bundle to run, and whether asking
     * it anything can produce an answer.
     *
     * Removal detection needs a full catalogue listing, and not every extension
     * publishes one. Whether this one does is not in the manifest, so the
     * honest signal is whether its recent runs carried a snapshot: a "no" means
     * the re-check will run and find nothing, which is worth knowing before
     * rather than after.
     */
    async function recheckSubject(extension: string): Promise<
      | { status: number; error: string }
      | {
          bundle: Awaited<ReturnType<typeof ctx.bundles.latest>> & object;
          manifest: Manifest;
          removalMode: RemovalMode;
          publishesCatalogue: boolean;
          runsInspected: number;
        }
    > {
      const bundle = await ctx.bundles.latest(extension);
      if (!bundle) return { status: 404, error: `no bundle published for ${extension}` };
      const manifest = Manifest.parse(bundle.manifest);
      const removalMode = manifest.chapter_removal_mode ?? (await ctx.settings.getRemovalMode());

      const recent = await ctx.prisma.run.findMany({
        where: { extension, state: "PROCESSED" },
        orderBy: { createdAt: "desc" },
        take: RECHECK_RUNS_INSPECTED,
        select: { id: true },
      });
      const totals = await ctx.runChapters.totalsForRuns(recent.map((run) => run.id));
      return {
        bundle,
        manifest,
        removalMode,
        publishesCatalogue: [...totals.values()].some((total) => total.all !== null),
        runsInspected: recent.length,
      };
    }

    /**
     * The half both re-checks share: preview, or gate and start the run.
     *
     * Identical for a series and for an extension because the difference
     * between them is one field — whether the run carries a scope — and every
     * guard around it (dry run by default, an explicit confirm, the pause gate,
     * the audit row) applies the same way to both.
     */
    async function finishRecheck(
      req: FastifyRequest,
      reply: FastifyReply,
      opts: {
        body: { dryRun: boolean; confirm: boolean; idempotencyKey?: string | undefined };
        preview: Record<string, unknown> & { note: string; extension: string };
        manifest: Manifest;
        bundle: { sha256: string };
        idempotencyKey: string;
        scope: { mangaIds: string[]; mdMangaIds: string[] } | null;
        auditAction: string;
        auditSubject: string;
      },
    ) {
      if (opts.body.dryRun) {
        return reply.send({
          dryRun: true,
          action: "RECHECK",
          ...opts.preview,
          note:
            `${opts.preview.note} Nothing has been queued. Repeat with {dryRun: false, confirm: true} ` +
            "to start the run.",
        });
      }
      if (!opts.body.confirm) {
        return reply
          .code(400)
          .send({ error: "a live re-check needs confirm: true alongside dryRun: false" });
      }
      if (await ctx.settings.isPaused()) {
        return reply.code(409).send({ error: "platform is paused" });
      }

      const who = actor(req);
      const result = await ctx.scheduler.createRunForExtension(
        opts.manifest,
        opts.bundle as Parameters<typeof ctx.scheduler.createRunForExtension>[1],
        {
          idempotencyKey: opts.body.idempotencyKey ?? opts.idempotencyKey,
          // CLEAN is how the contract asks for `allChapters`, which removal
          // detection is computed from. Scope, where there is one, is what
          // keeps that from meaning "the catalogue is this one series".
          kind: "CLEAN",
          triggeredBy: who,
          ...(opts.scope ? { scope: opts.scope } : {}),
        },
      );

      await ctx.audit.record(who, opts.auditAction, opts.auditSubject, {
        runId: result.runId,
        ...opts.preview,
      });

      return reply.code(result.created ? 201 : 200).send({
        ok: true,
        dryRun: false,
        action: "RECHECK",
        ...opts.preview,
        runId: result.runId,
        created: result.created,
        note:
          "the run is queued; a worker executes it and the processor queues whatever the " +
          "publisher no longer lists. Watch it under Runs, then under Queues.",
      });
    }

    /** `UNAVAILABLE` or `DELETE`, as the removal mode decides. */
    function queueKindFor(mode: RemovalMode): string {
      return mode === "delete" ? "DELETE" : "UNAVAILABLE";
    }

    function noCatalogueNote(extension: string, runsInspected: number): string {
      return (
        `none of ${extension}'s last ${runsInspected} processed run(s) carried a full catalogue ` +
        "listing. Removal detection is computed from one, so this re-check will probably find " +
        "nothing to mark. Nothing is harmed by running it."
      );
    }

    async function manifestFor(extension: string | null): Promise<{ allowed_hosts: string[] } | null> {
      if (!extension) return null;
      const bundle = await ctx.bundles.latest(extension);
      if (!bundle) return null;
      const parsed = Manifest.safeParse(bundle.manifest);
      return parsed.success ? parsed.data : null;
    }

    /**
     * Why a mutating call would be refused, or null when it would be accepted.
     * Returned by the GET so the dashboard can disable a control with the reason.
     */
    function actionsBlockedReason(req: FastifyRequest, deletedOnly: boolean): string | null {
      // Must mirror requireAdminRole exactly, api-token clause included.
      if (req.principal?.kind === "api-token") return TOKEN_REFUSAL;
      if (req.adminRole !== "OWNER" && req.adminRole !== "ADMIN") return ROLE_REFUSAL;
      if (deletedOnly) return DELETED_REASON;
      return null;
    }
  });
}

// ------------------------------------------------------------------ internals

const ROLE_REFUSAL =
  "changing a published chapter requires the ADMIN role: it edits, hides or removes a public " +
  "catalogue entry under the platform's MangaDex account. Ask an admin to make the change.";

const TOKEN_REFUSAL =
  "changing a published chapter is closed to api tokens however broadly they are scoped: it " +
  "changes a public catalogue entry under the platform's MangaDex account, so it is attributable " +
  "to a signed-in operator or nothing. Make the change from the dashboard.";

const DELETED_REASON =
  "this chapter is recorded as deleted from MangaDex, so there is nothing left to change. " +
  "If MangaDex still has it, the archive row is stale; queue the action from the Queues view by hand.";

/** Refusal text when the only record of a chapter is its deletion. */
function goneReason(located: { archive: ChapterArchive; row: ChapterRow }): string | null {
  if (located.archive !== "deleted") return null;
  return `${DELETED_REASON} (deleted ${located.row.at.toISOString()}; archive: ${ARCHIVES.deleted.label})`;
}
