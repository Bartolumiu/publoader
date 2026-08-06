import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  chapterExtras,
  chapterFromColumns,
  chapterToColumns,
  uploadedChapterColumns,
} from "../../src/core/md/chapterRows.js";
import type { Chapter } from "../../src/core/md/types.js";
import { closeDb, dbReady, resetDb, testPrisma } from "./db.js";

/**
 * The chapter columns against real Postgres. The unit tests prove the mapping
 * in isolation; these prove the mapping and the schema agree on timestamp
 * columns, the NOT NULL extension, and `extra` being SQL NULL rather than JSON
 * null when there is no residue.
 */
describe.skipIf(!dbReady())("chapter tables", () => {
  const prisma = testPrisma();

  const chapter: Chapter = {
    chapterLookup: "2026-07-01T10:00:00.000Z",
    chapterTimestamp: "2026-06-30T09:00:00.000Z",
    chapterExpire: "2037-12-31T15:00:00.000Z",
    chapterLanguage: "en",
    chapterNumber: "12",
    chapterTitle: "A title",
    chapterVolume: "3",
    chapterId: "9001",
    chapterUrl: "https://example.test/viewer/9001",
    mdChapterId: "aaaa1111-2222-4333-8444-555555555555",
    mangaId: "777",
    mdMangaId: "bbbb1111-2222-4333-8444-555555555555",
    mdGroupId: "cccc1111-2222-4333-8444-555555555555",
    mangaName: "Example",
    mangaUrl: "https://example.test/titles/777",
    extensionName: "exampleext",
    imageArtifacts: ["dddd1111-2222-4333-8444-555555555555"],
  };
  const mdChapterId = chapter.mdChapterId as string;

  beforeEach(async () => {
    await resetDb(prisma);
  });
  afterAll(async () => {
    await closeDb();
  });

  it("round-trips a chapter through uploaded_chapters", async () => {
    await prisma.uploadedChapter.create({
      data: { mdChapterId, ...uploadedChapterColumns(chapter) },
    });

    const row = await prisma.uploadedChapter.findUniqueOrThrow({ where: { mdChapterId } });
    expect(chapterFromColumns(row)).toEqual(chapter);
    expect(row.chapterExpire).toEqual(new Date("2037-12-31T15:00:00.000Z"));
    expect(row.extension).toBe("exampleext");
  });

  it("stores no extra document when the chapter has no residue", async () => {
    await prisma.deletedChapter.create({
      data: { mdChapterId, ...chapterToColumns({ ...chapter, imageArtifacts: [] }) },
    });

    const [row] = await prisma.$queryRaw<{ extra: unknown }[]>`
      SELECT extra FROM deleted_chapters WHERE md_chapter_id = ${mdChapterId}
    `;
    expect(row?.extra).toBeNull();
  });

  it("keeps an open-ended snapshot in extra on unavailable_chapters", async () => {
    const mdAttributes = { volume: null, chapter: "370", translatedLanguage: "es", version: 4 };
    await prisma.unavailableChapter.create({
      data: { mdChapterId, ...chapterToColumns(chapter, { mdAttributes }) },
    });

    const row = await prisma.unavailableChapter.findUniqueOrThrow({ where: { mdChapterId } });
    expect(chapterFromColumns(row)).toEqual(chapter);
    expect(chapterExtras(row)).toEqual({ mdAttributes });
  });

  it("keeps the edits history alongside the columns on edited_chapters", async () => {
    const edits = [{ editedAt: "2026-07-01T10:00:00.000Z", old: { title: "Old" }, new: { title: "A title" } }];
    await prisma.editedChapter.create({
      data: { mdChapterId, ...chapterToColumns(chapter), edits },
    });

    const row = await prisma.editedChapter.findUniqueOrThrow({ where: { mdChapterId } });
    expect(chapterFromColumns(row)).toEqual(chapter);
    expect(row.edits).toEqual(edits);
  });

  it("makes the promoted fields queryable without touching a JSON document", async () => {
    await prisma.uploadedChapter.createMany({
      data: [
        { mdChapterId, ...uploadedChapterColumns(chapter) },
        {
          mdChapterId: "aaaa2222-2222-4333-8444-555555555555",
          ...uploadedChapterColumns({
            ...chapter,
            mdChapterId: "aaaa2222-2222-4333-8444-555555555555",
            chapterId: "9002",
            chapterLanguage: "es",
            chapterExpire: "2026-01-01T00:00:00.000Z",
          }),
        },
      ],
    });

    expect(
      await prisma.uploadedChapter.count({
        where: { extension: "exampleext", chapterLanguage: "es" },
      }),
    ).toBe(1);
    expect(
      await prisma.uploadedChapter.count({
        where: { chapterExpire: { lt: new Date("2026-07-01T00:00:00.000Z") } },
      }),
    ).toBe(1);
    expect(
      await prisma.uploadedChapter.count({ where: { extension: "exampleext", chapterId: "9001" } }),
    ).toBe(1);
  });
});
