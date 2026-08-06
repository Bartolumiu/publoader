import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createLogger } from "../../src/logging.js";
import { ChapterReconciler } from "../../src/core/md/chapterReconcile.js";
import type { MdChapterDetail, MdEntity, MdExtendedApi } from "../../src/core/md/client.js";
import type { AuditLog } from "../../src/core/store/settings.js";
import { closeDb, dbReady, resetDb, testPrisma } from "./db.js";

/**
 * Recording what MangaDex did to our chapters.
 *
 * The properties worth proving are the ones that cost real data when they
 * regress, and each needs a live postgres because the archives' `md_chapter_id`
 * unique constraints and the move-between-tables transaction are the system
 * under test:
 *
 *  - a chapter MangaDex will not serve is archived even when it has NO
 *    uploaded_chapters row. This is the case the obvious implementation gets
 *    wrong: on a database younger than the catalogue, the overlap between
 *    "unavailable on MangaDex" and "in uploaded_chapters" is zero, so a sweep
 *    of our own table finds nothing at all;
 *  - unavailability is decided by the collection differential, NOT by the
 *    `isUnavailable` attribute, which is absent on every older chapter;
 *  - deletion rests on a 404 and never on absence from a list, because it is
 *    the irreversible direction;
 *  - a chapter that is merely hidden (fetchable by id, absent from the
 *    collection) is reported and never written;
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

  const entity = (id: string, attributes: Record<string, unknown> = {}): MdEntity => ({
    id,
    type: "chapter",
    attributes: { chapter: "7", title: "Seven", translatedLanguage: "en", ...attributes },
    relationships: [{ id: MANGA, type: "manga" }],
  });

  /**
   * A MangaDex that holds `all` for the group, serves `served`, and 404s
   * anything in `gone`. The shape mirrors the real client's contract: the
   * availability call is the only thing that can see an unavailable chapter.
   */
  function fakeMd(opts: {
    all: MdEntity[];
    served: string[];
    gone?: string[];
    byId?: Record<string, Partial<MdChapterDetail["attributes"]>>;
  }): MdExtendedApi {
    return {
      chapterAvailabilityForGroup: async () => ({
        all: new Map(opts.all.map((e) => [e.id, e])),
        served: new Set(opts.served),
      }),
      chaptersByIds: async (ids: string[]) =>
        ids
          .filter((id) => !(opts.gone ?? []).includes(id) && opts.served.includes(id))
          .map((id) => ({
            id,
            attributes: {
              volume: null,
              chapter: "7",
              title: null,
              translatedLanguage: "en",
              externalUrl: null,
              version: 1,
              createdAt: "",
            },
            relationships: [],
          })),
      chapterById: async (id: string) => {
        if ((opts.gone ?? []).includes(id)) return null;
        return {
          id,
          attributes: {
            volume: null,
            chapter: "7",
            title: null,
            translatedLanguage: "en",
            externalUrl: null,
            version: 1,
            createdAt: "",
            ...(opts.byId?.[id] ?? {}),
          },
          relationships: [],
        } as MdChapterDetail;
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

  it("archives a chapter with no uploaded row, found only by the differential", async () => {
    // One uploaded row exists purely so the group is discoverable; the
    // unavailable chapter itself is NOT in uploaded_chapters, which is the
    // real-world case a sweep of our own table cannot see.
    await seedUploaded(chapterId(1));
    const orphan = chapterId(99);
    const md = fakeMd({
      all: [entity(chapterId(1)), entity(orphan, { externalUrl: "https://pub.example/v/9" })],
      served: [chapterId(1)],
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
    expect((row?.extra as Record<string, unknown>)["mdAttributes"]).toMatchObject({
      externalUrl: "https://pub.example/v/9",
    });
  });

  it("does not depend on the isUnavailable attribute, which older chapters lack", async () => {
    await seedUploaded(chapterId(1));
    const orphan = chapterId(98);
    const md = fakeMd({
      // No isUnavailable key anywhere — exactly what MangaDex returns for the
      // chapters it has been refusing to serve the longest.
      all: [entity(chapterId(1)), entity(orphan)],
      served: [chapterId(1)],
    });

    const report = await new ChapterReconciler({ prisma, md, log, audit }).run({
      dryRun: false,
      actor: "tester",
    });

    expect(report.unavailableRecorded).toBe(1);
    expect(await prisma.unavailableChapter.count()).toBe(1);
  });

  it("writes nothing on a dry run but reports the same counts", async () => {
    await seedUploaded(chapterId(1));
    const md = fakeMd({ all: [entity(chapterId(1)), entity(chapterId(97))], served: [chapterId(1)] });

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

  it("reports a merely hidden chapter without writing it anywhere", async () => {
    const hidden = chapterId(3);
    await seedUploaded(hidden);
    // Absent from the collection, but its own endpoint answers and it does not
    // claim to be unavailable — a future publishAt looks exactly like this.
    const md = fakeMd({ all: [], served: [] });

    const report = await new ChapterReconciler({ prisma, md, log, audit }).run({
      dryRun: false,
      actor: "tester",
    });

    expect(report.hidden).toEqual([hidden]);
    expect(report.deletedRecorded).toBe(0);
    expect(await prisma.deletedChapter.count()).toBe(0);
    expect(await prisma.unavailableChapter.count()).toBe(0);
    expect(await prisma.uploadedChapter.count()).toBe(1);
  });

  it("keeps the instant it first recorded when run again", async () => {
    await seedUploaded(chapterId(1));
    const orphan = chapterId(96);
    const md = fakeMd({ all: [entity(chapterId(1)), entity(orphan)], served: [chapterId(1)] });
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
    const md = fakeMd({ all: [entity(chapterId(1)), entity(gone)], served: [chapterId(1)] });

    const report = await new ChapterReconciler({ prisma, md, log, audit }).run({
      dryRun: false,
      actor: "tester",
    });

    expect(report.unavailableRecorded).toBe(0);
    expect(await prisma.unavailableChapter.count()).toBe(0);
    expect(await prisma.deletedChapter.count()).toBe(1);
  });
});
