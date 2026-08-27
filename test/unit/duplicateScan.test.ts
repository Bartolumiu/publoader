import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createLogger } from "../../src/logging.js";
import { DuplicateScanner, buildSets } from "../../src/core/md/duplicateScan.js";
import type { MdExtendedApi } from "../../src/core/md/client.js";
import type { AuditLog } from "../../src/core/store/settings.js";
import type { MdChapter } from "../../src/core/md/types.js";

/**
 * Finding the chapters MangaDex holds twice, without running an extension.
 *
 * What makes this worth its own suite is the half that ISN'T
 * `findDuplicateChapters` -- that function is already pinned in dedupe.test.ts
 * and is shared, deliberately, so a scan and a run cannot disagree. What is new
 * here is everything around it, and each of these properties costs real data or
 * real minutes when it regresses:
 *
 *  - a duplicate is scoped to ONE SERIES. The group walk returns every chapter
 *    the group has, and two series can legitimately hold the same publisher
 *    link; bucketing them together would queue a deletion for a chapter that is
 *    not a duplicate of anything.
 *  - reporting writes NOTHING. The default answer to "does this have
 *    duplicates" must never delete a public page as a side effect.
 *  - `apply` queues one DELETE per surplus chapter and none for the survivor.
 *  - a chapter with a delete already queued is left alone rather than re-armed,
 *    because re-arming a row an uploader is mid-flight against is how a chapter
 *    gets deleted twice.
 *  - scoping to a title asks per series instead of walking the group: the
 *    difference between a few seconds and a few minutes.
 */

const GROUP = "grp";
/** The MangaDex account these fixtures pretend publoader uploads as. */
const BOT = "74d95af1-7492-4fca-bc44-10c9142703e8";

const mdChapter = (
  id: string,
  mangaId: string,
  attributes: Partial<MdChapter["attributes"]> = {},
  groups: string[] = [GROUP],
): MdChapter => ({
  id,
  attributes: {
    volume: null,
    chapter: null,
    title: null,
    translatedLanguage: "en",
    externalUrl: null,
    version: 1,
    createdAt: "2024-01-01T00:00:00+00:00",
    ...attributes,
  } as MdChapter["attributes"],
  relationships: [
    { id: mangaId, type: "manga" },
    ...groups.map((group) => ({ id: group, type: "scanlation_group" })),
    // The scan hard-deletes, so it refuses to touch a chapter it cannot show
    // this account uploaded. Without an uploader every fixture would be testing
    // that refusal rather than the duplicate logic.
    { id: BOT, type: "user" },
  ],
});

interface Harness {
  scanner: DuplicateScanner;
  /** Every DELETE the scan queued, in order. */
  queued: { dedupeKey: string; chapter: Record<string, unknown> }[];
  /** How the chapters were read, so the fetch shape can be asserted. */
  reads: { kind: "group" | "series"; id: string }[];
}

function harness(
  chapters: MdChapter[],
  opts: {
    /** Chapter ids that already have a queue row, and in which state. */
    existingTasks?: Record<string, "PENDING" | "LEASED">;
    multiChapters?: { chapterId: string; chapterNumber: string }[];
  } = {},
): Harness {
  const queued: { dedupeKey: string; chapter: Record<string, unknown> }[] = [];
  const reads: { kind: "group" | "series"; id: string }[] = [];
  const existing = opts.existingTasks ?? {};

  const prisma = {
    uploadedChapter: {
      findMany: async (args: { select?: Record<string, boolean> }) =>
        args.select?.["mangaName"]
          ? // The name lookup. Deliberately empty: the fallback to MangaDex is
            // what most scans take, and it is the path worth exercising.
            []
          : [{ extension: "ext", mdGroupId: GROUP }],
    },
    extensionChapterAlias: { findMany: async () => [] },
    extensionMultiChapter: { findMany: async () => opts.multiChapters ?? [] },
    extensionLanguageMap: { findMany: async () => [] },
    /**
     * Stands in for the two raw statements the queue store runs: the upsert
     * `requeueForChapter` issues, and the `dedupe_key = ANY(…)` lookup it falls
     * back to when the upsert declined. They are told apart by the array
     * parameter only the lookup carries.
     *
     * The contract the scanner depends on is the upsert's: rows back when the
     * slot was free or held by a settled task, nothing back when a PENDING or
     * LEASED task holds it.
     */
    $queryRaw: async (sql: { values?: unknown[] }) => {
      const values = sql.values ?? [];
      const keys = values.find((value): value is string[] => Array.isArray(value));
      if (keys) {
        return keys
          .filter((key) => existing[key])
          .map((key) => ({
            id: `existing-${key}`,
            kind: "DELETE",
            dedupeKey: key,
            state: existing[key],
          }));
      }

      const dedupeKey = values.find(
        (value): value is string => typeof value === "string" && value.startsWith("dup-"),
      );
      const payload = values.find(
        (value): value is string => typeof value === "string" && value.startsWith("{"),
      );
      if (!dedupeKey) return [];
      if (existing[dedupeKey]) return [];
      queued.push({
        dedupeKey,
        chapter: JSON.parse(payload ?? "{}") as Record<string, unknown>,
      });
      return [{ id: `task-${dedupeKey}`, kind: "DELETE", dedupeKey, state: "PENDING", inserted: true }];
    },
  } as unknown as PrismaClient;

  const md = {
    chaptersForGroup: async (groupId: string) => {
      reads.push({ kind: "group", id: groupId });
      return chapters;
    },
    chaptersForManga: async (mangaId: string) => {
      reads.push({ kind: "series", id: mangaId });
      return chapters.filter((chapter) =>
        chapter.relationships.some((rel) => rel.type === "manga" && rel.id === mangaId),
      );
    },
    mangaByIds: async (ids: string[]) =>
      ids.map((id) => ({
        id,
        attributes: { title: { en: `Title ${id}` }, altTitles: [], originalLanguage: "ja" },
      })),
  } as unknown as MdExtendedApi;

  const audit = { record: async () => undefined } as unknown as AuditLog;
  const scanner = new DuplicateScanner({
    prisma,
    md,
    audit,
    log: createLogger("duplicate-scan-test", "error"),
    botUserId: BOT,
  });
  return { scanner, queued, reads };
}

