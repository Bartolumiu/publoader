import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createLogger } from "../../src/logging.js";
import { ChapterReconciler } from "../../src/core/md/chapterReconcile.js";
import type { MdChapterDetail, MdEntity, MdExtendedApi } from "../../src/core/md/client.js";
import type { AuditLog } from "../../src/core/store/settings.js";
import { closeDb, dbReady, resetDb, testPrisma } from "./db.js";

/**
 * Rebuilding the chapter archives from what MangaDex holds.
 *
 * The properties worth proving are the ones that cost real data when they
 * regress, and each needs a live postgres because the archives' `md_chapter_id`
 * unique constraints and the move-between-tables transaction are the system
 * under test:
 *
 *  - "marked unavailable" is `externalUrl && pages > 0` — an external chapter
 *    carrying our card. Both halves are load-bearing: pages alone would sweep
 *    in natively hosted chapters, and externalUrl alone describes every chapter
 *    we have ever published, live ones included;
 *  - a carded chapter is archived even when it has NO uploaded_chapters row.
 *    This is the case the obvious implementation gets wrong: on a database
 *    younger than the catalogue the overlap is zero, so a sweep of our own
 *    table finds nothing at all;
 *  - a live external chapter (no pages) is left alone however MangaDex is
 *    behaving, including when MangaDex has stopped serving it — that is
 *    MangaDex hiding a chapter rather than us having marked one, so it is
 *    reported and never archived;
 *  - deletion rests on a 404 and never on absence from a list, because it is
 *    the irreversible direction;
 *  - re-running keeps the instant already recorded, so a sweep cannot rewrite
 *    the history it is meant to preserve.
 */
