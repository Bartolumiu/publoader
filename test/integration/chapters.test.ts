import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import { buildContext, type AppContext } from "../../src/core/api/context.js";
import { buildServer } from "../../src/core/api/server.js";
import { registerChapterRoutes } from "../../src/core/api/routes/chapters.js";
import { UploadTaskWorkers } from "../../src/core/md/taskWorkers.js";
import { SettingsStore } from "../../src/core/store/settings.js";
import type { MdChapterDetail, MdExtendedApi } from "../../src/core/md/client.js";
import { closeDb, dbReady, resetDb, testPrisma } from "./db.js";

/**
 * The operator's view of what this platform has published, and the three
 * actions it offers on a chapter that is already on MangaDex.
 *
 * The properties worth proving are the ones that cost real damage when they
 * regress, and every one of them needs a live postgres; the queue's unique
 * (kind, dedupe_key) constraint is the system under test:
 *
 *  - an action QUEUES work and never touches MangaDex from the API process;
 *  - a second action on a chapter whose task is still PENDING is refused, not
 *    silently rewritten, and one whose task has completed is superseded in
 *    place (without which a chapter could be edited exactly once, ever);
 *  - deleting needs `confirm: true`, and a chapter already recorded as deleted
 *    refuses everything;
 *  - the role gate holds: `chapters:write` alone is not enough, so a leaked
 *    machine token cannot unpublish anything;
 *  - and the unavailable card is regenerable, which is the whole reason `force`
 *    exists; without it the uploader treats an archived chapter as done.
 */