const scan = (h: Harness, over: Partial<Parameters<DuplicateScanner["run"]>[0]> = {}) =>
  h.scanner.run({ extensions: [], mangaIds: [], apply: false, actor: "test", ...over });

describe("DuplicateScanner", () => {
  it("finds a duplicate per series and keeps the oldest", async () => {
    const h = harness([
      mdChapter("dup-old", "manga-a", { chapter: "1", externalUrl: "https://pub/c/1" }),
      mdChapter("dup-new", "manga-a", {
        chapter: "1",
        externalUrl: "https://pub/c/1",
        createdAt: "2025-01-01T00:00:00+00:00",
      }),
    ]);

    const report = await scan(h);

    expect(report.duplicatesFound).toBe(1);
    expect(report.seriesWithDuplicates).toBe(1);
    expect(report.series[0]?.mdMangaId).toBe("manga-a");
    expect(report.series[0]?.duplicates[0]?.keep.mdChapterId).toBe("dup-old");
    expect(report.series[0]?.duplicates[0]?.remove.map((r) => r.mdChapterId)).toEqual(["dup-new"]);
    expect(report.series[0]?.duplicates[0]?.matchedOn).toBe("url");
  });

  /**
   * The property the whole "per series" framing rests on. A group walk hands
   * back every chapter the group has, and the same publisher link genuinely
   * appears under two titles (a chapter republished when a series was split or
   * repointed). Compared group-wide, one of them is surplus and gets deleted —
   * a live chapter of a series that has no duplicates at all.
   */
  it("never calls the same link in two different series a duplicate", async () => {
    const h = harness([
      mdChapter("dup-a", "manga-a", { chapter: "1", externalUrl: "https://pub/c/1" }),
      mdChapter("dup-b", "manga-b", { chapter: "1", externalUrl: "https://pub/c/1" }),
    ]);

    const report = await scan(h);

    expect(report.duplicatesFound).toBe(0);
    expect(report.seriesScanned).toBe(2);
  });

  it("reports without writing anything", async () => {
    const h = harness([
      mdChapter("dup-old", "manga-a", { chapter: "1", externalUrl: "https://pub/c/1" }),
      mdChapter("dup-new", "manga-a", { chapter: "1", externalUrl: "https://pub/c/1" }),
    ]);

    const report = await scan(h);

    expect(report.duplicatesFound).toBe(1);
    expect(report.queued).toBe(0);
    expect(h.queued).toEqual([]);
    expect(report.series[0]?.duplicates[0]?.remove[0]?.outcome).toBe("found");
  });

  it("queues a delete for the surplus chapter only", async () => {
    const h = harness([
      mdChapter("dup-old", "manga-a", { chapter: "1", externalUrl: "https://pub/c/1" }),
      mdChapter("dup-new", "manga-a", { chapter: "1", externalUrl: "https://pub/c/1" }),
    ]);

    const report = await scan(h, { apply: true });

    expect(report.queued).toBe(1);
    expect(h.queued.map((task) => task.dedupeKey)).toEqual(["dup-new"]);
    // The queued payload has to name the series and group, or the uploader
    // archives a chapter it cannot describe.
    expect(h.queued[0]?.chapter).toMatchObject({
      mdChapterId: "dup-new",
      mdMangaId: "manga-a",
      mdGroupId: GROUP,
      extensionName: "ext",
    });
    // Never carded, whatever the removal mode: a card on a duplicate leaves the
    // duplicate in place.
    expect(h.queued[0]?.chapter).not.toHaveProperty("unavailableAt");
  });

  it("leaves a chapter whose delete is already in flight alone", async () => {
    const h = harness(
      [
        mdChapter("dup-old", "manga-a", { chapter: "1", externalUrl: "https://pub/c/1" }),
        mdChapter("dup-new", "manga-a", { chapter: "1", externalUrl: "https://pub/c/1" }),
      ],
      { existingTasks: { "dup-new": "LEASED" } },
    );

    const report = await scan(h, { apply: true });

    expect(report.queued).toBe(0);
    expect(report.blocked).toBe(1);
    expect(h.queued).toEqual([]);
    expect(report.series[0]?.duplicates[0]?.remove[0]?.outcome).toBe("leased");
  });

  /**
   * Regression guard on the shared exclusion. Marking a chapter unavailable
   * repoints its externalUrl at the series page, the same URL for every card of
   * that series, so on the duplicate key they collapse into one bucket. A scan
   * that lost the exclusion would hard-delete the platform's own cards.
   */
  it("never treats two of our own unavailable cards as duplicates", async () => {
    const h = harness([
      mdChapter("dup-card-1", "manga-a", {
        chapter: "1",
        externalUrl: "https://pub/manga/42",
        pages: 1,
      } as Partial<MdChapter["attributes"]>),
      mdChapter("dup-card-2", "manga-a", {
        chapter: "2",
        externalUrl: "https://pub/manga/42",
        pages: 1,
      } as Partial<MdChapter["attributes"]>),
    ]);

    const report = await scan(h, { apply: true });

    expect(report.duplicatesFound).toBe(0);
    expect(h.queued).toEqual([]);
  });

  it("spares the chapters a multi_chapters override declares", async () => {
    const h = harness(
      [
        mdChapter("dup-m1", "manga-a", { chapter: "7", externalUrl: "https://pub/c/multi" }),
        mdChapter("dup-m2", "manga-a", { chapter: "8", externalUrl: "https://pub/c/multi" }),
      ],
      { multiChapters: [
        { chapterId: "multi", chapterNumber: "7" },
        { chapterId: "multi", chapterNumber: "8" },
      ] },
    );

    const report = await scan(h, { apply: true });

    expect(report.duplicatesFound).toBe(0);
    expect(h.queued).toEqual([]);
  });

  it("asks per series when scoped, and walks the group when not", async () => {
    const chapters = [
      mdChapter("dup-old", "manga-a", { chapter: "1", externalUrl: "https://pub/c/1" }),
      mdChapter("dup-new", "manga-a", { chapter: "1", externalUrl: "https://pub/c/1" }),
      mdChapter("other", "manga-b", { chapter: "1", externalUrl: "https://pub/c/9" }),
    ];

    const scoped = harness(chapters);
    const scopedReport = await scan(scoped, { mangaIds: ["manga-a"] });
    expect(scoped.reads).toEqual([{ kind: "series", id: "manga-a" }]);
    expect(scopedReport.seriesScanned).toBe(1);
    expect(scopedReport.duplicatesFound).toBe(1);

    const whole = harness(chapters);
    await scan(whole);
    expect(whole.reads).toEqual([{ kind: "group", id: GROUP }]);
  });

  /**
   * The two fetch shapes must agree about which copy survives, and left alone
   * they do not: `chaptersForManga` asks MangaDex for newest-first while the
   * group walk asks for oldest-first, and the decision falls back to input
   * order wherever MangaDex omitted `createdAt`. A scoped scan would then keep
   * the newest copy and delete the original — the opposite of what an unscoped
   * scan does to the very same chapters.
   */
  it("keeps the same copy whether the scan is scoped or not", async () => {
    // Written oldest-first; the fake `chaptersForManga` reverses to newest-first
    // the way MangaDex's own ordering does, and neither carries a createdAt.
    const chapters = [
      mdChapter("dup-first", "manga-a", {
        chapter: "1",
        externalUrl: "https://pub/c/1",
        createdAt: "",
      }),
      mdChapter("dup-second", "manga-a", {
        chapter: "1",
        externalUrl: "https://pub/c/1",
        createdAt: "",
      }),
    ];

    const whole = harness(chapters);
    const wholeReport = await scan(whole);
    const scoped = harness([...chapters].reverse());
    const scopedReport = await scan(scoped, { mangaIds: ["manga-a"] });

    expect(wholeReport.series[0]?.duplicates[0]?.keep.mdChapterId).toBe("dup-first");
    expect(scopedReport.series[0]?.duplicates[0]?.keep.mdChapterId).toBe("dup-first");
  });

  it("names the affected series", async () => {
    const h = harness([
      mdChapter("dup-old", "manga-a", { chapter: "1", externalUrl: "https://pub/c/1" }),
      mdChapter("dup-new", "manga-a", { chapter: "1", externalUrl: "https://pub/c/1" }),
    ]);

    const report = await scan(h);

    expect(report.series[0]?.mangaName).toBe("Title manga-a");
  });

  it("declares its steps up front so a poller can draw a queue", async () => {
    const h = harness([
      mdChapter("dup-old", "manga-a", { chapter: "1", externalUrl: "https://pub/c/1" }),
      mdChapter("dup-new", "manga-a", { chapter: "1", externalUrl: "https://pub/c/1" }),
    ]);

    await scan(h, { apply: true });

    const steps = h.scanner.steps();
    expect(steps.map((step) => step.id)).toEqual([
      "groups",
      `read:${GROUP}`,
      `scan:${GROUP}`,
      `delete:${GROUP}`,
    ]);
    expect(steps.every((step) => step.state === "done")).toBe(true);
  });
});

