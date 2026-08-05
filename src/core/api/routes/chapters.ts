import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { adminAuthHook, requireScope } from "../auth.js";
import { sessionAuthenticator } from "../session.js";
import { chapterFromJson, chapterToTaskPayload } from "../../md/chapterRows.js";
import { CHAPTER_SETS, type ChapterSet } from "../../store/runChapters.js";
import { CHAPTER_TABLES, type ChapterTable } from "../../store/chapters.js";
import { decodeTaskCursor, taskDedupeKey, UPLOAD_TASK_KINDS, UPLOAD_TASK_STATES } from "../../store/uploadTasks.js";
import { manualTaskProblems } from "./queues.js";
import { MangadexLanguageCode } from "../../../contracts/languages.js";

/**
 * Chapters, as chapters — the three places one can be looked at.
 *
 *   1. `GET /runs/:id/chapters`   what an extension FOUND on a given run,
 *                                 read back out of the stored result envelope.
 *   2. `GET /queues/chapters`     what is ABOUT TO BE sent to MangaDex, in the
 *                                 order the uploader will claim it.
 *   3. `GET /chapters`            what IS on MangaDex already, and the archives
 *                                 of what has been edited, marked unavailable
 *                                 or deleted.
 *
 * The rest of the API models this pipeline as runs, jobs, envelopes and queue
 * rows, which is the right model for operating it and the wrong one for reading
 * it: "did mangaplus pick up chapter 142?" was three joins and a `jsonb` path.
 * These endpoints are the same data keyed on the thing the operator actually
 * cares about.
 *
 * Only one endpoint here writes anything — `POST /chapters/:id/edit`, which
 * corrects the metadata of a chapter already on MangaDex. It does not talk to
 * MangaDex: it enqueues the same EDIT upload task the processor would have
 * written, so the correction goes through the one process holding the
 * credentials, inherits its retry and audit behaviour, and can be inspected or
 * pulled from the queue before it lands.
 */

/** Cap on a page of chapters. These rows are small; the cap is about the query. */
const MAX_PAGE = 500;
/** Titles shown in a run's per-series breakdown. */
const MANGA_BREAKDOWN_LIMIT = 200;

/** Validate, answering 400 rather than the error handler's "internal error". */
function parseOrThrow<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue && issue.path.length > 0 ? issue.path.join(".") : "request";
  throw Object.assign(new Error(`invalid ${where}: ${issue?.message ?? "validation failed"}`), {
    statusCode: 400,
  });
}

function oneOrMany<T extends readonly [string, ...string[]]>(values: T) {
  return z
    .union([z.enum(values), z.array(z.enum(values)).min(1)])
    .transform((value) => (Array.isArray(value) ? [...new Set(value)] : [value]));
}

/**
 * The MangaDex chapter fields an operator may correct, named exactly as the
 * MangaDex chapter-edit body names them — because that is what this becomes.
 *
 * `groups` is here for completeness and is the one field with a footgun: it
 * REPLACES the attribution rather than adding to it, and dropping our own group
 * from a chapter we uploaded orphans it. The handler refuses that specific
 * mistake below.
 *
 * Deliberately absent: `externalUrl`, `publishAt`, `version`. The first two are
 * not what this platform manages, and `version` is optimistic-concurrency state
 * that the uploader reads from MangaDex at the moment of the write — accepting
 * one here would let an operator pin a stale version and lose someone else's
 * edit.
 */
const EditBody = z
  .object({
    volume: z.string().max(64).nullable().optional(),
    chapter: z.string().max(64).nullable().optional(),
    title: z.string().max(1024).nullable().optional(),
    // Case-insensitive on the way in and canonical out, so an operator typing
    // "PT-BR" gets `pt-br` rather than a rejection.
    translatedLanguage: MangadexLanguageCode.optional(),
    groups: z.array(z.string().uuid()).max(10).optional(),
    /** Held back so a correction can be reviewed on the Queues page first. */
    notBefore: z.coerce.date().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.volume !== undefined ||
      value.chapter !== undefined ||
      value.title !== undefined ||
      value.translatedLanguage !== undefined ||
      value.groups !== undefined,
    { message: "nothing to change: pass at least one of volume, chapter, title, translatedLanguage or groups" },
  );

/**
 * Queueing a MangaDex write needs a human operator, not merely `runs:write`.
 *
 * Two checks, and the FIRST is the load-bearing one. `adminAuthHook` gives every
 * scoped `pa_…` token `adminRole = "ADMIN"` (see auth.ts: scoped tokens are
 * "never owner-equivalent", which sets ADMIN as the ceiling, not as a bar they
 * have to clear). So a role test alone admits the Discord bot, which holds
 * `runs:write` to trigger runs — and "trigger a scrape" is not the same
 * authority as "rewrite a published chapter's metadata". Refusing api-tokens
 * outright is what actually confines this, and it costs nothing: no shipped
 * client calls it. Same construction as `requireApplyRole` in routes/ops.ts.
 *
 * A CONTRIBUTOR is then excluded twice over — by the role, and by `runs:write`
 * which `scopesForRole` never grants them.
 */
async function requireAdminRole(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.principal?.kind === "api-token") {
    await reply.code(403).send({
      error:
        "queueing a MangaDex write is an operator action: sign in to the dashboard rather than using a " +
        "machine token. A token scoped for runs may trigger a scrape, which is a different authority.",
      requiredRole: "ADMIN",
    });
    return;
  }
  if (req.adminRole !== "OWNER" && req.adminRole !== "ADMIN") {
    await reply.code(403).send({
      error: `admin role or above required; this credential is ${req.adminRole ?? "unauthenticated"}`,
      requiredRole: "ADMIN",
    });
  }
}