describe.skipIf(!dbReady())("chapter management endpoints", () => {
  const prisma = testPrisma();
  const ADMIN_TOKEN = "test-admin-token-0123456789";
  const config = loadConfig({
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    ADMIN_TOKEN,
    LOG_LEVEL: "error",
  });
  const log = createLogger("test-chapters", "error");
  let app: FastifyInstance;
  let ctx: AppContext;
  const root = { authorization: `Bearer ${ADMIN_TOKEN}` };

  /**
   * server.ts is owned by another module's integrator, so probe first and
   * register by hand only when these routes are absent; registering twice
   * throws, and skipping when they are wired would test a different server than
   * production runs.
   */
  async function buildApp(): Promise<FastifyInstance> {
    const probe = buildServer(ctx);
    await probe.ready();
    if (probe.hasRoute({ method: "GET", url: "/api/v1/admin/chapters" })) return probe;
    await probe.close();
    const fresh = buildServer(ctx);
    registerChapterRoutes(fresh, ctx);
    await fresh.ready();
    return fresh;
  }

  beforeEach(async () => {
    await resetDb(prisma);
    await prisma.apiToken.deleteMany({});
    ctx = buildContext(prisma, config, log);
    app = await buildApp();
  });
  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  const csrf = { "x-requested-with": "publoader-dash" };

  let seq = 0;
  const uuid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

  /** A published chapter, as the uploader would have recorded it. */
  async function uploaded(overrides: Record<string, unknown> = {}) {
    seq += 1;
    return prisma.uploadedChapter.create({
      data: {
        mdChapterId: uuid(seq),
        extension: "exampleext",
        chapterId: `src-${seq}`,
        chapterNumber: String(seq),
        chapterTitle: `Chapter ${seq}`,
        chapterLanguage: "en",
        chapterUrl: `https://publisher.example/ch/${seq}`,
        mangaName: "Test Series",
        mangaUrl: "https://publisher.example/series",
        mdMangaId: uuid(900),
        mdGroupId: uuid(800),
        chapterTimestamp: new Date("2026-01-01T00:00:00.000Z"),
        ...overrides,
      },
    });
  }

  async function mint(scopes: string[]): Promise<Record<string, string>> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/tokens",
      headers: root,
      payload: { name: `chapters-${scopes.join("-")}-${(seq += 1)}`, scopes },
    });
    expect(res.statusCode).toBe(201);
    return { authorization: `Bearer ${res.json().token}` };
  }

  /** A logged-in session cookie for a fresh account with `role`. */
  async function sessionAs(role: "ADMIN" | "CONTRIBUTOR", email: string): Promise<Record<string, string>> {
    await ctx.adminUsers.ensureOwner("owner@example.com");
    const password = "correct-horse-battery-staple";
    const user = await ctx.adminUsers.invite(email, role);
    await ctx.adminUsers.setPassword(user.id, password);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/admin/session",
      payload: { email, password },
    });
    expect(login.statusCode).toBe(200);
    const value = login.cookies.find((c) => c.name === "publoader_session")!.value;
    return { cookie: `publoader_session=${value}`, ...csrf };
  }

  // ---- read ----

  it("lists an archive newest first, with filters, totals and a facet", async () => {
    const first = await uploaded({ chapterLanguage: "en" });
    const second = await uploaded({ chapterLanguage: "ja", extension: "otherext", mangaName: "Second" });
    await prisma.deletedChapter.create({
      data: { mdChapterId: uuid(500), extension: "exampleext", chapterNumber: "9" },
    });

    const all = await app.inject({ method: "GET", url: "/api/v1/admin/chapters", headers: root });
    expect(all.statusCode).toBe(200);
    expect(all.json().archive).toBe("uploaded");
    expect(all.json().total).toBe(2);
    // Newest first: the row created last leads, which is the ordering an
    // operator arriving after a bad run needs.
    expect(all.json().chapters[0].mdChapterId).toBe(second.mdChapterId);
    // Global, so a narrow filter cannot hide an archive that is filling up.
    expect(all.json().totals).toEqual({ uploaded: 2, unavailable: 0, deleted: 1, edited: 0 });

    const byExtension = await app.inject({
      method: "GET",
      url: "/api/v1/admin/chapters?extension=exampleext",
      headers: root,
    });
    expect(byExtension.json().total).toBe(1);
    expect(byExtension.json().chapters[0].mdChapterId).toBe(first.mdChapterId);

    const byLanguage = await app.inject({
      method: "GET",
      url: "/api/v1/admin/chapters?language=ja",
      headers: root,
    });
    expect(byLanguage.json().total).toBe(1);

    // Search covers the ids too, so a chapter id pasted from a MangaDex URL
    // finds its row without the operator knowing which field it is.
    const bySearch = await app.inject({
      method: "GET",
      url: `/api/v1/admin/chapters?search=${encodeURIComponent(first.mdChapterId.slice(0, 8))}`,
      headers: root,
    });
    expect(bySearch.json().total).toBe(1);

    const archived = await app.inject({
      method: "GET",
      url: "/api/v1/admin/chapters?archive=deleted",
      headers: root,
    });
    expect(archived.json().total).toBe(1);

    const facet = await app.inject({
      method: "GET",
      url: "/api/v1/admin/chapters/extensions",
      headers: root,
    });
    expect(facet.json().extensions).toEqual(
      expect.arrayContaining([
        { extension: "exampleext", count: 1 },
        { extension: "otherext", count: 1 },
      ]),
    );
  });

  it("pages by cursor without repeating or skipping a row", async () => {
    const created = [];
    for (let i = 0; i < 5; i++) created.push(await uploaded());

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const res: Awaited<ReturnType<typeof app.inject>> = await app.inject({
        method: "GET",
        url: `/api/v1/admin/chapters?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        headers: root,
      });
      expect(res.statusCode).toBe(200);
      seen.push(...res.json().chapters.map((c: { mdChapterId: string }) => c.mdChapterId));
      cursor = res.json().nextCursor;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(5);
    expect(seen.length).toBe(5);
    expect([...seen].sort()).toEqual(created.map((c) => c.mdChapterId).sort());

    const bogus = await app.inject({
      method: "GET",
      url: "/api/v1/admin/chapters?cursor=not-a-cursor",
      headers: root,
    });
    expect(bogus.statusCode).toBe(400);
  });

  it("shows one chapter, its archives, its queue rows and why MangaDex is unreadable", async () => {
    const chapter = await uploaded();
    await prisma.editedChapter.create({
      data: {
        mdChapterId: chapter.mdChapterId,
        extension: "exampleext",
        edits: [{ editedAt: "2026-02-02T00:00:00.000Z", old: { title: "was" }, new: { title: "now" } }],
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/admin/chapters/${chapter.mdChapterId}`,
      headers: root,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.chapter.mangaName).toBe("Test Series");
    expect(body.archives.uploaded).not.toBeNull();
    expect(body.archives.edited).not.toBeNull();
    expect(body.archives.deleted).toBeNull();
    expect(body.edits).toHaveLength(1);
    expect(body.tasks).toEqual([]);
    // No MangaDex credentials on this instance: the row still answers in full
    // and the live column says why it is missing, rather than 500ing.
    expect(body.mangadex).toBeNull();
    expect(body.mangadexError).toMatch(/no MangaDex credentials/);
    expect(body.links.chapter).toBe(`https://mangadex.org/chapter/${chapter.mdChapterId}`);
    expect(body.actionsBlockedReason).toBeNull();

    const missing = await app.inject({
      method: "GET",
      url: `/api/v1/admin/chapters/${uuid(404)}`,
      headers: root,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("renders the unavailable card as a PNG without queueing anything", async () => {
    const chapter = await uploaded();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/admin/chapters/${chapter.mdChapterId}/card.png?footerNote=${encodeURIComponent("Taken down.")}`,
      headers: root,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    // A real PNG, not an error page rendered as one.
    expect(res.rawPayload.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(await prisma.uploadTask.count()).toBe(0);
  });

  // ---- edit ----

  it("queues an edit carrying the payload and what the fields looked like", async () => {
    const chapter = await uploaded({ chapterNumber: "12", chapterTitle: "Old title" });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/chapters/${chapter.mdChapterId}`,
      headers: root,
      payload: { title: "New title", chapter: "12.1" },
    });
    // 202: queued, not applied. Anything else would be claiming the chapter has
    // already changed on MangaDex.
    expect(res.statusCode).toBe(202);
    expect(res.json().action).toBe("EDIT");
    expect(res.json().superseded).toBe(false);

    const task = await prisma.uploadTask.findFirstOrThrow({ where: { kind: "EDIT" } });
    expect(task.dedupeKey).toBe(chapter.mdChapterId);
    expect(task.state).toBe("PENDING");
    const payload = task.chapter as Record<string, unknown>;
    expect(payload.payload).toEqual({ title: "New title", chapter: "12.1" });
    // The history is only worth keeping if "old" is what was really there.
    expect(payload.oldInfo).toEqual({ title: "Old title", chapter: "12" });
    // Built like a processor payload, so the uploader finds the whole chapter.
    expect(payload.mdChapterId).toBe(chapter.mdChapterId);
    expect(payload.mdMangaId).toBe(chapter.mdMangaId);

    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "chapter.edit" } });
    expect(audit.subject).toBe(chapter.mdChapterId);
  });

  it("refuses an empty edit and a language MangaDex does not have", async () => {
    const chapter = await uploaded();

    const empty = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/chapters/${chapter.mdChapterId}`,
      headers: root,
      payload: {},
    });
    expect(empty.statusCode).toBe(400);

    const unknownField = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/chapters/${chapter.mdChapterId}`,
      headers: root,
      payload: { chapterNumber: "12" },
    });
    // Our column names are not MangaDex's field names, and a misspelling must
    // not look like an edit that changed nothing.
    expect(unknownField.statusCode).toBe(400);

    const badLanguage = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/chapters/${chapter.mdChapterId}`,
      headers: root,
      payload: { translatedLanguage: "klingon" },
    });
    expect(badLanguage.statusCode).toBe(400);

    const badUrl = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/chapters/${chapter.mdChapterId}`,
      headers: root,
      payload: { externalUrl: "javascript:alert(1)" },
    });
    expect(badUrl.statusCode).toBe(400);
    expect(await prisma.uploadTask.count()).toBe(0);
  });

  it("refuses a second action while one is queued, and supersedes a completed one", async () => {
    const chapter = await uploaded();

    const first = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/chapters/${chapter.mdChapterId}`,
      headers: root,
      payload: { title: "One" },
    });
    expect(first.statusCode).toBe(202);
    const taskId = first.json().task.id;

    const second = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/chapters/${chapter.mdChapterId}`,
      headers: root,
      payload: { title: "Two" },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().outcome).toBe("already_queued");
    // The queued work is untouched: rewriting it would change what an operator
    // watching the queue is watching.
    const stillOne = await prisma.uploadTask.findUniqueOrThrow({ where: { id: taskId } });
    expect((stillOne.chapter as { payload: { title: string } }).payload.title).toBe("One");

    // A LEASED row belongs to a live uploader and is refused for the same reason.
    await prisma.uploadTask.update({
      where: { id: taskId },
      data: { state: "LEASED", leaseId: uuid(700), leaseExpiresAt: new Date(Date.now() + 60_000) },
    });
    const whileLeased = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/chapters/${chapter.mdChapterId}`,
      headers: root,
      payload: { title: "Three" },
    });
    expect(whileLeased.statusCode).toBe(409);
    expect(whileLeased.json().outcome).toBe("leased");

    // Once it has run, the slot is reusable; otherwise a chapter could be
    // edited exactly once, ever, because nothing deletes DONE rows.
    await prisma.uploadTask.update({ where: { id: taskId }, data: { state: "DONE", leaseId: null } });
    const again = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/chapters/${chapter.mdChapterId}`,
      headers: root,
      payload: { title: "Four" },
    });
    expect(again.statusCode).toBe(202);
    expect(again.json().superseded).toBe(true);
    // Same row, reset in place: the unique (kind, dedupe_key) constraint is what
    // makes a double upload impossible and is never worked around.
    expect(again.json().task.id).toBe(taskId);
    expect(await prisma.uploadTask.count({ where: { kind: "EDIT" } })).toBe(1);
    const reset = await prisma.uploadTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(reset.state).toBe("PENDING");
    expect(reset.attempt).toBe(0);
    expect((reset.chapter as { payload: { title: string } }).payload.title).toBe("Four");
  });

  // ---- unavailable ----

  it("queues an unavailable card, and needs force to replace one already posted", async () => {
    const chapter = await uploaded();

    const first = await app.inject({
      method: "POST",
      url: `/api/v1/admin/chapters/${chapter.mdChapterId}/unavailable`,
      headers: root,
      payload: { footerNote: "Pulled by the publisher." },
    });
    expect(first.statusCode).toBe(202);
    const queued = await prisma.uploadTask.findFirstOrThrow({ where: { kind: "UNAVAILABLE" } });
    const payload = queued.chapter as Record<string, unknown>;
    expect(payload.footerNote).toBe("Pulled by the publisher.");
    expect(payload.unavailableAt).toBeTruthy();
    expect(payload.force).toBeUndefined();

    // Pretend the uploader ran it.
    await prisma.uploadTask.update({ where: { id: queued.id }, data: { state: "DONE" } });
    await prisma.unavailableChapter.create({
      data: { mdChapterId: chapter.mdChapterId, extension: "exampleext" },
    });

    const withoutForce = await app.inject({
      method: "POST",
      url: `/api/v1/admin/chapters/${chapter.mdChapterId}/unavailable`,
      headers: root,
      payload: {},
    });
    // Silently doing nothing is the failure mode this refusal exists to avoid.
    expect(withoutForce.statusCode).toBe(409);
    expect(withoutForce.json().outcome).toBe("already_unavailable");

    const forced = await app.inject({
      method: "POST",
      url: `/api/v1/admin/chapters/${chapter.mdChapterId}/unavailable`,
      headers: root,
      payload: { force: true, footerNote: "Corrected wording." },
    });
    expect(forced.statusCode).toBe(202);
    const regenerated = await prisma.uploadTask.findUniqueOrThrow({ where: { id: queued.id } });
    expect((regenerated.chapter as Record<string, unknown>).force).toBe(true);
    expect(regenerated.state).toBe("PENDING");
  });

  // ---- delete ----

  it("needs confirmation to delete, and records what it removed", async () => {
    const chapter = await uploaded();

    const unconfirmed = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/chapters/${chapter.mdChapterId}`,
      headers: root,
      payload: {},
    });
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.json().alternative).toMatch(/unavailable/);
    expect(await prisma.uploadTask.count()).toBe(0);

    const confirmed = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/chapters/${chapter.mdChapterId}`,
      headers: root,
      payload: { confirm: true, reason: "duplicate upload" },
    });
    expect(confirmed.statusCode).toBe(202);
    expect(confirmed.json().action).toBe("DELETE");
    const task = await prisma.uploadTask.findFirstOrThrow({ where: { kind: "DELETE" } });
    expect(task.dedupeKey).toBe(chapter.mdChapterId);

    // After the uploader runs, this row and deleted_chapters are the only
    // records that the chapter existed.
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "chapter.delete" } });
    expect((audit.detail as { reason: string }).reason).toBe("duplicate upload");
    expect((audit.detail as { chapter: { chapterTitle: string } }).chapter.chapterTitle).toBeTruthy();

    // The live row is left alone until the uploader succeeds; a queued delete
    // that fails must not have already erased our record of the chapter.
    expect(await prisma.uploadedChapter.count()).toBe(1);
  });

  it("refuses every action on a chapter already recorded as deleted", async () => {
    const mdChapterId = uuid(600);
    await prisma.deletedChapter.create({
      data: { mdChapterId, extension: "exampleext", chapterNumber: "3" },
    });

    for (const call of [
      app.inject({
        method: "PATCH",
        url: `/api/v1/admin/chapters/${mdChapterId}`,
        headers: root,
        payload: { title: "x" },
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/admin/chapters/${mdChapterId}/unavailable`,
        headers: root,
        payload: {},
      }),
      app.inject({
        method: "DELETE",
        url: `/api/v1/admin/chapters/${mdChapterId}`,
        headers: root,
        payload: { confirm: true },
      }),
    ]) {
      const res = await call;
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/recorded as deleted/);
    }
    expect(await prisma.uploadTask.count()).toBe(0);
  });

  // ---- bulk ----

  describe("bulk actions", () => {
    const bulk = (action: string, payload: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: `/api/v1/admin/chapters/bulk/${action}`,
        headers: root,
        payload,
      });

    it("previews by default and writes nothing at all", async () => {
      const a = await uploaded();
      const b = await uploaded();

      const preview = await bulk("delete", { ids: [a.mdChapterId, b.mdChapterId] });
      expect(preview.statusCode).toBe(200);
      expect(preview.json().dryRun).toBe(true);
      expect(preview.json().wouldQueue).toBe(2);
      // Predictive, not an estimate: every chapter is named with what would
      // happen to it.
      expect(preview.json().results.map((r: { outcome: string }) => r.outcome)).toEqual([
        "would_queue",
        "would_queue",
      ]);
      expect(preview.json().results[0].mangaName).toBe("Test Series");
      // Not even an audit row; the first call anyone makes is inert.
      expect(await prisma.uploadTask.count()).toBe(0);
      expect(await prisma.auditEvent.count()).toBe(0);

      // dryRun: false alone is not enough; the two flags cannot both be set by
      // accident.
      const unconfirmed = await bulk("delete", { ids: [a.mdChapterId], dryRun: false });
      expect(unconfirmed.statusCode).toBe(400);
      expect(await prisma.uploadTask.count()).toBe(0);
    });

    it("queues one task per chapter and audits each one by subject", async () => {
      const a = await uploaded();
      const b = await uploaded();

      const res = await bulk("delete", {
        ids: [a.mdChapterId, b.mdChapterId],
        dryRun: false,
        confirm: true,
        reason: "bad run",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().queued).toBe(2);
      expect(res.json().refused).toBe(0);
      expect(res.json().results.every((r: { taskId?: string }) => r.taskId)).toBe(true);

      const tasks = await prisma.uploadTask.findMany({ where: { kind: "DELETE" } });
      expect(tasks.map((t) => t.dedupeKey).sort()).toEqual([a.mdChapterId, b.mdChapterId].sort());

      // Per-chapter rows, so "why was this chapter deleted?" is answerable by
      // subject, a batch that wrote only a summary would not answer it, plus
      // one summary row correlating them.
      const perChapter = await prisma.auditEvent.findMany({ where: { action: "chapter.delete" } });
      expect(perChapter.map((e) => e.subject).sort()).toEqual([a.mdChapterId, b.mdChapterId].sort());
      const summary = await prisma.auditEvent.findFirstOrThrow({
        where: { action: "chapter.delete.bulk" },
      });
      expect((summary.detail as { queued: number }).queued).toBe(2);
      expect((perChapter[0]!.detail as { bulk: string }).bulk).toBe(summary.subject);
      expect((perChapter[0]!.detail as { reason: string }).reason).toBe("bad run");
    });

    it("acts on everything a filter matches, and caps what one call may touch", async () => {
      for (let i = 0; i < 3; i++) await uploaded({ extension: "bulkext", mangaName: "Bulk Series" });
      const other = await uploaded({ extension: "otherext" });

      const preview = await bulk("unavailable", { filter: { extension: "bulkext" } });
      expect(preview.json().matched).toBe(3);
      expect(preview.json().wouldQueue).toBe(3);
      expect(preview.json().breakdown).toEqual([{ extension: "bulkext", count: 3 }]);

      const applied = await bulk("unavailable", {
        filter: { extension: "bulkext" },
        dryRun: false,
        confirm: true,
        footerNote: "Publisher pulled the series.",
      });
      expect(applied.json().queued).toBe(3);
      const tasks = await prisma.uploadTask.findMany({ where: { kind: "UNAVAILABLE" } });
      expect(tasks).toHaveLength(3);
      expect((tasks[0]!.chapter as Record<string, unknown>).footerNote).toBe(
        "Publisher pulled the series.",
      );
      // The filter is the whole selection: a chapter outside it is untouched.
      expect(tasks.some((t) => t.dedupeKey === other.mdChapterId)).toBe(false);
    });

    it("reports per chapter when only some of a batch can be queued", async () => {
      const fine = await uploaded();
      const carded = await uploaded();
      const removed = await uploaded();
      // Already carries a card: needs `force`.
      await prisma.unavailableChapter.create({
        data: { mdChapterId: carded.mdChapterId, extension: "exampleext" },
      });
      // Already queued by hand, and not run yet.
      await prisma.uploadTask.create({
        data: { kind: "UNAVAILABLE", dedupeKey: removed.mdChapterId, chapter: {} },
      });

      const ids = [fine.mdChapterId, carded.mdChapterId, removed.mdChapterId, uuid(999)];
      const preview = await bulk("unavailable", { ids });
      const outcomes = Object.fromEntries(
        preview.json().results.map((r: { mdChapterId: string; outcome: string }) => [r.mdChapterId, r.outcome]),
      );
      expect(outcomes[fine.mdChapterId]).toBe("would_queue");
      expect(outcomes[carded.mdChapterId]).toBe("needs_force");
      expect(outcomes[removed.mdChapterId]).toBe("already_queued");
      expect(outcomes[uuid(999)]).toBe("not_found");

      const applied = await bulk("unavailable", { ids, dryRun: false, confirm: true });
      expect(applied.json().queued).toBe(1);
      expect(applied.json().refused).toBe(3);
      // The one that could go, went; the refusals left everything as it was.
      expect(await prisma.uploadTask.count({ where: { kind: "UNAVAILABLE" } })).toBe(2);

      // `force` unblocks the carded one without touching the other refusals.
      const forced = await bulk("unavailable", { ids, dryRun: false, confirm: true, force: true });
      expect(forced.json().queued).toBe(1);
      const regenerated = await prisma.uploadTask.findFirstOrThrow({
        where: { kind: "UNAVAILABLE", dedupeKey: carded.mdChapterId },
      });
      expect((regenerated.chapter as Record<string, unknown>).force).toBe(true);
    });

    it("limits a bulk edit to the fields a set of chapters can share", async () => {
      const chapter = await uploaded();

      // Per-chapter identity is not expressible here, rather than merely
      // discouraged: one title across two hundred chapters is a mistake with a
      // keyboard shortcut.
      for (const changes of [{ title: "One title" }, { chapter: "12" }, { externalUrl: "https://x.example" }]) {
        const res = await bulk("edit", { ids: [chapter.mdChapterId], changes });
        expect(res.statusCode).toBe(400);
      }
      expect((await bulk("edit", { ids: [chapter.mdChapterId], changes: {} })).statusCode).toBe(400);
      expect(
        (await bulk("edit", { ids: [chapter.mdChapterId], changes: { translatedLanguage: "klingon" } }))
          .statusCode,
      ).toBe(400);

      const res = await bulk("edit", {
        ids: [chapter.mdChapterId],
        changes: { volume: "3", translatedLanguage: "pt-br" },
        dryRun: false,
        confirm: true,
      });
      expect(res.statusCode).toBe(200);
      const task = await prisma.uploadTask.findFirstOrThrow({ where: { kind: "EDIT" } });
      expect((task.chapter as { payload: Record<string, string> }).payload).toEqual({
        volume: "3",
        translatedLanguage: "pt-br",
      });
    });

    it("refuses a body that names both a selection and a filter, or neither", async () => {
      const chapter = await uploaded();
      expect(
        (await bulk("delete", { ids: [chapter.mdChapterId], filter: { extension: "exampleext" } }))
          .statusCode,
      ).toBe(400);
      expect((await bulk("delete", {})).statusCode).toBe(400);
    });

    it("keeps bulk behind the same role gate as the single-chapter routes", async () => {
      const chapter = await uploaded();
      const writer = await mint(["chapters:write"]);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/chapters/bulk/delete",
        headers: writer,
        payload: { ids: [chapter.mdChapterId], dryRun: false, confirm: true },
      });
      expect(res.statusCode).toBe(403);
      expect(await prisma.uploadTask.count()).toBe(0);
    });
  });

  // ---- authorisation ----

  it("keeps published chapters out of reach of scopes and roles that should not have them", async () => {
    const chapter = await uploaded();

    const reader = await mint(["chapters:read"]);
    const listed = await app.inject({ method: "GET", url: "/api/v1/admin/chapters", headers: reader });
    expect(listed.statusCode).toBe(200);
    const readerWrite = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/chapters/${chapter.mdChapterId}`,
      headers: reader,
      payload: { title: "no" },
    });
    expect(readerWrite.statusCode).toBe(403);

    // The sharpest case: a machine credential scoped for exactly this work is
    // still refused, because an api-token is never ADMIN.
    const writer = await mint(["chapters:write"]);
    const tokenWrite = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/chapters/${chapter.mdChapterId}`,
      headers: writer,
      payload: { confirm: true },
    });
    expect(tokenWrite.statusCode).toBe(403);
    expect(tokenWrite.json().error).toMatch(/closed to api tokens/);
    expect(tokenWrite.json().requiredRole).toBe("ADMIN");

    // A run-triggering credential has no business here at all.
    const runner = await mint(["runs:write"]);
    const runnerRead = await app.inject({
      method: "GET",
      url: "/api/v1/admin/chapters",
      headers: runner,
    });
    expect(runnerRead.statusCode).toBe(403);

    const contributor = await sessionAs("CONTRIBUTOR", "contrib@example.com");
    const contributorRead = await app.inject({
      method: "GET",
      url: "/api/v1/admin/chapters",
      headers: contributor,
    });
    expect(contributorRead.statusCode).toBe(403);

    const admin = await sessionAs("ADMIN", "admin@example.com");
    const adminWrite = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/chapters/${chapter.mdChapterId}`,
      headers: admin,
      payload: { title: "yes" },
    });
    expect(adminWrite.statusCode).toBe(202);

    expect(await prisma.uploadTask.count()).toBe(1);
  });

  // ---- the uploader half ----

  describe("the uploader executing a regeneration", () => {
    /**
     * A chapter that has already been marked unavailable: MangaDex still has
     * the entry, its externalUrl was repointed at the publisher's site root,
     * and its only page is the card posted last time.
     */
    const detail = (): MdChapterDetail => ({
      id: uuid(1),
      attributes: {
        volume: null,
        chapter: "1",
        title: "Chapter one",
        translatedLanguage: "en",
        externalUrl: null,
        version: 3,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      relationships: [{ id: uuid(800), type: "scanlation_group" }],
    });

    function stubMd(calls: string[]): MdExtendedApi {
      const unexpected = (name: string) => () => {
        throw new Error(`the uploader should not call ${name} in this test`);
      };
      return {
        chapterById: async () => {
          calls.push("chapterById");
          return detail();
        },
        beginEditSession: async () => {
          calls.push("beginEditSession");
          return { id: uuid(701) };
        },
        uploadImages: async (_session: string, files: { name: string; data: Buffer }[]) => {
          calls.push(`uploadImages:${files.length}`);
          return files.map((file, index) => ({
            id: uuid(710 + index),
            originalFileName: file.name,
            fileSize: file.data.length,
          }));
        },
        commitUploadSession: async () => {
          calls.push("commitUploadSession");
          return { id: uuid(1), attributes: { version: 4 } };
        },
        editChapter: async () => {
          calls.push("editChapter");
          return true;
        },
        deleteChapter: unexpected("deleteChapter"),
        chaptersForManga: unexpected("chaptersForManga"),
        chaptersByIds: unexpected("chaptersByIds"),
        mangaByIds: unexpected("mangaByIds"),
        mangaById: unexpected("mangaById"),
        searchManga: unexpected("searchManga"),
        mangaAggregate: unexpected("mangaAggregate"),
        currentUploadSession: unexpected("currentUploadSession"),
        deleteUploadSession: async () => {
          calls.push("deleteUploadSession");
        },
        createUploadSession: unexpected("createUploadSession"),
        createMangaDraft: unexpected("createMangaDraft"),
        commitMangaDraft: unexpected("commitMangaDraft"),
        editManga: unexpected("editManga"),
      } as unknown as MdExtendedApi;
    }

    const notifier = { enabled: false, send: async () => {} };

    async function run(force: boolean): Promise<string[]> {
      const calls: string[] = [];
      const workers = new UploadTaskWorkers({
        prisma,
        md: stubMd(calls),
        notifier: notifier as never,
        // A real store against the test database rather than a stub: the worker
        // reads settings to decide whether to send per-chapter embeds, and the
        // defaults it returns are the ones production starts from.
        settings: new SettingsStore(prisma),
        config,
        log,
      });
      const task = await prisma.uploadTask.create({
        data: {
          kind: "UNAVAILABLE",
          dedupeKey: uuid(1),
          state: "LEASED",
          chapter: {
            mdChapterId: uuid(1),
            mdMangaId: uuid(900),
            mdGroupId: uuid(800),
            chapterNumber: "1",
            chapterLanguage: "en",
            mangaName: "Test Series",
            mangaUrl: "https://publisher.example/series",
            extensionName: "exampleext",
            imageArtifacts: [],
            ...(force ? { force: true, footerNote: "Corrected wording." } : {}),
          },
        },
      });
      await workers.execute(task);
      return calls;
    }

    it("archives without touching MangaDex when the card is already posted", async () => {
      const calls = await run(false);
      // The automated pass is right to stop here: the work is done.
      expect(calls).toEqual(["chapterById"]);
      expect(await prisma.unavailableChapter.count()).toBe(1);
    });

    it("renders and posts a fresh card when the operator forces it", async () => {
      const calls = await run(true);
      expect(calls).toContain("beginEditSession");
      // One page: the card itself, replacing whatever was there.
      expect(calls).toContain("uploadImages:1");
      expect(calls).toContain("commitUploadSession");
      expect(calls).toContain("editChapter");
      const archived = await prisma.unavailableChapter.findUniqueOrThrow({
        where: { mdChapterId: uuid(1) },
      });
      expect(archived.chapterNumber).toBe("1");
    });
  });
});