describe("buildSets", () => {
  it("pairs each removal with the chapter that survives it", () => {
    const keep = mdChapter("keep", "manga-a", { chapter: "1", externalUrl: "https://pub/c/1" });
    const gone = mdChapter("gone", "manga-a", { chapter: "1", externalUrl: "https://pub/c/1" });
    const untouched = mdChapter("solo", "manga-a", { chapter: "2", externalUrl: "https://pub/c/2" });

    const sets = buildSets([keep, gone, untouched], [gone]);

    expect(sets).toHaveLength(1);
    expect(sets[0]?.keep.mdChapterId).toBe("keep");
    expect(sets[0]?.remove.map((r) => r.mdChapterId)).toEqual(["gone"]);
  });

  /**
   * A chapter carrying our unavailable card shares a URL with whatever it was
   * carded from, but the decision never compared it — cards are excluded before
   * anything is bucketed. Left in here it would be named as the survivor of a
   * decision it took no part in, telling an operator the wrong id is the one
   * being kept.
   */
  it("never names an unavailable card as the survivor", () => {
    const card = mdChapter("card", "manga-a", {
      chapter: "1",
      externalUrl: "https://pub/c/1",
      pages: 1,
    } as Partial<MdChapter["attributes"]>);
    const keep = mdChapter("keep", "manga-a", {
      chapter: "1",
      externalUrl: "https://pub/c/1",
      createdAt: "2024-06-01T00:00:00+00:00",
    });
    const gone = mdChapter("gone", "manga-a", {
      chapter: "1",
      externalUrl: "https://pub/c/1",
      createdAt: "2025-01-01T00:00:00+00:00",
    });

    const sets = buildSets([card, keep, gone], [gone], GROUP);

    expect(sets[0]?.keep.mdChapterId).toBe("keep");
  });

  it("ignores another group's chapters when a group is named", () => {
    const keep = mdChapter("keep", "manga-a", { chapter: "1", externalUrl: "https://pub/c/1" });
    const gone = mdChapter("gone", "manga-a", {
      chapter: "1",
      externalUrl: "https://pub/c/1",
      createdAt: "2025-01-01T00:00:00+00:00",
    });
    const theirs = mdChapter(
      "theirs",
      "manga-a",
      { chapter: "1", externalUrl: "https://pub/c/1" },
      ["someone-else"],
    );

    const sets = buildSets([theirs, keep, gone], [gone], GROUP);

    expect(sets[0]?.keep.mdChapterId).toBe("keep");
    expect(sets[0]?.remove.map((r) => r.mdChapterId)).toEqual(["gone"]);
  });

  it("says what made a page-hosted pair the same chapter", () => {
    const keep = mdChapter("keep", "manga-a", { chapter: "4", volume: "1" });
    const gone = mdChapter("gone", "manga-a", { chapter: "4", volume: "1" });

    const sets = buildSets([keep, gone], [gone]);

    expect(sets[0]?.matchedOn).toBe("number");
    expect(sets[0]?.language).toBe("en");
  });
});