/** The MangaDex-shaped view of a stored chapter — what an edit starts from. */
function mdFieldsOf(chapter: {
  chapterVolume: string | null;
  chapterNumber: string | null;
  chapterTitle: string | null;
  chapterLanguage: string | null;
  mdGroupId: string | null;
}): Record<string, unknown> {
  return {
    volume: chapter.chapterVolume,
    chapter: chapter.chapterNumber,
    title: chapter.chapterTitle,
    translatedLanguage: chapter.chapterLanguage,
    groups: chapter.mdGroupId ? [chapter.mdGroupId] : [],
  };
}

export function registerChapterRoutes(app: FastifyInstance, ctx: AppContext): void {
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

    /** Same attribution rules as every other admin module. */
    const actor = (req: FastifyRequest): string => {
      const claimed = (req.headers["x-actor"] as string | undefined)?.slice(0, 64);
      const principal = req.principal;
      if (principal?.kind === "api-token") {
        return claimed ? `${principal.name} for ${claimed}` : principal.name;
      }
      if (principal?.kind === "session") return principal.name;
      return `admin:${claimed ?? "root"}`;
    };

    // ------------------------------------------------ 1. found, per run

    const runIdParam = z.object({ id: z.string().uuid() });
    const SetQuery = z.enum(CHAPTER_SETS).default("updated");

    /**
     * How much each segment of a run reported, and which titles it was for.
     *
     * Segments with no committed envelope come back with null counts rather than
     * being absent: "3 of 4 segments reported" is what stops a chapter list being
     * read as the whole picture when it is three quarters of one.
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

        const [segments, byManga] = await Promise.all([
          ctx.runChapters.segmentCounts(id),
          ctx.runChapters.byManga(id, query.set as ChapterSet, MANGA_BREAKDOWN_LIMIT),
        ]);

        const reported = segments.filter((segment) => segment.updated !== null);
        return {
          run,
          set: query.set,
          segments,
          // Named rather than left to the client to sum: the difference between
          // "found nothing" and "has not reported yet" is the whole point of
          // this endpoint.
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
          mangaTitles: byManga.length,
          mangaCapped: byManga.length === MANGA_BREAKDOWN_LIMIT,
        };
      },
    );

    /**
     * The chapters one run found, in the order the extension reported them.
     *
     * `set=updated` (the default) is what the extension flagged as new or
     * changed — the set the processor turns into upload and edit tasks.
     * `set=all` is the optional full-catalogue snapshot, which only some
     * extensions send and which drives removal detection; it is empty rather
     * than absent when an extension does not send one, and the summary endpoint
     * says which case a run is in.
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
            limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(100),
            offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
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
          { limit: query.limit, offset: query.offset },
        );

        return {
          run,
          set: query.set,
          chapters: page.chapters,
          total: page.total,
          limit: query.limit,
          offset: query.offset,
          // Offset paging is safe here and the reason is worth stating on the
          // wire: a committed envelope never changes, so page 2 is stable.
          order: "segmentIndex,position",
        };
      },
    );

    // ------------------------------------------- 2. queued, in claim order

    /**
     * The upload queue read as chapters rather than as rows: which series, which
     * chapter, in the order the uploader will claim them.
     *
     * `position` is the place in the claim order across everything matching the
     * filter, not within the page — so an operator can say "this is 14th" and
     * mean it. Ordering is `not_before ASC` because that is literally the claim
     * query's ORDER BY; see the comment on `UploadTaskStore.listChapters`.
     *
     * Defaults to PENDING because "what is going to be uploaded" is the
     * question; pass `state` explicitly to see what has already run or failed.
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
            // The same two facets `/queues/tasks` takes. Both tabs read one
            // queue, so a filter has to mean the same thing on either.
            extension: z.string().min(1).max(128).optional(),
            language: z.string().min(1).max(32).optional(),
            limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(100),
            cursor: z.string().max(512).optional(),
          }),
          req.query ?? {},
        );

        const cursor = query.cursor ? decodeTaskCursor(query.cursor) : null;
        if (query.cursor && !cursor) {
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
          ctx.uploadTasks.listChapters(filter, { limit: query.limit, cursor }),
          ctx.uploadTasks.depths(),
        ]);

        return {
          chapters: page.chapters,
          total: page.total,
          limit: query.limit,
          nextCursor: page.nextCursor,
          order: "notBefore,createdAt,id",
          states: filter.states,
          summary,
        };
      },
    );

    // --------------------------------------- 3. already on MangaDex

    const TableQuery = z.enum(CHAPTER_TABLES).default("uploaded");

    /**
     * The chapter archives. `table=uploaded` is the live mirror of what exists
     * on MangaDex under our group; the other three are history.
     */
    scope.get("/api/v1/admin/chapters", { preHandler: requireScope("runs:read") }, async (req) => {
      const query = parseOrThrow(
        z.object({
          table: TableQuery,
          extension: z.string().max(128).optional(),
          q: z.string().min(1).max(256).optional(),
          mdMangaId: z.string().uuid().optional(),
          language: z.string().min(2).max(16).optional(),
          limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(50),
          offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
        }),
        req.query ?? {},
      );

      const table = query.table as ChapterTable;
      const page = await ctx.chapters.list(
        table,
        {
          extension: query.extension,
          q: query.q,
          mdMangaId: query.mdMangaId,
          language: query.language,
        },
        { limit: query.limit, offset: query.offset },
      );

      return {
        table,
        chapters: page.chapters,
        total: page.total,
        limit: query.limit,
        offset: query.offset,
        tables: CHAPTER_TABLES,
      };
    });

    /** Which extensions have rows in a given archive, with counts. */
    scope.get(
      "/api/v1/admin/chapters/extensions",
      { preHandler: requireScope("runs:read") },
      async (req) => {
        const query = parseOrThrow(z.object({ table: TableQuery }), req.query ?? {});
        return { table: query.table, extensions: await ctx.chapters.extensions(query.table as ChapterTable) };
      },
    );

    const mdChapterParam = z.object({ mdChapterId: z.string().uuid() });

    /**
     * One chapter, everything known about it: the canonical row, which archives
     * hold it, its edit history, and whether a correction is already queued.
     *
     * The queued-task lookup is what stops the dashboard offering an edit form
     * that will 409 — a pending EDIT already owns the (EDIT, mdChapterId) slot,
     * and the right move then is to amend that task rather than queue a second.
     */
    scope.get(
      "/api/v1/admin/chapters/:mdChapterId",
      { preHandler: requireScope("runs:read") },
      async (req, reply) => {
        const { mdChapterId } = parseOrThrow(mdChapterParam, req.params);
        const detail = await ctx.chapters.detail(mdChapterId);
        if (!detail) return reply.code(404).send({ error: "no chapter with that MangaDex id is on record" });

        const queued = await ctx.prisma.uploadTask.findMany({
          where: { dedupeKey: mdChapterId },
          select: {
            id: true,
            kind: true,
            state: true,
            attempt: true,
            maxAttempts: true,
            notBefore: true,
            lastError: true,
          },
          orderBy: { notBefore: "asc" },
        });

        return {
          ...detail,
          queued,
          /** The MangaDex-shaped fields an edit would start from. */
          mdFields: mdFieldsOf(detail.chapter),
          editable: !detail.present.includes("deleted"),
        };
      },
    );

    /**
     * Correct the metadata of a chapter that is already on MangaDex.
     *
     * This does NOT write to MangaDex. It enqueues an EDIT upload task — byte
     * for byte the row `processor.ts` writes when it detects a metadata drift —
     * so the write happens in the uploader, which is the only process with the
     * credentials, and is subject to the same lease, retry, dead-letter and
     * upload-log treatment as everything else. Until the uploader claims it, the
     * task is visible on the Queues page and can be amended or removed.
     *
     * Three things are enforced here rather than discovered later:
     *
     *  - A deleted chapter cannot be edited. The row is gone from MangaDex, so
     *    the task would fail at `chapter … not found on MangaDex` after a lease,
     *    five attempts and a dead-letter.
     *  - The unique (EDIT, mdChapterId) constraint is reported as a 409 naming
     *    the existing task, never worked around. That constraint is why a
     *    correction cannot be queued twice.
     *  - `groups` may not drop our own upload group. MangaDex's edit REPLACES
     *    the attribution; removing the group that uploaded the chapter detaches
     *    it from this platform's catalogue, after which nothing here can find or
     *    fix it again.
     *
     * The task's chapter payload carries the NEW values as well as the diff.
     * That is not redundancy: on success the uploader mirrors the task's chapter
     * into `uploaded_chapters`, so a payload carrying the old values would land
     * the edit on MangaDex and leave our mirror describing what it used to say.
     */
    scope.post(
      "/api/v1/admin/chapters/:mdChapterId/edit",
      { preHandler: [requireAdminRole, requireScope("runs:write")] },
      async (req, reply) => {
        const { mdChapterId } = parseOrThrow(mdChapterParam, req.params);
        const body = parseOrThrow(EditBody, req.body ?? {});

        const detail = await ctx.chapters.detail(mdChapterId);
        if (!detail) return reply.code(404).send({ error: "no chapter with that MangaDex id is on record" });
        if (detail.present.includes("deleted")) {
          return reply.code(409).send({
            error:
              "this chapter was deleted from MangaDex; an edit would fail at the API. Re-upload it instead.",
            deletedAt: detail.deletedAt,
          });
        }

        const current = mdFieldsOf(detail.chapter);
        const payload: Record<string, unknown> = {};
        for (const field of ["volume", "chapter", "title", "translatedLanguage", "groups"] as const) {
          const value = body[field];
          if (value === undefined) continue;
          // An unchanged field is dropped rather than sent: the payload is the
          // record of what this edit meant to do, and a "change" to the value it
          // already had is noise in the chapter's edit history forever.
          if (JSON.stringify(value) === JSON.stringify(current[field])) continue;
          payload[field] = value;
        }
        if (Object.keys(payload).length === 0) {
          return reply.code(400).send({
            error: "every field already holds the value you asked for; nothing was queued",
            current,
          });
        }

        if (Array.isArray(payload["groups"])) {
          const groups = payload["groups"] as string[];
          const ours = detail.chapter.mdGroupId;
          if (ours && !groups.includes(ours)) {
            return reply.code(422).send({
              error:
                `MangaDex replaces a chapter's group attribution wholesale, and this list omits ${ours}, ` +
                "the group that uploaded the chapter. Dropping it detaches the chapter from this " +
                "platform's catalogue and nothing here could find it again.",
              uploadGroupId: ours,
            });
          }
        }

        // The chapter carried by the task, with the operator's changes applied
        // to the canonical fields as well as to the MangaDex payload.
        const edited = {
          ...detail.chapter,
          ...(payload["volume"] !== undefined ? { chapterVolume: payload["volume"] as string | null } : {}),
          ...(payload["chapter"] !== undefined ? { chapterNumber: payload["chapter"] as string | null } : {}),
          ...(payload["title"] !== undefined ? { chapterTitle: payload["title"] as string | null } : {}),
          ...(payload["translatedLanguage"] !== undefined
            ? { chapterLanguage: payload["translatedLanguage"] as string }
            : {}),
          mdChapterId,
        };

        const taskPayload = chapterToTaskPayload(
          { ...(edited as unknown as Record<string, unknown>), payload, oldInfo: current },
          detail.chapter.imageArtifacts,
        );

        const problems = manualTaskProblems("EDIT", taskPayload);
        if (problems.length > 0) {
          return reply.code(422).send({ error: "the edit cannot be executed", problems });
        }

        const dedupeKey = taskDedupeKey("EDIT", chapterFromJson(taskPayload));
        if (dedupeKey === null) {
          return reply.code(422).send({ error: "cannot derive a dedupe key for this chapter" });
        }

        const created = await ctx.uploadTasks.createManual("EDIT", dedupeKey, taskPayload, {
          notBefore: body.notBefore,
        });
        if (!created) {
          const existing = await ctx.prisma.uploadTask.findUnique({
            where: { kind_dedupeKey: { kind: "EDIT", dedupeKey } },
            select: { id: true, state: true, attempt: true, notBefore: true, createdAt: true },
          });
          return reply.code(409).send({
            error:
              "an EDIT for this chapter is already queued; amend that task rather than queueing a second " +
              "(the unique (kind, dedupe_key) row is what stops one chapter being edited twice in flight)",
            dedupeKey,
            existing,
          });
        }

        await ctx.audit.record(actor(req), "chapter.edit_queued", mdChapterId, {
          taskId: created.id,
          extension: detail.chapter.extensionName,
          mdMangaId: detail.chapter.mdMangaId,
          mangaName: detail.chapter.mangaName,
          // Both halves, because after the uploader runs this is the only record
          // of what the chapter said before.
          old: current,
          new: payload,
        });

        return reply.code(201).send({
          ok: true,
          task: created,
          payload,
          oldInfo: current,
          note: "queued for the uploader; it is on the Queues page until it is claimed",
        });
      },
    );
  });
}
