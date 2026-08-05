// Not self-registering: server.ts is owned elsewhere, so the integrator wires
// this module in with `registerChapterRoutes(app, ctx)` next to the other route
// modules.
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { adminAuthHook, requireScope } from "../auth.js";
import { sessionAuthenticator } from "../session.js";
import { normaliseMangadexLanguage } from "../../../contracts/languages.js";
import { Manifest, hostAllowed } from "../../../contracts/manifest.js";
import { chapterToTaskPayload } from "../../md/chapterRows.js";
import { generateChapterCard } from "../../md/card.js";
import { unavailableCardOptions } from "../../md/unavailableCard.js";
import type { MdChapterDetail } from "../../md/client.js";
import {
  ARCHIVES,
  CHAPTER_ARCHIVES,
  chapterOf,
  decodeChapterCursor,
  type ChapterArchive,
  type ChapterFilter,
  type ChapterRow,
} from "../../store/chapters.js";
import { taskDedupeKey } from "../../store/uploadTasks.js";
import { manualTaskProblems } from "./queues.js";

/**
 * The chapters this platform has published on MangaDex, and the three things an
 * operator can do to one after the fact: edit its metadata, replace it with an
 * "unavailable" card, or delete it outright.
 *
 * WHY THIS IS NOT A MANGADEX CLIENT. Every action here queues an UploadTask and
 * returns. core-uploader is the only process that writes to MangaDex, and that
 * is a property worth more than the immediacy of a synchronous PUT: it is what
 * makes "one open upload session per account" enforceable, what gives every
 * change a retry budget and a dead-letter, and what stops two API replicas from
 * racing each other into a duplicate. The endpoints below therefore answer 202
 * with a task id — "queued", never "done" — and the operator watches the queue.
 *
 * The read side is direct: the four chapter tables answer immediately, and when
 * this instance holds MangaDex credentials the detail view also shows what
 * MangaDex currently says. That live read is the one that matters, because the
 * local row is a mirror that may be days old while the operator is deciding
 * what a public catalogue entry should look like. A MangaDex outage degrades
 * that to `mangadexError` and never makes the row unreadable.
 *
 * Guards, in the order they bite:
 *   1. `chapters:read` to look, `chapters:write` to queue anything.
 *   2. ADMIN-or-above by role on every mutating route — the same
 *      role-plus-scope construction routes/queues.ts uses for hand-enqueueing,
 *      and for the same reason: this reaches a public catalogue, and a
 *      CONTRIBUTOR must not.
 *   3. A settled queue row for the chapter is superseded; a PENDING or LEASED
 *      one is a 409 naming it. Nothing here can touch work an uploader holds.
 *   4. Deleting needs `confirm: true`, because it is the one action MangaDex
 *      cannot give back.
 */

/** Cap on one page of chapters. */
const MAX_PAGE = 200;
const DEFAULT_PAGE = 50;

/**
 * Hard ceiling on one bulk action.
 *
 * Lower than the 1000 routes/queues.ts allows, and for a reason: that cap bounds
 * a change to queue rows, this one bounds a change to public pages that readers
 * are looking at. Two hundred is a large deliberate action — a whole series, a
 * bad run's worth of uploads — and small enough that the dry run listing every
 * affected chapter is still something a person will actually read.
 */
const CHAPTER_BULK_CAP = 200;

const MD_CHAPTER_URL = "https://mangadex.org/chapter/";
const MD_MANGA_URL = "https://mangadex.org/title/";

/**
 * A MangaDex chapter id as it appears in our tables.
 *
 * Not `z.string().uuid()`: chapters migrated from the legacy Mongo collections
 * carry whatever id that database held, and refusing to *display* one because
 * it is not a well-formed uuid would hide exactly the rows most likely to need
 * attention. The charset is still closed, so nothing routable or injectable
 * gets through.
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

/**
 * A boolean that may arrive as a query-string word. NOT `z.coerce.boolean()`,
 * which maps the string "false" to TRUE — the wrong direction to be wrong in on
 * a flag that guards a delete.
 */
