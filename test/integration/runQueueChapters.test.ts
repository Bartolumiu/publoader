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
 * The two chapter projections that own no storage: what a run FOUND, and what
 * the queue is ABOUT TO send. The third view — the archives of what is already
 * on MangaDex, and the actions against it — is chapters.test.ts.
 *
 * These need a real Postgres, and for a sharper reason than most: both read
 * paths are `jsonb` unnests and window functions over live tables —
 * `jsonb_array_elements … WITH ORDINALITY` over stored envelopes, and
 * `row_number()` over the claim ordering. A mock would assert that the strings
 * were assembled, not that they answer the question.
 *
 * What is worth proving here:
 *
 *  - a run's chapters come back in the extension's own order, and a segment that
 *    has not reported reads as "not reported" rather than as zero chapters;
 *  - the new-or-changed set stays distinct from the catalogue snapshot, since
 *    only the second drives removal detection;
 *  - and the queue's `position` is the place in the WHOLE claim order rather
 *    than on the page, so it tracks a reorder because it reads the same
 *    ordering the uploader claims by.
 */
describe.skipIf(!dbReady())("run and queue chapter projections", () => {
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
});
