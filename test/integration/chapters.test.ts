import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import { buildContext, type AppContext } from "../../src/core/api/context.js";
import { buildServer } from "../../src/core/api/server.js";
import { registerChapterRoutes } from "../../src/core/api/routes/chapters.js";
import { closeDb, dbReady, resetDb, testPrisma } from "./db.js";

/**
 * Chapter visibility and correction: the three views of a chapter, and the one
 * write.
 *
 * These need a real Postgres for the same reason the queue tests do, and for one
 * more: two of the three read paths are `jsonb` unnests and window functions
 * over live tables — `jsonb_array_elements … WITH ORDINALITY` on stored
 * envelopes, and `row_number()` over the claim ordering. A mock would assert
 * that the strings were assembled, not that they answer the question.
 *
 * What is worth proving here:
 *
 *  - a run's chapters come back in the extension's own order, and a segment that
 *    has not reported reads as "not reported" rather than as zero chapters;
 *  - the queue's `position` is the place in the WHOLE claim order, not on the
 *    page, and it tracks a reorder;
 *  - a metadata correction becomes an EDIT task that MangaDex would accept —
 *    the diff in `payload`, the previous values in `oldInfo`, and the NEW values
 *    on the chapter, since the uploader mirrors that chapter back into
 *    `uploaded_chapters` on success;
 *  - and the three refusals that each protect something irreversible: a second
 *    queued edit, an edit to a deleted chapter, and an edit that would detach
 *    the chapter from our own upload group.
 */