describe.skipIf(!dbReady())("chapter reconciliation", () => {
  const prisma = testPrisma();
  const log = createLogger("test-reconcile", "error");
  const GROUP = "33333333-3333-4333-8333-333333333333";
  const MANGA = "22222222-2222-4222-8222-222222222222";

  const audited: { action: string; detail: unknown }[] = [];
  const audit = {
    record: async (_actor: string, action: string, _target: string, detail: unknown) => {
      audited.push({ action, detail });
    },
  } as unknown as AuditLog;

  const chapterId = (n: number): string =>
    `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;

  /** A live external chapter: publisher link, no pages of its own. */
  const entity = (id: string, attributes: Record<string, unknown> = {}): MdEntity => ({
    id,
    type: "chapter",
    attributes: {
      chapter: "7",
      title: "Seven",
      translatedLanguage: "en",
      externalUrl: "https://publisher.example/ch/7",
      pages: 0,
      ...attributes,
    },
    relationships: [{ id: MANGA, type: "manga" }],
  });

  /**
   * The same chapter after being marked unavailable: the card is its one page,
   * and the link has been repointed at the series root rather than cleared —
   * which is exactly why the page count, not the URL, is the signal.
   */
  const carded = (id: string, attributes: Record<string, unknown> = {}): MdEntity =>
    entity(id, { externalUrl: "https://publisher.example/", pages: 1, ...attributes });

  /**
   * A MangaDex that holds `all` for the group, serves `served`, and 404s
   * anything in `gone`. `byId` overrides what the single-chapter endpoint says,
   * which is the only thing the uploaded-row sweep consults.
   */
  function fakeMd(opts: {
    all: MdEntity[];
    served: string[];
    gone?: string[];
    byId?: Record<string, Record<string, unknown>>;
  }): MdExtendedApi {
    return {
      chapterAvailabilityForGroup: async () => ({
        all: new Map(opts.all.map((e) => [e.id, e])),
        served: new Set(opts.served),
      }),
      chapterById: async (id: string) => {
        if ((opts.gone ?? []).includes(id)) return null;
        return {
          id,
          attributes: {
            volume: null,
            chapter: "7",
            title: null,
            translatedLanguage: "en",
            externalUrl: "https://publisher.example/ch/7",
            pages: 0,
            version: 1,
            createdAt: "",
            ...(opts.byId?.[id] ?? {}),
          },
          relationships: [],
        } as unknown as MdChapterDetail;
      },
    } as unknown as MdExtendedApi;
  }

  const seedUploaded = async (mdChapterId: string, extra?: Prisma.InputJsonValue) =>
    prisma.uploadedChapter.create({
      data: {
        mdChapterId,
        extension: "mangaplus",
        mdGroupId: GROUP,
        chapterId: "src-7",
        chapterUrl: "https://publisher.example/ch/7",
        chapterNumber: "7",
        ...(extra ? { extra } : {}),
      },
    });

  beforeEach(async () => {
    await resetDb(prisma);
    audited.length = 0;
  });
  afterAll(async () => {
    await closeDb();
  });

  it("archives a carded chapter that has no uploaded_chapters row", async () => {
    // One uploaded row exists purely so the group is discoverable; the carded
    // chapter itself is NOT in uploaded_chapters, which is the real-world case
    // a sweep of our own table cannot see.
    await seedUploaded(chapterId(1));
    const orphan = chapterId(99);
    const md = fakeMd({
      all: [entity(chapterId(1)), carded(orphan)],
      served: [chapterId(1), orphan],
    });

    const report = await new ChapterReconciler({ prisma, md, log, audit }).run({
      dryRun: false,
      actor: "tester",
    });

    expect(report.unavailableFound).toBe(1);
    expect(report.unavailableRecorded).toBe(1);
    const row = await prisma.unavailableChapter.findUnique({ where: { mdChapterId: orphan } });
    expect(row).not.toBeNull();
    expect(row?.mdGroupId).toBe(GROUP);
    expect(row?.mdMangaId).toBe(MANGA);
    expect(row?.extension).toBe("mangaplus");
    // The MangaDex record is the only description of a chapter we never had a
    // row for, so it has to survive on the archive row.
    expect((row?.extra as Record<string, unknown>)["mdAttributes"]).toMatchObject({ pages: 1 });
  });

  it("needs both halves of the signature: pages alone and a link alone are not enough", async () => {
    await seedUploaded(chapterId(1));
    const liveExternal = chapterId(90);
    const nativeWithPages = chapterId(91);
    const md = fakeMd({
      all: [
        entity(chapterId(1)),
        // Still readable at the publisher — pages 0.
        entity(liveExternal),
        // Pages, but no publisher link: a natively hosted chapter, not our card.
        entity(nativeWithPages, { externalUrl: null, pages: 12 }),
      ],
      served: [chapterId(1), liveExternal, nativeWithPages],
    });

    const report = await new ChapterReconciler({ prisma, md, log, audit }).run({
      dryRun: false,
      actor: "tester",
    });

    expect(report.unavailableFound).toBe(0);
    expect(await prisma.unavailableChapter.count()).toBe(0);
  });

  it("reports a live chapter MangaDex has stopped serving without archiving it", async () => {
    await seedUploaded(chapterId(1));
    const hidden = chapterId(89);
    const md = fakeMd({
      // Uncarded and unserved: MangaDex is hiding it, we have not marked it.
      all: [entity(chapterId(1)), entity(hidden)],
      served: [chapterId(1)],
    });

    const report = await new ChapterReconciler({ prisma, md, log, audit }).run({
      dryRun: false,
      actor: "tester",
    });

    expect(report.hiddenOnMangadex).toEqual([hidden]);
    expect(report.unavailableRecorded).toBe(0);
    expect(await prisma.unavailableChapter.count()).toBe(0);
    expect(report.groups[0]?.hiddenOnMangadex).toBe(1);
  });

  it("writes nothing on a dry run but reports the same counts", async () => {
    await seedUploaded(chapterId(1));
    const md = fakeMd({
      all: [entity(chapterId(1)), carded(chapterId(97))],
      served: [chapterId(1), chapterId(97)],
    });

    const report = await new ChapterReconciler({ prisma, md, log, audit }).run({
      dryRun: true,
      actor: "tester",
    });

    expect(report.unavailableRecorded).toBe(1);
    expect(await prisma.unavailableChapter.count()).toBe(0);
    expect(await prisma.uploadedChapter.count()).toBe(1);
    // A dry run is not an event.
    expect(audited).toHaveLength(0);
  });

  it("archives a carded chapter found through its uploaded row", async () => {
    const known = chapterId(5);
    await seedUploaded(known);
    const md = fakeMd({
      all: [],
      served: [],
      byId: { [known]: { externalUrl: "https://publisher.example/", pages: 1 } },
    });

    const report = await new ChapterReconciler({ prisma, md, log, audit }).run({
      dryRun: false,
      actor: "tester",
    });

    expect(report.unavailableRecorded).toBe(1);
    // The publisher-side identifiers come from our row, not from MangaDex,
    // which has never known about them.
    const row = await prisma.unavailableChapter.findUnique({ where: { mdChapterId: known } });
    expect(row?.chapterId).toBe("src-7");
    expect(row?.chapterUrl).toBe("https://publisher.example/ch/7");
    expect(await prisma.uploadedChapter.count()).toBe(0);
  });

  it("archives a deletion only on a 404, and moves the row out of uploaded", async () => {
    const gone = chapterId(2);
    await seedUploaded(gone, { images: ["artifact-1"] });
    const md = fakeMd({ all: [], served: [], gone: [gone] });

    const report = await new ChapterReconciler({ prisma, md, log, audit }).run({
      dryRun: false,
      actor: "tester",
    });

    expect(report.deletedRecorded).toBe(1);
    const row = await prisma.deletedChapter.findUnique({ where: { mdChapterId: gone } });
    expect(row?.chapterId).toBe("src-7");
    expect(row?.extra).toMatchObject({ images: ["artifact-1"] });
    expect(await prisma.uploadedChapter.findUnique({ where: { mdChapterId: gone } })).toBeNull();
  });

  it("keeps the instant it first recorded when run again", async () => {
    await seedUploaded(chapterId(1));
    const orphan = chapterId(96);
    const md = fakeMd({
      all: [entity(chapterId(1)), carded(orphan)],
      served: [chapterId(1), orphan],
    });
    const reconciler = new ChapterReconciler({ prisma, md, log, audit });

    await reconciler.run({ dryRun: false, actor: "tester" });
    const first = await prisma.unavailableChapter.findUnique({ where: { mdChapterId: orphan } });

    const second = await reconciler.run({ dryRun: false, actor: "tester" });
    const after = await prisma.unavailableChapter.findUnique({ where: { mdChapterId: orphan } });

    // Still found, but not recorded again — and the timestamp is untouched.
    expect(second.unavailableFound).toBe(1);
    expect(second.unavailableRecorded).toBe(0);
    expect(after?.unavailableAt.toISOString()).toBe(first?.unavailableAt.toISOString());
  });

  it("never resurrects a deleted chapter as merely unavailable", async () => {
    const gone = chapterId(4);
    await prisma.deletedChapter.create({ data: { mdChapterId: gone, extension: "mangaplus" } });
    await seedUploaded(chapterId(1));
    const md = fakeMd({
      all: [entity(chapterId(1)), carded(gone)],
      served: [chapterId(1), gone],
    });

    const report = await new ChapterReconciler({ prisma, md, log, audit }).run({
      dryRun: false,
      actor: "tester",
    });

    expect(report.unavailableRecorded).toBe(0);
    expect(await prisma.unavailableChapter.count()).toBe(0);
    expect(await prisma.deletedChapter.count()).toBe(1);
  });
});
