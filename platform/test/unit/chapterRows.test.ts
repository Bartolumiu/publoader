import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import {
  CHAPTER_JSON_KEYS,
  chapterExtras,
  chapterFromColumns,
  chapterFromJson,
  chapterToColumns,
  residualJsonKeys,
  uploadedChapterColumns,
} from "../../src/core/md/chapterRows.js";
import type { Chapter } from "../../src/core/md/types.js";

const full: Chapter = {
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
  imageArtifacts: ["dddd1111-2222-4333-8444-555555555555", "eeee1111-2222-4333-8444-555555555555"],
};

const sparse: Chapter = {
  chapterLookup: null,
  chapterTimestamp: null,
  chapterExpire: null,
  chapterLanguage: null,
  chapterNumber: null,
  chapterTitle: null,
  chapterVolume: null,
  chapterId: null,
  chapterUrl: null,
  mdChapterId: null,
  mangaId: null,
  mdMangaId: null,
  mdGroupId: null,
  mangaName: null,
  mangaUrl: null,
  extensionName: null,
  imageArtifacts: [],
};

describe("chapterToColumns / chapterFromColumns", () => {
  it("round-trips a fully populated chapter", () => {
    const columns = chapterToColumns(full);
    expect(chapterFromColumns({ mdChapterId: full.mdChapterId, ...columns })).toEqual(full);
  });

  it("round-trips a chapter with every optional field absent", () => {
    const columns = chapterToColumns(sparse);
    expect(columns.extra).toBe(Prisma.DbNull);
    expect(chapterFromColumns({ mdChapterId: null, ...columns })).toEqual(sparse);
  });

  it("keeps unknown extras out of the chapter and available separately", () => {
    const extras = { mdAttributes: { version: 4, title: "T" }, _id: "6959307522f8bdc1f027c7f3" };
    const columns = chapterToColumns(full, extras);

    expect(chapterFromColumns({ mdChapterId: full.mdChapterId, ...columns })).toEqual(full);
    expect(chapterExtras({ ...columns })).toEqual(extras);
  });

  it("promotes timestamps to Date and normalises them to UTC on the way back", () => {
    const columns = chapterToColumns({ ...full, chapterTimestamp: "2026-06-30T11:00:00+02:00" });
    expect(columns.chapterTimestamp).toEqual(new Date("2026-06-30T09:00:00.000Z"));
    expect(chapterFromColumns({ ...columns }).chapterTimestamp).toBe("2026-06-30T09:00:00.000Z");
  });

  it("drops an unparseable timestamp rather than throwing", () => {
    expect(chapterToColumns({ ...full, chapterExpire: "not-a-date" }).chapterExpire).toBeNull();
  });

  it("reads timestamps back from string columns, as a raw query returns them", () => {
    const chapter = chapterFromColumns({ chapterLookup: "2026-07-01T10:00:00.000Z" });
    expect(chapter.chapterLookup).toBe("2026-07-01T10:00:00.000Z");
  });

  it("tolerates a null or non-object extra", () => {
    expect(chapterFromColumns({ extra: null }).imageArtifacts).toEqual([]);
    expect(chapterFromColumns({ extra: "nonsense" }).imageArtifacts).toEqual([]);
    expect(chapterExtras({ extra: ["nonsense"] })).toEqual({});
  });

  it("only carries imageArtifacts when there are some", () => {
    expect(chapterToColumns(full).extra).toEqual({ imageArtifacts: full.imageArtifacts });
    expect(chapterToColumns({ ...full, imageArtifacts: [] }).extra).toBe(Prisma.DbNull);
  });
});

describe("uploadedChapterColumns", () => {
  it("keeps a named extension", () => {
    expect(uploadedChapterColumns(full).extension).toBe("exampleext");
  });

  it("substitutes an empty string for the NOT NULL column when unnamed", () => {
    expect(uploadedChapterColumns(sparse).extension).toBe("");
  });
});

describe("chapterFromJson / residualJsonKeys", () => {
  it("reads a chapter out of a JSON document and reports the rest", () => {
    const raw = {
      ...full,
      // What an EDIT upload task and a legacy Mongo document add on top.
      payload: { title: "New" },
      oldInfo: { title: "Old" },
      _id: "6959307522f8bdc1f027c7f3",
      images: null,
    };

    expect(chapterFromJson(raw)).toEqual(full);
    expect(residualJsonKeys(raw)).toEqual({
      payload: { title: "New" },
      oldInfo: { title: "Old" },
      _id: "6959307522f8bdc1f027c7f3",
      images: null,
    });
  });

  it("ignores empty strings and non-string values", () => {
    const chapter = chapterFromJson({ chapterTitle: "", chapterNumber: 12, imageArtifacts: [7] });
    expect(chapter.chapterTitle).toBeNull();
    expect(chapter.chapterNumber).toBeNull();
    expect(chapter.imageArtifacts).toEqual([]);
  });

  it("survives a document with a full round trip through the columns", () => {
    const raw = { ...full, _id: "abc", surprise: { deeply: ["nested"] } };
    const columns = chapterToColumns(chapterFromJson(raw), residualJsonKeys(raw));

    expect(chapterFromColumns({ mdChapterId: full.mdChapterId, ...columns })).toEqual(full);
    expect(chapterExtras({ ...columns })).toEqual({ _id: "abc", surprise: { deeply: ["nested"] } });
  });

  it("lists exactly the Chapter keys that have a column", () => {
    // Guards the mapping against a field being added to Chapter and silently
    // becoming residue instead of a column.
    const chapterKeys = Object.keys(full).filter((key) => key !== "imageArtifacts");
    expect([...CHAPTER_JSON_KEYS].sort()).toEqual(chapterKeys.sort());
  });
});