describe.skipIf(!dbReady())("chapter views and metadata correction", () => {
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
  const csrf = { "x-requested-with": "publoader-dash" };

  const MD_MANGA = "9a1b1c1d-0000-4000-8000-000000000000";
  const MD_GROUP = "4f1de6a2-f0c5-4ac5-bce5-02c7dbb67deb";
  const MD_CHAPTER = "1c2d3e4f-0000-4000-8000-000000000001";

  /**
   * Same probe as queues.test.ts: register by hand only if `buildServer` has not
   * wired these routes yet, since registering twice throws on duplicate routes.
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

  /** A logged-in session cookie for a fresh account with `role`. */
  async function sessionAs(role: "OWNER" | "ADMIN" | "CONTRIBUTOR", email: string): Promise<Record<string, string>> {
    await ctx.adminUsers.ensureOwner("owner@example.com");
    if (role === "OWNER") {
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/admin/session",
        payload: { token: ADMIN_TOKEN, actor: "ardax" },
      });
      const value = login.cookies.find((c) => c.name === "publoader_session")!.value;
      return { cookie: `publoader_session=${value}`, ...csrf };
    }
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

  async function mint(scopes: string[]): Promise<Record<string, string>> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/tokens",
      headers: root,
      payload: { name: `chapters-${scopes.join("-")}`, scopes },
    });
    expect(res.statusCode).toBe(201);
    return { authorization: `Bearer ${res.json().token}` };
  }

  // ------------------------------------------------------ seeding helpers

  const chapterRecord = (overrides: Record<string, unknown> = {}) => ({
    chapterLookup: null,
    chapterTimestamp: "2026-08-01T00:00:00.000Z",
    chapterExpire: null,
    chapterLanguage: "en",
    chapterNumber: "1",
    chapterTitle: null,
    chapterVolume: null,
    chapterId: "src-1",
    chapterUrl: "https://example.test/1",
    mdChapterId: null,
    mangaId: "m-1",
    mdMangaId: MD_MANGA,
    mdGroupId: MD_GROUP,
    mangaName: "Test Series",
    mangaUrl: "https://example.test/series",
    extensionName: "chaptertest",
    imageArtifacts: [],
    ...overrides,
  });

  /** A run with `segments` jobs, and a committed envelope for the first `reported`. */
  async function seedRun(opts: {
    segments: number;
    reported: number;
    chaptersPerSegment: Record<string, unknown>[][];
    allChapters?: Record<string, unknown>[][] | null;
  }) {
    const run = await prisma.run.create({
      data: {
        idempotencyKey: `run-${Math.random()}`,
        extension: "chaptertest",
        extensionVersion: "1.0.0",
        bundleSha256: "a".repeat(64),
        kind: "UPDATE",
        state: "PROCESSED",
        segmentsTotal: opts.segments,
      },
    });
    const jobs = [];
    for (let index = 0; index < opts.segments; index++) {
      const job = await prisma.job.create({
        data: {
          idempotencyKey: `job-${run.id}-${index}`,
          runId: run.id,
          extension: "chaptertest",
          extensionVersion: "1.0.0",
          bundleSha256: "a".repeat(64),
          kind: "UPDATE",
          segmentIndex: index,
          segmentTotal: opts.segments,
          segmentKey: `seg${index}`,
          state: index < opts.reported ? "SUCCEEDED" : "PENDING",
        },
      });
      jobs.push(job);
      if (index >= opts.reported) continue;
      await prisma.resultSubmission.create({
        data: {
          idempotencyKey: `res-${job.id}`,
          jobId: job.id,
          attempt: 1,
          leaseId: "22222222-2222-4222-8222-222222222222",
          workerId: "w1",
          state: "COMMITTED",
          // Cast at the boundary: Prisma's InputJsonValue does not accept a
          // Record<string, unknown>[] (no index signature), and the shape here
          // is a real envelope rather than something worth a type of its own.
          envelope: {
            envelopeVersion: 1,
            extension: "chaptertest",
            status: "ok",
            updatedChapters: opts.chaptersPerSegment[index] ?? [],
            allChapters: opts.allChapters ? (opts.allChapters[index] ?? []) : null,
            untrackedManga: [],
          } as unknown as Prisma.InputJsonValue,
        },
      });
    }
    return { run, jobs };
  }

  /** A chapter in the canonical `uploaded_chapters` mirror. */
  const uploaded = (overrides: Record<string, unknown> = {}) =>
    prisma.uploadedChapter.create({
      data: {
        mdChapterId: MD_CHAPTER,
        extension: "chaptertest",
        chapterId: "src-1",
        chapterUrl: "https://example.test/1",
        chapterNumber: "1",
        chapterTitle: "Beginnings",
        chapterVolume: "1",
        chapterLanguage: "en",
        mangaId: "m-1",
        mangaName: "Test Series",
        mdMangaId: MD_MANGA,
        mdGroupId: MD_GROUP,
        ...overrides,
      },
    });

  let seq = 0;
  const queued = (overrides: Record<string, unknown> = {}) =>
    prisma.uploadTask.create({
      data: {
        kind: "UPLOAD",
        dedupeKey: `src-${(seq += 1)}|${seq}|en`,
        chapter: {
          chapterId: `src-${seq}`,
          chapterNumber: String(seq),
          chapterLanguage: "en",
          mangaName: "Test Series",
          mdMangaId: MD_MANGA,
          extensionName: "chaptertest",
        },
        ...overrides,
      },
    });

  // -------------------------------------------------- 1. found, per run

  it("reports what a run found, in the extension's own order, per segment", async () => {
    const { run } = await seedRun({
      segments: 2,
      reported: 2,
      chaptersPerSegment: [
        [chapterRecord({ chapterNumber: "1" }), chapterRecord({ chapterNumber: "2", chapterId: "src-2" })],
        [chapterRecord({ chapterNumber: "3", chapterId: "src-3", mangaName: "Other Series" })],
      ],
    });

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/admin/runs/${run.id}/chapters`,
      headers: root,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().total).toBe(3);
    // Segment order first, then the position the extension reported them in —
    // this is the extension's own ordering, not a sort we imposed.
    expect(list.json().chapters.map((c: { position: number; segmentIndex: number }) => [c.segmentIndex, c.position])).toEqual([
      [0, 1],
      [0, 2],
      [1, 1],
    ]);
    expect(list.json().chapters[0].chapter.chapterNumber).toBe("1");

    const summary = await app.inject({
      method: "GET",
      url: `/api/v1/admin/runs/${run.id}/chapters/summary`,
      headers: root,
    });
    expect(summary.json().totals.updated).toBe(3);
    expect(summary.json().complete).toBe(true);
    expect(summary.json().segmentsReported).toBe(2);
    // Grouped by title, so "41 chapters across 9 series" is one read.
    expect(summary.json().byManga).toHaveLength(1);
    expect(summary.json().byManga[0].count).toBe(3);
  });

  it("distinguishes a segment that found nothing from one that has not reported", async () => {
    const { run } = await seedRun({
      segments: 3,
      reported: 2,
      chaptersPerSegment: [[chapterRecord()], []],
    });

    const summary = await app.inject({
      method: "GET",
      url: `/api/v1/admin/runs/${run.id}/chapters/summary`,
      headers: root,
    });
    const segments = summary.json().segments;
    expect(segments).toHaveLength(3);
    // Zero is a report of nothing; null is no report at all. Collapsing the two
    // would let a run that half-failed read as a run that found one chapter.
    expect(segments[1].updated).toBe(0);
    expect(segments[2].updated).toBeNull();
    expect(summary.json().complete).toBe(false);
    expect(summary.json().segmentsReported).toBe(2);
  });

  it("separates the new-or-changed set from the catalogue snapshot", async () => {
    const { run } = await seedRun({
      segments: 1,
      reported: 1,
      chaptersPerSegment: [[chapterRecord({ chapterNumber: "9" })]],
      allChapters: [[chapterRecord({ chapterNumber: "1" }), chapterRecord({ chapterNumber: "9" })]],
    });

    const updated = await app.inject({
      method: "GET",
      url: `/api/v1/admin/runs/${run.id}/chapters?set=updated`,
      headers: root,
    });
    expect(updated.json().total).toBe(1);

    const all = await app.inject({
      method: "GET",
      url: `/api/v1/admin/runs/${run.id}/chapters?set=all`,
      headers: root,
    });
    expect(all.json().total).toBe(2);

    // An extension that sends no snapshot reports null, not zero: removal
    // detection is skipped in that case and the difference has to be visible.
    const { run: noSnapshot } = await seedRun({
      segments: 1,
      reported: 1,
      chaptersPerSegment: [[chapterRecord()]],
    });
    const summary = await app.inject({
      method: "GET",
      url: `/api/v1/admin/runs/${noSnapshot.id}/chapters/summary`,
      headers: root,
    });
    expect(summary.json().totals.all).toBeNull();
  });

  it("filters a run's chapters by search, series and segment", async () => {
    const { run } = await seedRun({
      segments: 2,
      reported: 2,
      chaptersPerSegment: [
        [chapterRecord({ chapterTitle: "The Duel", chapterNumber: "1" })],
        [chapterRecord({ mangaName: "Other Series", mdMangaId: "5555aaaa-0000-4000-8000-000000000000", chapterNumber: "2" })],
      ],
    });

    const search = await app.inject({
      method: "GET",
      url: `/api/v1/admin/runs/${run.id}/chapters?q=duel`,
      headers: root,
    });
    expect(search.json().total).toBe(1);

    const bySegment = await app.inject({
      method: "GET",
      url: `/api/v1/admin/runs/${run.id}/chapters?segmentIndex=1`,
      headers: root,
    });
    expect(bySegment.json().total).toBe(1);
    expect(bySegment.json().chapters[0].chapter.mangaName).toBe("Other Series");

    const byManga = await app.inject({
      method: "GET",
      url: `/api/v1/admin/runs/${run.id}/chapters?mdMangaId=${MD_MANGA}`,
      headers: root,
    });
    expect(byManga.json().total).toBe(1);
  });

  it("puts the chapters-found count on the runs list without a query per run", async () => {
    await seedRun({ segments: 1, reported: 1, chaptersPerSegment: [[chapterRecord(), chapterRecord()]] });
    await seedRun({ segments: 1, reported: 0, chaptersPerSegment: [] });

    const runs = await app.inject({ method: "GET", url: "/api/v1/admin/runs", headers: root });
    const counts = runs.json().runs.map((r: { chaptersFound: number | null }) => r.chaptersFound);
    expect(counts).toContain(2);
    // The unreported run reads "—", not "0".
    expect(counts).toContain(null);
  });

  // -------------------------------------------- 2. queued, in claim order

  it("reads the queue as chapters, numbered by their place in the whole claim order", async () => {
    const later = await queued({ notBefore: new Date(Date.now() + 600_000) });
    const soon = await queued({ notBefore: new Date(Date.now() - 600_000) });
    const middle = await queued({ notBefore: new Date(Date.now() - 60_000) });

    const res = await app.inject({ method: "GET", url: "/api/v1/admin/queues/chapters", headers: root });
    expect(res.statusCode).toBe(200);
    expect(res.json().order).toBe("notBefore,createdAt,id");
    const rows = res.json().chapters;
    expect(rows.map((r: { id: string }) => r.id)).toEqual([soon.id, middle.id, later.id]);
    expect(rows.map((r: { position: number }) => r.position)).toEqual([1, 2, 3]);
    // Projected from the payload, so the row names a chapter rather than a
    // dedupe key.
    expect(rows[0].mangaName).toBe("Test Series");
    expect(rows[0].chapterNumber).toBe(soon.dedupeKey.split("|")[1]);

    // Position is the place in the whole ordering, not on the page: page two of
    // a one-row page starts at 2.
    const paged = await app.inject({
      method: "GET",
      url: "/api/v1/admin/queues/chapters?limit=1",
      headers: root,
    });
    expect(paged.json().chapters[0].position).toBe(1);
    const next = await app.inject({
      method: "GET",
      url: `/api/v1/admin/queues/chapters?limit=1&cursor=${encodeURIComponent(paged.json().nextCursor)}`,
      headers: root,
    });
    expect(next.json().chapters[0].position).toBe(2);
    expect(next.json().chapters[0].id).toBe(middle.id);
  });

  it("tracks a reorder, because it reads the same ordering the uploader claims by", async () => {
    await queued({ notBefore: new Date(Date.now() - 600_000) });
    const last = await queued({ notBefore: new Date(Date.now() + 600_000) });

    const before = await app.inject({ method: "GET", url: "/api/v1/admin/queues/chapters", headers: root });
    expect(before.json().chapters.find((c: { id: string }) => c.id === last.id).position).toBe(2);

    const moved = await app.inject({
      method: "POST",
      url: "/api/v1/admin/queues/reorder",
      headers: root,
      payload: { ids: [last.id], mode: "front" },
    });
    expect(moved.statusCode).toBe(200);

    const after = await app.inject({ method: "GET", url: "/api/v1/admin/queues/chapters", headers: root });
    expect(after.json().chapters[0].id).toBe(last.id);
    expect(after.json().chapters[0].position).toBe(1);
  });

  it("defaults to PENDING and searches the payload rather than the dedupe key", async () => {
    await queued({ chapter: { mangaName: "Sakamoto Days", chapterNumber: "12", chapterLanguage: "en" } });
    await queued({ chapter: { mangaName: "Other Series", chapterNumber: "3", chapterLanguage: "en" } });
    await queued({ state: "DONE" });

    const pending = await app.inject({ method: "GET", url: "/api/v1/admin/queues/chapters", headers: root });
    expect(pending.json().total).toBe(2);

    const byName = await app.inject({
      method: "GET",
      url: "/api/v1/admin/queues/chapters?q=sakamoto",
      headers: root,
    });
    expect(byName.json().total).toBe(1);
    expect(byName.json().chapters[0].mangaName).toBe("Sakamoto Days");

    const done = await app.inject({
      method: "GET",
      url: "/api/v1/admin/queues/chapters?state=DONE",
      headers: root,
    });
    expect(done.json().total).toBe(1);
  });

  it("shows an EDIT task's diff, which is what that row is actually about", async () => {
    await queued({
      kind: "EDIT",
      dedupeKey: MD_CHAPTER,
      chapter: {
        mdChapterId: MD_CHAPTER,
        mangaName: "Test Series",
        chapterNumber: "12",
        payload: { title: "Corrected" },
        oldInfo: { title: "Wrong" },
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admin/queues/chapters?kind=EDIT",
      headers: root,
    });
    expect(res.json().chapters[0].editPayload).toEqual({ title: "Corrected" });
    expect(res.json().chapters[0].mdChapterId).toBe(MD_CHAPTER);
  });

  // ------------------------------------------- 3. already on MangaDex

  it("browses the archives and filters them", async () => {
    await uploaded();
    await uploaded({ mdChapterId: "1c2d3e4f-0000-4000-8000-000000000002", chapterNumber: "2", extension: "other", chapterLanguage: "es" });

    const all = await app.inject({ method: "GET", url: "/api/v1/admin/chapters", headers: root });
    expect(all.json().total).toBe(2);
    expect(all.json().table).toBe("uploaded");

    const byExtension = await app.inject({
      method: "GET",
      url: "/api/v1/admin/chapters?extension=chaptertest",
      headers: root,
    });
    expect(byExtension.json().total).toBe(1);

    const byLanguage = await app.inject({
      method: "GET",
      url: "/api/v1/admin/chapters?language=es",
      headers: root,
    });
    expect(byLanguage.json().total).toBe(1);

    const bySearch = await app.inject({
      method: "GET",
      url: "/api/v1/admin/chapters?q=beginnings",
      headers: root,
    });
    expect(bySearch.json().total).toBe(2);

    const extensions = await app.inject({
      method: "GET",
      url: "/api/v1/admin/chapters/extensions",
      headers: root,
    });
    expect(extensions.json().extensions).toEqual(
      expect.arrayContaining([{ extension: "chaptertest", count: 1 }, { extension: "other", count: 1 }]),
    );
  });

  it("shows one chapter across all four archives, with its history and queued work", async () => {
    await uploaded();
    await prisma.editedChapter.create({
      data: {
        mdChapterId: MD_CHAPTER,
        extension: "chaptertest",
        chapterNumber: "1",
        edits: [{ editedAt: "2026-07-01T00:00:00.000Z", old: { title: "Typo" }, new: { title: "Beginnings" } }],
      },
    });
    const task = await queued({ kind: "EDIT", dedupeKey: MD_CHAPTER, chapter: { mdChapterId: MD_CHAPTER, payload: { volume: "2" } } });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/admin/chapters/${MD_CHAPTER}`,
      headers: root,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().present).toEqual(expect.arrayContaining(["uploaded", "edited"]));
    expect(res.json().edits).toHaveLength(1);
    expect(res.json().queued.map((t: { id: string }) => t.id)).toContain(task.id);
    expect(res.json().editable).toBe(true);
    // The MangaDex-shaped starting point for an edit, so the form does not have
    // to re-derive it from column names.
    expect(res.json().mdFields).toEqual({
      volume: "1",
      chapter: "1",
      title: "Beginnings",
      translatedLanguage: "en",
      groups: [MD_GROUP],
    });

    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/admin/chapters/1c2d3e4f-0000-4000-8000-0000000000ff",
      headers: root,
    });
    expect(missing.statusCode).toBe(404);
  });

  // ---------------------------------------------------- the one write

  it("queues a correction as an EDIT task carrying the diff, the old values and the new chapter", async () => {
    await uploaded();
    const session = await sessionAs("OWNER", "owner@example.com");

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admin/chapters/${MD_CHAPTER}/edit`,
      headers: session,
      payload: { chapter: "1.5", title: "Beginnings, Revised" },
    });
    expect(res.statusCode).toBe(201);

    const task = await prisma.uploadTask.findFirstOrThrow({ where: { kind: "EDIT" } });
    expect(task.dedupeKey).toBe(MD_CHAPTER);
    const chapter = task.chapter as Record<string, unknown>;
    // The diff MangaDex will be sent…
    expect(chapter.payload).toEqual({ chapter: "1.5", title: "Beginnings, Revised" });
    // …the values it had, for the chapter's permanent edit history…
    expect(chapter.oldInfo).toEqual({
      volume: "1",
      chapter: "1",
      title: "Beginnings",
      translatedLanguage: "en",
      groups: [MD_GROUP],
    });
    // …and the chapter carrying the NEW values, because on success the uploader
    // mirrors this payload into uploaded_chapters. Carrying the old ones would
    // land the edit and leave our mirror describing what it used to say.
    expect(chapter.chapterNumber).toBe("1.5");
    expect(chapter.chapterTitle).toBe("Beginnings, Revised");
    expect(chapter.mdChapterId).toBe(MD_CHAPTER);

    // Nothing was written to the canonical mirror: that happens when the edit
    // actually lands, not when it is queued.
    const mirror = await prisma.uploadedChapter.findUniqueOrThrow({ where: { mdChapterId: MD_CHAPTER } });
    expect(mirror.chapterNumber).toBe("1");

    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "chapter.edit_queued" } });
    expect(audit.subject).toBe(MD_CHAPTER);
  });

  it("drops fields that already hold the requested value, and refuses a no-op edit", async () => {
    await uploaded();
    const session = await sessionAs("OWNER", "owner@example.com");

    const partial = await app.inject({
      method: "POST",
      url: `/api/v1/admin/chapters/${MD_CHAPTER}/edit`,
      headers: session,
      // `volume` is already "1"; only the title actually changes.
      payload: { volume: "1", title: "New" },
    });
    expect(partial.statusCode).toBe(201);
    expect(partial.json().payload).toEqual({ title: "New" });

    await prisma.uploadTask.deleteMany({});
    const noop = await app.inject({
      method: "POST",
      url: `/api/v1/admin/chapters/${MD_CHAPTER}/edit`,
      headers: session,
      payload: { volume: "1", chapter: "1" },
    });
    expect(noop.statusCode).toBe(400);
    expect(await prisma.uploadTask.count()).toBe(0);
  });

  it("refuses a second queued correction rather than working around the dedupe constraint", async () => {
    await uploaded();
    const session = await sessionAs("OWNER", "owner@example.com");

    const first = await app.inject({
      method: "POST",
      url: `/api/v1/admin/chapters/${MD_CHAPTER}/edit`,
      headers: session,
      payload: { title: "One" },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: `/api/v1/admin/chapters/${MD_CHAPTER}/edit`,
      headers: session,
      payload: { title: "Two" },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().existing.id).toBe(first.json().task.id);
    expect(await prisma.uploadTask.count({ where: { kind: "EDIT" } })).toBe(1);
  });

  it("refuses to edit a chapter that has been deleted from MangaDex", async () => {
    await prisma.deletedChapter.create({
      data: { mdChapterId: MD_CHAPTER, extension: "chaptertest", chapterNumber: "1", mdGroupId: MD_GROUP },
    });
    const session = await sessionAs("OWNER", "owner@example.com");

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/admin/chapters/${MD_CHAPTER}`,
      headers: root,
    });
    expect(detail.json().editable).toBe(false);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admin/chapters/${MD_CHAPTER}/edit`,
      headers: session,
      payload: { title: "Too late" },
    });
    // Refused now rather than after a lease, five attempts and a dead letter.
    expect(res.statusCode).toBe(409);
    expect(await prisma.uploadTask.count()).toBe(0);
  });

  it("refuses a group list that drops our own upload group", async () => {
    await uploaded();
    const session = await sessionAs("OWNER", "owner@example.com");

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admin/chapters/${MD_CHAPTER}/edit`,
      headers: session,
      payload: { groups: ["aaaaaaaa-0000-4000-8000-000000000000"] },
    });
    // MangaDex replaces attribution wholesale; this would detach the chapter
    // from the catalogue this platform can see.
    expect(res.statusCode).toBe(422);
    expect(res.json().uploadGroupId).toBe(MD_GROUP);
    expect(await prisma.uploadTask.count()).toBe(0);

    // Adding a group alongside ours is fine.
    const ok = await app.inject({
      method: "POST",
      url: `/api/v1/admin/chapters/${MD_CHAPTER}/edit`,
      headers: session,
      payload: { groups: [MD_GROUP, "aaaaaaaa-0000-4000-8000-000000000000"] },
    });
    expect(ok.statusCode).toBe(201);
  });

  it("rejects a language MangaDex would not accept, and normalises the case of one it would", async () => {
    await uploaded();
    const session = await sessionAs("OWNER", "owner@example.com");

    const bad = await app.inject({
      method: "POST",
      url: `/api/v1/admin/chapters/${MD_CHAPTER}/edit`,
      headers: session,
      payload: { translatedLanguage: "klingon" },
    });
    expect(bad.statusCode).toBe(400);

    const good = await app.inject({
      method: "POST",
      url: `/api/v1/admin/chapters/${MD_CHAPTER}/edit`,
      headers: session,
      payload: { translatedLanguage: "PT-BR" },
    });
    expect(good.statusCode).toBe(201);
    expect(good.json().payload.translatedLanguage).toBe("pt-br");
  });

  // ------------------------------------------------------------ authority

  it("keeps queueing a MangaDex write behind the ADMIN role, not merely runs:write", async () => {
    await uploaded();

    // A CONTRIBUTOR holds neither the role nor runs:write.
    const contributor = await sessionAs("CONTRIBUTOR", "contrib@example.com");
    const byContributor = await app.inject({
      method: "POST",
      url: `/api/v1/admin/chapters/${MD_CHAPTER}/edit`,
      headers: contributor,
      payload: { title: "No" },
    });
    expect(byContributor.statusCode).toBe(403);

    // An api-token with runs:write is the Discord bot's shape: it may trigger a
    // scrape, and that is not the same authority as rewriting a published
    // chapter.
    const bot = await mint(["runs:write"]);
    const byToken = await app.inject({
      method: "POST",
      url: `/api/v1/admin/chapters/${MD_CHAPTER}/edit`,
      headers: bot,
      payload: { title: "No" },
    });
    expect(byToken.statusCode).toBe(403);
    expect(await prisma.uploadTask.count()).toBe(0);

    // Reading is a different question: runs:read is enough for all three views.
    const reader = await mint(["runs:read"]);
    for (const url of ["/api/v1/admin/chapters", "/api/v1/admin/queues/chapters"]) {
      const res = await app.inject({ method: "GET", url, headers: reader });
      expect(res.statusCode).toBe(200);
    }
  });
});