const Flag = z.preprocess(
  (value) => (typeof value === "string" ? value === "true" || value === "1" : value),
  z.boolean(),
);

/**
 * The fields a chapter edit may change, as MangaDex names them.
 *
 * This is deliberately the same vocabulary as `PUT /chapter/{id}` rather than
 * our column names: what an operator types here is what MangaDex receives, and
 * a translation layer in between is a place for the two to drift. `null` clears
 * a field; omitting it leaves it alone.
 *
 * Lengths mirror the MangaDex API's own limits. They are validated here rather
 * than discovered from a 400 half an hour later, when the task is claimed.
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
 * What a *bulk* edit may change: the fields a set of chapters can legitimately
 * share. Title, chapter number and external URL are one chapter's identity, and
 * writing one of those across two hundred chapters is not an operation anyone
 * wants — so it is not expressible here rather than merely discouraged.
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
      }),
    );
    scope.addHook("preHandler", async (req, reply) => {
      if (!ctx.adminLimiter.allow(req.ip)) {
        await reply.code(429).send({ error: "rate limited" });
      }
    });

    /** Same attribution rules as routes/admin.ts, ops.ts and queues.ts. */
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
     * Every mutating route is ADMIN-or-above AND closed to api tokens, on top
     * of `chapters:write` — the same construction, and the same reasoning, as
     * `requireApplyRole` in routes/ops.ts.
     *
     * The scope says "this credential works on the chapter catalogue"; the role
     * says "this principal may change a public one". Tokens are refused
     * outright rather than judged on their role, because `adminAuthHook` gives
     * every api token `adminRole = "ADMIN"` — a default meaning "not
     * owner-equivalent", not "vetted human". Judged on the role alone, any
     * token carrying `chapters:write` could unpublish chapters under the shared
     * MangaDex account, which is precisely the blast radius scoped tokens exist
     * to contain. The dashboard is the only caller, so closing this to tokens
     * costs no capability, and the break-glass ADMIN_TOKEN is a `root`
     * principal and still gets through.
     *
     * An allow-list on the role, not "refuse CONTRIBUTOR": a deny-list on a
     * role enum grants every role added after it.
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
     * Find the chapter wherever it is recorded.
     *
     * Order matters: `uploaded` is the live mirror and wins, then the two
     * archives that still describe something on MangaDex (a chapter carrying an
     * unavailable card is still a published chapter, and an edited one
     * certainly is), and `deleted` last — a hit there alone means the chapter is
     * gone, which every action needs to refuse.
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
     * Queue one chapter action.
     *
     * The payload is built by `chapterToTaskPayload` — the same function the
     * processor writes its queue rows with — from the stored row, so the queued
     * work describes the chapter the operator was actually looking at, and the
     * per-kind sidecars ride along exactly as taskWorkers expects them.
     * `manualTaskProblems` is the validator routes/queues.ts uses for a
     * hand-built task: reusing it means a task that would throw on claim is
     * refused now, and that the two paths cannot drift.
     */
    async function queueAction(
      req: FastifyRequest,
      reply: FastifyReply,
      opts: {
        kind: "EDIT" | "DELETE" | "UNAVAILABLE";
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
        // The slot is held by work that is already queued or in flight. Read the
        // row only now, and only to name it — never to decide whether to write.
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

      // 202: the change is queued, not applied. The uploader may still fail it,
      // and a client that reports "done" here would be lying.
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

    // ------------------------------------------------------------------ read

    /**
     * One page of an archive, newest first.
     *
     * `archive` selects which of the four tables is being read — what is on
     * MangaDex now (`uploaded`), what was replaced by a card (`unavailable`),
     * what was removed (`deleted`), and what has been edited since it was
     * published (`edited`). They share a shape, so they share an endpoint.
     */
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
        }),
        req.query ?? {},
      );

      const cursor = query.cursor ? decodeChapterCursor(query.cursor) : null;
      if (query.cursor && !cursor) {
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
        ctx.chapters.list(query.archive, filter, { limit: query.limit, cursor }),
        ctx.chapters.totals(),
      ]);

      return {
        archive: query.archive,
        chapters: page.chapters,
        total: page.total,
        limit: query.limit,
        nextCursor: page.nextCursor,
        // Named so a client never has to infer it, and so a cursor is obviously
        // not an offset.
        order: "at,id (descending)",
        // Global rather than filtered, so a narrow filter cannot hide that an
        // extension has three hundred chapters marked unavailable.
        totals,
        archives: CHAPTER_ARCHIVES,
      };
    });

    /** Per-extension counts for one archive — the filter picker's contents. */
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
     * One chapter, everywhere it is recorded, plus what MangaDex says now and
     * anything already queued against it.
     *
     * The three together are what an operator needs before touching a public
     * entry: the row says what we think we published, MangaDex says what is
     * actually there, and the queue says whether somebody has already asked for
     * a change that has not landed yet.
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
     * Built by `unavailableCardOptions` — the same function the uploader calls —
     * from the live chapter when MangaDex is readable and from the stored row
     * otherwise. That shared derivation is the whole point: an operator
     * approving one image and publishing another would be worse than having no
     * preview at all.
     *
     * Nothing is written and nothing is queued; this renders a PNG and returns
     * it. `footerNote` and `unavailableAt` are echoed through so the preview can
     * show exactly the overrides the action would carry.
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
          // The image is derived from an admin-only record; the server's global
          // onSend already sets no-store, and this is a second statement of the
          // same intent for any intermediary that reads only one of them.
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
     * execution time on purpose — MangaDex's `version` must be the one current
     * when the write lands, and reading it here would guarantee it was stale by
     * the time the task ran.
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
          // The same allowlist the sandbox enforces on the extension, applied to
          // the operator correcting its output — this URL is published on a
          // MangaDex entry. A host outside it is a warning rather than a refusal
          // because a publisher legitimately moves domains, and the person
          // typing it is the only one who can judge that; the refusal case
          // (routes/ops.ts, links.raw on a title) is a field we own outright.
          const manifest = await manifestFor(located.row.extension);
          if (manifest && !hostAllowed(url, manifest.allowed_hosts)) {
            warnings.push(
              `${parsed.host} is not in ${located.row.extension}'s allowed_hosts ` +
                `(${manifest.allowed_hosts.join(", ")})`,
            );
          }
          payload.externalUrl = url;
        }

        // What the fields look like now, preferring MangaDex over our mirror —
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
     * Queue "replace this chapter with an unavailable card".
     *
     * What the uploader will do: render the card, attach it as the chapter's
     * only page through an edit session, repoint `externalUrl` away from the
     * dead publisher link, and archive the row into `unavailable_chapters`.
     *
     * `force` is what makes this repeatable. Without it a chapter that has
     * already been marked unavailable is a no-op — correct for the automated
     * pass, useless for an operator replacing a card that says the wrong thing
     * — so asking again for an already-archived chapter is refused with the
     * flag it needs, rather than silently doing nothing.
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
     * Queue a hard delete from MangaDex.
     *
     * The one irreversible action the platform takes, so: `confirm: true`, the
     * admin role, a full audit row, and — in the uploader — an archive write to
     * `deleted_chapters` BEFORE the live row is dropped, so the record of what
     * was removed outlives it.
     *
     * Marking a chapter unavailable is nearly always the better answer, because
     * it keeps the entry and its reading history on MangaDex; that is what the
     * `alternative` field says out loud on every refusal for want of `confirm`.
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
     * The same three actions over a set of chapters.
     *
     * Two ways to name the set, and they are not symmetrical. `ids` is an
     * enumeration the operator built by looking at rows; `filter` is a
     * description, and a description can match more than whoever wrote it
     * imagined. So:
     *
     *  - **`dryRun` defaults to TRUE**, always. The first call anyone makes —
     *    including a client that forgot the field — writes nothing and reports
     *    exactly what it would have done, per chapter. A live run needs
     *    `dryRun: false` AND `confirm: true`, two fields that cannot both be set
     *    by accident. This is the purge doctrine from routes/queues.ts applied
     *    to a sharper operation: purge deletes queue rows, this changes public
     *    pages.
     *  - **The cap is 200 per call** and is applied inside the id resolution, so
     *    an over-wide filter cannot become an unbounded read on its way to
     *    becoming an unbounded write. A truncated set says so and the operator
     *    calls again.
     *
     * The dry run is genuinely predictive: it resolves the same rows, checks the
     * same refusals (deleted, already-unavailable-without-force, a task already
     * queued or leased) and reports per-chapter outcomes. It is a preview of
     * this operation, not an estimate of it. The live path still does not
     * read-then-write — every insert is the same guarded upsert, and a chapter
     * whose state changed between the preview and the write comes back refused.
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
     *
     * Four queries whatever the size of the set — the per-chapter `locate` would
     * be four *each*, and a two-hundred-chapter preview would spend eight
     * hundred round trips deciding what it was going to do.
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
        kind: "EDIT" | "DELETE" | "UNAVAILABLE";
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
      const archive = body.filter?.archive ?? "uploaded";

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
        // Only needed by the UNAVAILABLE path, where "is a card already posted?"
        // decides whether `force` is required — and `locate` may have resolved
        // the same chapter from `uploaded`, which does not answer that.
        opts.kind === "UNAVAILABLE" ? ctx.chapters.manyByIds("unavailable", ids) : Promise.resolve([]),
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
        // subject — a batch that wrote only a summary row would not answer it.
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

      // 200, not 202: a batch where eight chapters queued and two were refused
      // is a success and a partial failure at once, and only the per-chapter
      // results say which is which.
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
     * Bulk edit.
     *
     * The fields are deliberately a SUBSET of the single-chapter edit: volume,
     * language and groups are properties a set of chapters can legitimately
     * share, while a title, a chapter number and an external URL are that one
     * chapter's identity. Writing one title across two hundred chapters is not
     * an operation anybody wants — it is a mistake with a keyboard shortcut — so
     * the schema does not express it.
     *
     * `oldInfo` here comes from our own rows rather than a live MangaDex read:
     * two hundred chapter reads would be slower than the batch itself and would
     * spend the MangaDex ratelimit the uploader needs. Correctness is unaffected
     * — the uploader still merges against the live resource when it runs, and
     * `version` is still read there — only the recorded "old" is our mirror's
     * view, which is the trade the field is worth.
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
     * Bulk delete — the sharpest thing in this file.
     *
     * Nothing extra guards it beyond what the other two have, and that is a
     * deliberate judgement rather than an oversight: the guards that matter are
     * already the strongest the codebase has (ADMIN role, no api tokens,
     * dry-run-by-default, an explicit confirm, a 200-chapter cap, the whole row
     * in the audit trail per chapter). Adding a fourth flag here would train
     * operators to set flags without reading them.
     *
     * The dry run is where the safety actually lives: it names every chapter it
     * would remove, which is the last chance anyone gets.
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

    // -------------------------------------------------------------- helpers

    async function manifestFor(extension: string | null): Promise<{ allowed_hosts: string[] } | null> {
      if (!extension) return null;
      const bundle = await ctx.bundles.latest(extension);
      if (!bundle) return null;
      const parsed = Manifest.safeParse(bundle.manifest);
      return parsed.success ? parsed.data : null;
    }

    /**
     * Why a mutating call would be refused, or null when it would be accepted.
     * Returned by the GET so the dashboard can disable a control WITH the
     * reason, rather than letting an operator discover it from a 403.
     */
    function actionsBlockedReason(req: FastifyRequest, deletedOnly: boolean): string | null {
      // Mirrors requireAdminRole exactly, api-token clause included. If the two
      // ever disagree the dashboard offers a button that 403s, which is the
      // failure this function exists to avoid.
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
  "If MangaDex still has it, the archive row is stale — queue the action from the Queues view by hand.";

/** Refusal text when the only record of a chapter is its deletion. */
function goneReason(located: { archive: ChapterArchive; row: ChapterRow }): string | null {
  if (located.archive !== "deleted") return null;
  return `${DELETED_REASON} (deleted ${located.row.at.toISOString()}; archive: ${ARCHIVES.deleted.label})`;
}
