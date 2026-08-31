import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import { buildContext, type AppContext } from "../../src/core/api/context.js";
import { buildServer } from "../../src/core/api/server.js";
import { closeDb, dbReady, resetDb, testPrisma } from "./db.js";

/**
 * Sorting a paged listing orders the whole result, not the page in hand.
 *
 * This is the property the console's header buttons depend on and the one that
 * cannot be proved without a real Postgres: the ordering, the keyset predicate
 * and the cursor have to agree, and when they disagree the symptom is not an
 * error but a page that is quietly missing rows. So every test here pages the
 * listing to its end and checks the sequence it read out, rather than checking
 * the first page and trusting the rest.
 *
 * The fixtures are built so that the insertion order, the lexical order and the
 * numeric order all differ. A sort that silently fell back to the default
 * (newest first) would otherwise pass.
 */
describe.skipIf(!dbReady())("sorted listings", () => {
  const prisma = testPrisma();
  const ADMIN_TOKEN = "test-admin-token-0123456789";
  const config = loadConfig({
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    ADMIN_TOKEN,
    LOG_LEVEL: "error",
  });
  const log = createLogger("test-sorted", "error");
  let app: FastifyInstance;
  let ctx: AppContext;
  const root = { authorization: `Bearer ${ADMIN_TOKEN}` };

  async function buildApp(): Promise<FastifyInstance> {
    const app = buildServer(ctx);
    await app.ready();
    return app;
  }

  beforeEach(async () => {
    await resetDb(prisma);
    ctx = buildContext(prisma, config, log);
    app = await buildApp();
  });
  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  const uuid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

  /**
   * Twenty-four published chapters over eight series.
   *
   * The series names run backwards against insertion order, so lexical and
   * default orderings are opposites. Three rows have no series at all (one
   * NULL, one empty, one blank) because "blanks last in both directions" is the
   * rule most easily broken by a NULL in a keyset comparison: a NULL there does
   * not sort the row, it drops it.
   */
  const BLANKS = { 5: null, 11: "", 17: "   " } as Record<number, string | null>;

  async function seedArchive(): Promise<void> {
    for (let i = 0; i < 24; i++) {
      const named = Object.hasOwn(BLANKS, i) ? BLANKS[i]! : `Series ${String(24 - i).padStart(2, "0")}`;
      await prisma.uploadedChapter.create({
        data: {
          mdChapterId: uuid(i + 1),
          extension: i % 2 ? "omoi" : "comikey",
          chapterId: `src-${i}`,
          // 1, 2, 3, ... 24 as text: read lexically this is 1, 10, 11, ... 2,
          // which is the failure a numeric column has to be caught making.
          chapterNumber: String(i + 1),
          chapterTitle: `Chapter ${i + 1}`,
          chapterLanguage: i % 3 === 0 ? "ja" : "en",
          mangaName: named,
          mdMangaId: uuid(900),
          createdAt: new Date(Date.UTC(2026, 0, 1 + i, 12)),
        },
      });
    }
  }

  /**
   * Every row of a listing, read the way the console reads it: one page at a
   * time, following the cursor the server issued.
   *
   * Returns the rows in the order they were read, so a caller can assert on the
   * sequence across page boundaries — which is where a keyset that disagrees
   * with its ORDER BY goes wrong, and nowhere else.
   */
  async function pageThrough(
    url: string,
    key: string,
    limit: number,
  ): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    // A page count bound: a cursor that fails to advance is a hang, and a hung
    // test says far less than a failed one.
    for (let page = 0; page < 50; page++) {
      const query: string = `${url}${url.includes("?") ? "&" : "?"}limit=${limit}${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
      }`;
      const res = await app.inject({ method: "GET", url: query, headers: root });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      rows.push(...body[key]);
      cursor = body.nextCursor ?? null;
      if (!cursor) return rows;
    }
    throw new Error("listing never reached its last page");
  }

  const names = (rows: Record<string, unknown>[]) => rows.map((row) => row.mangaName ?? null);

  describe("chapter archives", () => {
    beforeEach(seedArchive);

    it("orders the whole archive, not the page, and pages that order intact", async () => {
      // Seven at a time over twenty-four rows: four pages, the last a short one.
      const rows = await pageThrough("/api/v1/admin/chapters?archive=uploaded&orderBy=series&dir=asc", "chapters", 7);

      expect(rows).toHaveLength(24);
      // Every row exactly once: the two ways a keyset and its ORDER BY drift
      // apart are a repeat and a hole, and both show up here.
      expect(new Set(rows.map((row) => row.mdChapterId)).size).toBe(24);

      const named = names(rows).filter((name) => typeof name === "string" && name.trim() !== "");
      expect(named).toEqual([...named].sort());
      // The first page alone has to be the global smallest, which is the whole
      // point: sorted in the browser it would have been the smallest of the
      // twenty-four most recent.
      expect(named[0]).toBe("Series 01");
      expect(named.at(-1)).toBe("Series 24");
    });

    it("keeps blanks at the bottom in both directions", async () => {
      const isBlank = (name: unknown) => name == null || String(name).trim() === "";

      for (const dir of ["asc", "desc"] as const) {
        const rows = await pageThrough(
          `/api/v1/admin/chapters?archive=uploaded&orderBy=series&dir=${dir}`,
          "chapters",
          7,
        );
        expect(rows).toHaveLength(24);
        const blanks = names(rows).map(isBlank);
        // Three blanks, and all of them at the end: reversing a column asks for
        // its other end, not for the rows that have no value in it.
        expect(blanks.filter(Boolean)).toHaveLength(3);
        expect(blanks.slice(-3)).toEqual([true, true, true]);
      }

      const descending = await pageThrough(
        "/api/v1/admin/chapters?archive=uploaded&orderBy=series&dir=desc",
        "chapters",
        7,
      );
      expect(names(descending)[0]).toBe("Series 24");
    });

    it("orders a chapter number as a number", async () => {
      const rows = await pageThrough(
        "/api/v1/admin/chapters?archive=uploaded&orderBy=chapter&dir=asc",
        "chapters",
        7,
      );
      expect(rows.map((row) => row.chapterNumber)).toEqual(
        Array.from({ length: 24 }, (_, i) => String(i + 1)),
      );
    });

    it("still defaults to newest first, by its own cursor", async () => {
      const rows = await pageThrough("/api/v1/admin/chapters?archive=uploaded", "chapters", 7);
      expect(rows).toHaveLength(24);
      expect(rows[0]!.chapterNumber).toBe("24");
      expect(rows.at(-1)!.chapterNumber).toBe("1");
    });

    it("refuses a column it cannot order by, rather than ignoring it", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/admin/chapters?archive=uploaded&orderBy=nonsense",
        headers: root,
      });
      expect(res.statusCode).toBe(400);
    });

    it("refuses a cursor minted under a different ordering", async () => {
      const first = await app.inject({
        method: "GET",
        url: "/api/v1/admin/chapters?archive=uploaded&orderBy=series&dir=asc&limit=5",
        headers: root,
      });
      const cursor = first.json().nextCursor as string;
      expect(cursor).toBeTruthy();

      // The same cursor, offered to the reverse of the ordering that issued it.
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/admin/chapters?archive=uploaded&orderBy=series&dir=desc&limit=5&cursor=${encodeURIComponent(cursor)}`,
        headers: root,
      });
      expect(res.statusCode).toBe(400);
    });

    it("does not leak the keys it sorted by into the rows", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/admin/chapters?archive=uploaded&orderBy=series&dir=asc&limit=3",
        headers: root,
      });
      const row = res.json().chapters[0];
      expect(Object.keys(row).filter((key) => key.startsWith("_sort"))).toEqual([]);
    });
  });

  /**
   * The queue is the listing where paging correctness matters most: it drains
   * while it is being read, which is why it pages by cursor rather than offset,
   * and a sort that broke that would lose rows rather than merely misorder them.
   */
  describe("the upload queue", () => {
    beforeEach(async () => {
      for (let i = 0; i < 24; i++) {
        await prisma.uploadTask.create({
          data: {
            kind: i % 3 === 0 ? "EDIT" : "UPLOAD",
            dedupeKey: `queue-${String(i).padStart(2, "0")}`,
            state: i % 4 === 0 ? "FAILED" : "PENDING",
            attempt: i % 5,
            // Queued in one order and named in the reverse, so a listing that
            // ignored the sort would come back in the opposite sequence.
            notBefore: new Date(Date.UTC(2026, 0, 1 + i, 12)),
            lastError: i % 4 === 0 ? `boom ${String(24 - i).padStart(2, "0")}` : null,
            chapter: {
              mangaName: Object.hasOwn(BLANKS, i) ? BLANKS[i] : `Series ${String(24 - i).padStart(2, "0")}`,
              chapterNumber: String(i + 1),
              chapterLanguage: i % 3 === 0 ? "ja" : "en",
              extensionName: i % 2 ? "omoi" : "comikey",
            },
          },
        });
      }
    });

    it("orders every queued task, and pages that order intact", async () => {
      const rows = await pageThrough(
        "/api/v1/admin/queues/tasks?state=PENDING&state=FAILED&orderBy=dedupeKey&dir=desc",
        "tasks",
        7,
      );
      expect(rows).toHaveLength(24);
      expect(new Set(rows.map((row) => row.id)).size).toBe(24);
      const keys = rows.map((row) => row.dedupeKey as string);
      expect(keys).toEqual([...keys].sort().reverse());
      expect(keys[0]).toBe("queue-23");
    });

    it("orders queued chapters by a column of the chapter, not of the task", async () => {
      const rows = await pageThrough(
        "/api/v1/admin/queues/chapters?state=PENDING&state=FAILED&orderBy=series&dir=asc",
        "chapters",
        7,
      );
      expect(rows).toHaveLength(24);
      const named = rows
        .map((row) => row.mangaName)
        .filter((name): name is string => typeof name === "string" && name.trim() !== "");
      expect(named).toEqual([...named].sort());
      expect(named[0]).toBe("Series 01");
    });

    it("keeps position meaning the place in the claim order, not on the page", async () => {
      const rows = await pageThrough(
        "/api/v1/admin/queues/chapters?state=PENDING&state=FAILED&orderBy=series&dir=asc",
        "chapters",
        7,
      );
      // Every position from 1 to 24 exactly once, however the rows are ordered:
      // it numbers the queue, and a sorted view still says where a row stands.
      expect([...rows.map((row) => row.position as number)].sort((a, b) => a - b)).toEqual(
        Array.from({ length: 24 }, (_, i) => i + 1),
      );
    });

    it("still walks the claim order when nothing is sorted", async () => {
      const rows = await pageThrough("/api/v1/admin/queues/tasks?state=PENDING&state=FAILED", "tasks", 7);
      expect(rows).toHaveLength(24);
      expect(rows[0]!.dedupeKey).toBe("queue-00");
    });
  });

  describe("the untracked queue", () => {
    beforeEach(async () => {
      for (let i = 0; i < 24; i++) {
        await prisma.untrackedManga.create({
          data: {
            extension: i % 2 ? "omoi" : "comikey",
            mangaId: `src-${i}`,
            mangaName: `Series ${String(24 - i).padStart(2, "0")}`,
            mangaLanguage: i % 3 === 0 ? "ja" : "en",
            mangaUrl: `https://publisher.example/${i}`,
            state: i % 4 === 0 ? "FAILED" : "NEW",
            attempts: i % 5,
            lastError: i % 4 === 0 ? `boom ${i}` : null,
            createdAt: new Date(Date.UTC(2026, 0, 1 + i, 12)),
          },
        });
      }
    });

    it("orders the whole queue, and pages that order intact", async () => {
      const rows = await pageThrough("/api/v1/admin/untracked?orderBy=series&dir=asc", "untracked", 7);
      expect(rows).toHaveLength(24);
      expect(new Set(rows.map((row) => row.id)).size).toBe(24);
      const named = rows.map((row) => row.mangaName as string);
      expect(named).toEqual([...named].sort());
      expect(named[0]).toBe("Series 01");
    });

    it("orders attempts as numbers", async () => {
      const rows = await pageThrough("/api/v1/admin/untracked?orderBy=attempts&dir=desc", "untracked", 7);
      const attempts = rows.map((row) => row.attempts as number);
      expect(attempts).toEqual([...attempts].sort((a, b) => b - a));
    });

    it("still walks newest-first, by row id, when nothing is sorted", async () => {
      const rows = await pageThrough("/api/v1/admin/untracked", "untracked", 7);
      expect(rows).toHaveLength(24);
      expect(rows[0]!.mangaName).toBe("Series 01");
      expect(rows.at(-1)!.mangaName).toBe("Series 24");
    });

    it("filters by state and extension, as it did through the model", async () => {
      // The filter moved from Prisma's object language into SQL along with the
      // ordering; an enum compared as text is the part that silently stops
      // matching, and nothing else covers these two.
      const failed = await app.inject({
        method: "GET",
        url: "/api/v1/admin/untracked?state=FAILED&limit=500",
        headers: root,
      });
      expect(failed.statusCode, failed.body).toBe(200);
      expect(failed.json().total).toBe(6);
      expect(failed.json().untracked.every((row: { state: string }) => row.state === "FAILED")).toBe(true);

      const omoi = await app.inject({
        method: "GET",
        url: "/api/v1/admin/untracked?extension=omoi&limit=500",
        headers: root,
      });
      expect(omoi.json().total).toBe(12);
      expect(omoi.json().untracked.every((row: { extension: string }) => row.extension === "omoi")).toBe(
        true,
      );
    });

    it("answers the same row shape it always did", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/admin/untracked?limit=1",
        headers: root,
      });
      // The listing moved from Prisma's object language to SQL; the contract
      // the console reads is the camel-cased row, and it has to be unchanged.
      expect(Object.keys(res.json().untracked[0]).sort()).toEqual(
        [
          "attempts",
          "createdAt",
          "extension",
          "id",
          "lastError",
          "mangaId",
          "mangaLanguage",
          "mangaName",
          "mangaUrl",
          "mdAppliedAt",
          "mdAppliedBy",
          "mdMangaId",
          "officialLinkCheckedAt",
          "state",
          "titleCheckedAt",
          "updatedAt",
        ].sort(),
      );
    });
  });

  /**
   * The offset-paged listings. Their keyset has nothing to keep in step, so
   * what is worth proving is only that the ordering reaches past the page.
   */
  describe("offset-paged listings", () => {
    it("orders the whole audit log", async () => {
      for (let i = 0; i < 24; i++) {
        await ctx.audit.record(`actor-${String(24 - i).padStart(2, "0")}`, `action.${i % 4}`, `subject-${i}`);
      }

      const first = await app.inject({
        method: "GET",
        url: "/api/v1/admin/audit/search?orderBy=actor&dir=asc&limit=5",
        headers: root,
      });
      expect(first.statusCode, first.body).toBe(200);
      const actors = first.json().events.map((event: { actor: string }) => event.actor);
      expect(actors).toEqual(["actor-01", "actor-02", "actor-03", "actor-04", "actor-05"]);
      expect(first.json().total).toBe(24);
    });

    it("orders every title in an archive, not the page of titles", async () => {
      await seedArchive();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/admin/chapters/series?archive=uploaded&orderBy=series&dir=asc&limit=5",
        headers: root,
      });
      expect(res.statusCode, res.body).toBe(200);
      const series = res.json().series as { mangaName: string | null }[];
      const named = series.map((row) => row.mangaName).filter(Boolean);
      expect(named).toEqual([...named].sort());
    });

    it("refuses a column it cannot order by", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/admin/audit/search?orderBy=nonsense",
        headers: root,
      });
      expect(res.statusCode).toBe(400);
    });

    /**
     * A run's chapters live in a JSON envelope, so their instants are strings
     * and the cast that reads them back is the kind that raises rather than
     * returning NULL. One chapter dated in some other shape must sort as blank,
     * not take the listing down with it.
     */
    it("orders a run's chapters across its segments, timestamps and all", async () => {
      const run = await prisma.run.create({
        data: {
          idempotencyKey: `run-${Math.random()}`,
          extension: "sorttest",
          extensionVersion: "1.0.0",
          bundleSha256: "a".repeat(64),
          kind: "UPDATE",
          state: "PROCESSED",
          segmentsTotal: 2,
        },
      });
      for (let index = 0; index < 2; index++) {
        const job = await prisma.job.create({
          data: {
            idempotencyKey: `job-${run.id}-${index}`,
            runId: run.id,
            extension: "sorttest",
            extensionVersion: "1.0.0",
            bundleSha256: "a".repeat(64),
            kind: "UPDATE",
            segmentIndex: index,
            segmentTotal: 2,
            segmentKey: `seg${index}`,
            state: "SUCCEEDED",
          },
        });
        await prisma.resultSubmission.create({
          data: {
            idempotencyKey: `res-${job.id}`,
            jobId: job.id,
            attempt: 1,
            leaseId: "22222222-2222-4222-8222-222222222222",
            workerId: "w1",
            state: "COMMITTED",
            envelope: {
              envelopeVersion: 1,
              extension: "sorttest",
              status: "ok",
              updatedChapters: Array.from({ length: 6 }, (_, n) => {
                const at = index * 6 + n;
                return {
                  chapterId: `src-${at}`,
                  chapterNumber: String(at + 1),
                  chapterLanguage: "en",
                  mangaName: `Series ${String(12 - at).padStart(2, "0")}`,
                  // One chapter per segment carries something no date parser
                  // should be handed.
                  chapterTimestamp: n === 0 ? "not a date" : `2026-0${index + 1}-${String(n + 1).padStart(2, "0")}T00:00:00.000Z`,
                };
              }),
              allChapters: null,
              untrackedManga: [],
            } as unknown as import("@prisma/client").Prisma.InputJsonValue,
          },
        });
      }

      const series = await app.inject({
        method: "GET",
        url: `/api/v1/admin/runs/${run.id}/chapters?set=updated&orderBy=series&dir=asc&limit=50`,
        headers: root,
      });
      expect(series.statusCode, series.body).toBe(200);
      const named = series
        .json()
        .chapters.map((row: { chapter: { mangaName: string } }) => row.chapter.mangaName);
      expect(named).toHaveLength(12);
      expect(named).toEqual([...named].sort());
      // Across both segments, not within each: the default order groups by
      // segment, so a sort that stayed inside one would fail here.
      expect(named[0]).toBe("Series 01");

      const released = await app.inject({
        method: "GET",
        url: `/api/v1/admin/runs/${run.id}/chapters?set=updated&orderBy=released&dir=asc&limit=50`,
        headers: root,
      });
      expect(released.statusCode, released.body).toBe(200);
      const stamps = released
        .json()
        .chapters.map((row: { chapter: { chapterTimestamp: string } }) => row.chapter.chapterTimestamp);
      expect(stamps).toHaveLength(12);
      // The two unparseable ones sort as blank, which is last in both
      // directions, and nothing raised on the way.
      expect(stamps.slice(-2)).toEqual(["not a date", "not a date"]);
      expect(stamps[0]).toBe("2026-01-02T00:00:00.000Z");
    });
  });
});
