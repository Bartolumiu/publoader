import { afterAll, beforeEach, describe, expect, it } from "vitest";
import AdmZip from "adm-zip";
import { BundleStore } from "../../src/core/store/bundles.js";
import { ExtensionConfigStore } from "../../src/core/store/extensionConfig.js";
import { TrackedMangaStore, buildMangaIdMap } from "../../src/core/store/trackedManga.js";
import { decideForManga, findDuplicateChapters } from "../../src/core/processor/dedupe.js";
import type { Chapter, MdChapter } from "../../src/core/md/types.js";
import { closeDb, dbReady, resetDb, testPrisma } from "./db.js";

/**
 * The three relations that used to hide in `extension_configs.override_options`
 * are tables now. What has to hold:
 *
 *   - a legacy document round-trips into the exact shape core/processor/dedupe.ts
 *     consumes, so the decision logic did not change when the storage did;
 *   - the constraints the JSON could not express are enforced (an alias has ONE
 *     master; a MangaDex language code must be real) and a refused row is
 *     reported rather than thrown or silently kept;
 *   - the extension-private keys the blob still carries survive a write.
 */
describe.skipIf(!dbReady())("extension config tables", () => {
  const prisma = testPrisma();
  const store = new ExtensionConfigStore(prisma);
  /** The MangaDex account these fixtures pretend publoader uploads as. */
  const BOT_USER_ID = "74d95af1-7492-4fca-bc44-10c9142703e8";

  beforeEach(async () => {
    await resetDb(prisma);
  });
  afterAll(async () => {
    await closeDb();
  });

  /** The real mangaplus override_options.json shape, trimmed. */
  const legacyDocument = {
    same: { "1000331": ["1008462"], "1000332": ["1008463"] },
    multi_chapters: { "1007745": ["0", "1"], "1019642": ["1", "2"] },
    custom_language: { "200159": "es-la" },
    // Extension-private: read by mangaplus in the worker, never by core.
    empty: ["100112", "100114"],
    noformat: [],
    custom: { "100028": "^chapter\\s\\d+:?\\s?" },
    num2words: ["one", "two"],
    override_chapter_numbers: { "1028969": "1" },
    no_chapters: ["100258"],
  };

  it("round-trips a legacy document into the shape dedupe consumes", async () => {
    const result = await store.replace("mangaplus", legacyDocument);
    expect(result.rejected).toEqual([]);
    expect(result).toMatchObject({ aliases: 2, multiChapters: 4, languages: 1 });

    const loaded = await store.load("mangaplus");
    expect(loaded).toEqual({
      same: legacyDocument.same,
      multi_chapters: legacyDocument.multi_chapters,
      custom_language: legacyDocument.custom_language,
    });
  });

  it("keeps the extension-private keys out of the tables and in the blob", async () => {
    const result = await store.replace("mangaplus", legacyDocument);
    // Dropping the column outright would have deleted all six of these; they are
    // live config with no other home.
    expect(result.passthroughKeys).toEqual([
      "custom",
      "empty",
      "no_chapters",
      "noformat",
      "num2words",
      "override_chapter_numbers",
    ]);

    const row = await prisma.extensionConfig.findUniqueOrThrow({ where: { extension: "mangaplus" } });
    expect(row.overrideOptions).toEqual({
      empty: ["100112", "100114"],
      noformat: [],
      custom: { "100028": "^chapter\\s\\d+:?\\s?" },
      num2words: ["one", "two"],
      override_chapter_numbers: { "1028969": "1" },
      no_chapters: ["100258"],
    });
    // The three modelled keys are gone from the blob, so there is exactly one
    // place each of them lives.
    expect(Object.keys(row.overrideOptions as object)).not.toContain("same");
  });

  it("reassembles the whole document for GET, so get | set round-trips", async () => {
    await store.replace("mangaplus", legacyDocument);
    const described = await store.describe("mangaplus");
    expect(described.overrideOptions).toEqual(legacyDocument);

    // Feeding it straight back in is a no-op, not a drift.
    const again = await store.replace("mangaplus", described.overrideOptions);
    expect(again.rejected).toEqual([]);
    expect(await store.describe("mangaplus")).toMatchObject({ overrideOptions: legacyDocument });
  });

  it("refuses a second master for one alias and says which row it dropped", async () => {
    const result = await store.replace("mangaplus", {
      same: { "1000331": ["1008462"], "9999999": ["1008462", "9999999"] },
    });

    // The constraint the JSON dict could not express. Without it,
    // findKeyFromListValue resolved 1008462 to whichever master JSON key order
    // happened to enumerate first, so "was this already uploaded" depended on
    // key order.
    expect(await store.load("mangaplus")).toMatchObject({ same: { "1000331": ["1008462"] } });
    expect(result.rejected).toEqual([
      {
        option: "same",
        key: "9999999",
        value: "1008462",
        reason: "already an alias of 1000331; an alias may have only one master",
      },
      {
        option: "same",
        key: "9999999",
        value: "9999999",
        reason: "a chapter cannot be an alias of itself",
      },
    ]);
  });

  it("rejects a language code MangaDex does not have, and keeps the rest", async () => {
    const result = await store.replace("mangaplus", {
      custom_language: { good: "es-la", cased: "PT-BR", typo: "pt_br", nonsense: "klingon" },
    });

    // A dropped custom_language row silently stops protecting that language from
    // the chapter-removal pass, so it must be named, not swallowed.
    expect((await store.load("mangaplus")).custom_language).toEqual({
      good: "es-la",
      cased: "pt-br",
    });
    expect(result.rejected.map((r) => [r.key, r.value])).toEqual([
      ["typo", "pt_br"],
      ["nonsense", "klingon"],
    ]);
    expect(result.rejected[0]!.reason).toBe("not a MangaDex language code");
  });

  it("survives a document whose values are the wrong type", async () => {
    // viz's own file has `same` as a string in one revision. One malformed key
    // must not discard the others.
    const result = await store.replace("viz", {
      same: "not-an-object",
      multi_chapters: { "7": "not-a-list" },
      custom_language: { jp: "ja" },
      series_paid_only: ["1", "2"],
    });
    expect(await store.load("viz")).toEqual({
      same: {},
      multi_chapters: {},
      custom_language: { jp: "ja" },
    });
    expect(result.passthroughKeys).toEqual(["series_paid_only"]);
    expect(result.rejected).toHaveLength(2);
  });

  it("replaces rather than merges, so removing a key removes the rows", async () => {
    await store.replace("mangaplus", legacyDocument);
    await store.replace("mangaplus", { custom_language: { "200159": "es-la" } });
    expect(await store.load("mangaplus")).toEqual({
      same: {},
      multi_chapters: {},
      custom_language: { "200159": "es-la" },
    });
  });

  it("seeds from a bundle only while nothing has been curated", async () => {
    expect(await store.seedIfAbsent("mangaplus", legacyDocument)).toBe(true);
    // A later publish must not revert an operator's edit.
    expect(await store.seedIfAbsent("mangaplus", { same: { other: ["x"] } })).toBe(false);
    expect(await store.load("mangaplus")).toMatchObject({ same: legacyDocument.same });
  });

  it("delivers the reassembled document to a lease, tables winning over the blob", async () => {
    await store.replace("mangaplus", legacyDocument);
    // A stale key hand-written into the blob must not shadow the table.
    await prisma.extensionConfig.update({
      where: { extension: "mangaplus" },
      data: { overrideOptions: { empty: ["100112"], same: { stale: ["row"] } } },
    });
    const delivered = await store.loadForLease("mangaplus");
    expect(delivered["same"]).toEqual(legacyDocument.same);
    expect(delivered["empty"]).toEqual(["100112"]);
  });

  it("omits an empty relation rather than sending it as {}", async () => {
    await store.replace("mangaplus", { empty: ["100112"] });
    const delivered = await store.loadForLease("mangaplus");
    // An extension checking `options.same` for presence should see what it saw
    // when its bundle's JSON simply had no such key.
    expect(delivered).toEqual({ empty: ["100112"] });
  });

  // ---- the loaded shape actually drives the decisions ----

  const chapter = (over: Partial<Chapter> = {}): Chapter => ({
    chapterLookup: null,
    chapterTimestamp: null,
    chapterExpire: null,
    chapterLanguage: "en",
    chapterNumber: "1",
    chapterTitle: null,
    chapterVolume: null,
    chapterId: "c1",
    chapterUrl: "https://example.test/c1",
    mdChapterId: null,
    mangaId: "m1",
    mdMangaId: "11111111-1111-4111-8111-111111111111",
    mdGroupId: null,
    mangaName: "M",
    mangaUrl: null,
    extensionName: "mangaplus",
    imageArtifacts: [],
    ...over,
  });

  const mdChapter = (id: string, over: Record<string, unknown> = {}): MdChapter =>
    ({
      id,
      type: "chapter",
      attributes: {
        volume: null,
        chapter: "1",
        title: null,
        translatedLanguage: "en",
        externalUrl: null,
        version: 1,
        createdAt: "2026-01-01T00:00:00Z",
        ...over,
      },
      relationships: [
        { id: "22222222-2222-4222-8222-222222222222", type: "scanlation_group" },
        { id: "11111111-1111-4111-8111-111111111111", type: "manga" },
        // Removal decisions refuse to touch a chapter they cannot show this
        // account uploaded, so a fixture without an uploader exercises that
        // refusal rather than the override rules under test here.
        { id: BOT_USER_ID, type: "user" },
      ],
    }) as unknown as MdChapter;

  it("drives the same/custom_language/multi_chapters decisions from the tables", async () => {
    await store.replace("mangaplus", {
      same: { master: ["alt-1"] },
      custom_language: { fre: "fr" },
      multi_chapters: { multi: ["7", "8"] },
    });
    const overrideOptions = await store.loadForProcessor("mangaplus");

    // `same`: the alternate id is not re-uploaded when the master is on MangaDex.
    const sameResult = decideForManga({
      mangadexMangaId: "11111111-1111-4111-8111-111111111111",
      updatedChapters: [chapter({ chapterId: "alt-1", chapterUrl: "https://example.test/alt-1" })],
      allMangaChapters: null,
      chaptersOnMd: [mdChapter("aaaa1111-1111-4111-8111-111111111111", {
        externalUrl: "https://example.test/master",
      })],
      postedMdUpdates: [],
      overrideOptions,
      languages: ["en"],
      groupId: "22222222-2222-4222-8222-222222222222",
      cleanDb: false,
      botUserId: BOT_USER_ID,
    });
    expect(sameResult.skippedDifferentId).toHaveLength(1);
    expect(sameResult.toUpload).toHaveLength(0);

    // `custom_language`: an fr chapter is allowed to stay even though the
    // extension only declares en.
    const languageResult = decideForManga({
      mangadexMangaId: "11111111-1111-4111-8111-111111111111",
      updatedChapters: [],
      allMangaChapters: [chapter({ chapterUrl: "https://example.test/keep" })],
      chaptersOnMd: [
        mdChapter("bbbb1111-1111-4111-8111-111111111111", {
          translatedLanguage: "fr",
          externalUrl: "https://example.test/keep",
        }),
      ],
      postedMdUpdates: [],
      overrideOptions,
      languages: ["en"],
      groupId: "22222222-2222-4222-8222-222222222222",
      cleanDb: false,
      botUserId: BOT_USER_ID,
    });
    expect(languageResult.toRemove).toHaveLength(0);

    // `multi_chapters`: one survivor per declared number, the rest removed.
    const dupes = findDuplicateChapters(
      [
        mdChapter("cccc1111-1111-4111-8111-111111111111", {
          chapter: "7",
          externalUrl: "https://example.test/multi",
        }),
        mdChapter("dddd1111-1111-4111-8111-111111111111", {
          chapter: "8",
          externalUrl: "https://example.test/multi",
        }),
        mdChapter("eeee1111-1111-4111-8111-111111111111", {
          chapter: "9",
          externalUrl: "https://example.test/multi",
        }),
      ],
      {
        groupId: "22222222-2222-4222-8222-222222222222",
        multiChapters: overrideOptions.multi_chapters,
        botUserId: BOT_USER_ID,
      },
    );
    expect(dupes.map((c) => c.id)).toEqual(["eeee1111-1111-4111-8111-111111111111"]);
  });
});

/**
 * The collision this namespace column exists to prevent: viz reuses numeric ids
 * across `shonenjump` and `vizmanga`, and the same number under each is a
 * different series.
 */
describe.skipIf(!dbReady())("namespaced tracked manga", () => {
  const prisma = testPrisma();
  const store = new TrackedMangaStore(prisma);
  const MD_A = "9a0f1e7e-d84b-46e6-8596-ae5a60529e81";
  const MD_B = "7f30dfc3-0b80-4dcc-a3b9-0cd746fac005";
  const opts = { canWrite: true, source: "test" };

  beforeEach(async () => {
    await resetDb(prisma);
  });
  afterAll(async () => {
    await closeDb();
  });

  it("keeps the same external id in two catalogues as two rows", async () => {
    const summary = await store.applyBatch(
      "viz",
      {
        set: [
          { namespace: "vizmanga", mangaId: "709", mdMangaId: MD_A },
          { namespace: "shonenjump", mangaId: "709", mdMangaId: MD_B },
        ],
      },
      opts,
    );

    expect(summary).toMatchObject({ added: 2, failed: 0 });
    const rows = await store.list("viz");
    expect(rows.map((r) => [r.namespace, r.mangaId, r.mdMangaId])).toEqual([
      ["shonenjump", "709", MD_B],
      ["vizmanga", "709", MD_A],
    ]);
    // And the lease sees them as two distinct series.
    expect(buildMangaIdMap(rows)).toEqual({
      namespaced: true,
      mangaIdMap: { shonenjump: { [MD_B]: ["709"] }, vizmanga: { [MD_A]: ["709"] } },
    });
  });

  it("still de-duplicates within one catalogue", async () => {
    const summary = await store.applyBatch(
      "viz",
      {
        set: [
          { namespace: "vizmanga", mangaId: "709", mdMangaId: MD_A },
          { namespace: "vizmanga", mangaId: "709", mdMangaId: MD_B },
        ],
      },
      opts,
    );
    expect(summary.added).toBe(1);
    // Reported, not silently resolved: last value wins and the operator is told.
    expect(summary.results.some((r) => r.outcome === "invalid")).toBe(true);
    const rows = await store.list("viz", "vizmanga");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mdMangaId).toBe(MD_B);
  });

  it("scopes repoint, unchanged and remove to one catalogue", async () => {
    await store.applyBatch(
      "viz",
      {
        set: [
          { namespace: "vizmanga", mangaId: "709", mdMangaId: MD_A },
          { namespace: "shonenjump", mangaId: "709", mdMangaId: MD_A },
        ],
      },
      opts,
    );

    const summary = await store.applyBatch(
      "viz",
      {
        set: [{ namespace: "vizmanga", mangaId: "709", mdMangaId: MD_B }],
        remove: [{ namespace: "shonenjump", mangaId: "709" }],
      },
      opts,
    );
    expect(summary).toMatchObject({ updated: 1, removed: 1, failed: 0 });
    // Both results name their catalogue, because `709` alone does not identify
    // a series here.
    expect(summary.results.every((r) => r.namespace !== undefined)).toBe(true);

    const rows = await store.list("viz");
    expect(rows.map((r) => [r.namespace, r.mdMangaId])).toEqual([["vizmanga", MD_B]]);
  });

  it("does not let a default-space row be reached by a namespaced one", async () => {
    await store.applyBatch("mangaplus", { set: [{ mangaId: "100001", mdMangaId: MD_A }] }, opts);

    // Same external id, different catalogue: an add, not a repoint of the flat row.
    const added = await store.applyBatch(
      "mangaplus",
      { set: [{ namespace: "other", mangaId: "100001", mdMangaId: MD_B }] },
      opts,
    );
    expect(added).toMatchObject({ added: 1, updated: 0 });

    // And removing the namespaced one leaves the flat one alone.
    const removed = await store.applyBatch(
      "mangaplus",
      { remove: [{ namespace: "other", mangaId: "100001" }] },
      opts,
    );
    expect(removed).toMatchObject({ removed: 1, failed: 0 });
    const rows = await store.list("mangaplus");
    expect(rows.map((r) => [r.namespace, r.mdMangaId])).toEqual([["", MD_A]]);
  });

  it("omits the namespace from results for a flat extension", async () => {
    const summary = await store.applyBatch(
      "mangaplus",
      { set: [{ mangaId: "100001", mdMangaId: MD_A }] },
      opts,
    );
    // Existing callers (bot, dashboard) see exactly the shape they always did.
    expect(summary.results).toEqual([
      { mangaId: "100001", mdMangaId: MD_A, outcome: "added" },
    ]);
    expect(await store.namespaces("mangaplus")).toEqual([""]);
  });

  it("rejects a namespace that is not an identifier", async () => {
    const summary = await store.applyBatch(
      "viz",
      { set: [{ namespace: "Not A Namespace", mangaId: "709", mdMangaId: MD_A }] },
      opts,
    );
    expect(summary).toMatchObject({ added: 0, failed: 1 });
    expect(summary.results[0]!.detail).toContain("namespace must match");
  });

  it("writes nothing on a dry run", async () => {
    const preview = await store.applyBatch(
      "viz",
      { set: [{ namespace: "vizmanga", mangaId: "709", mdMangaId: MD_A }] },
      { ...opts, dryRun: true },
    );
    expect(preview.added).toBe(1);
    expect(await store.list("viz")).toEqual([]);
  });
});

/**
 * Publishing a bundle seeds both halves of an extension's config from its data
 * files. The three real file shapes are covered as units in
 * test/unit/trackedNamespace.test.ts; what needs a database is that a publish
 * lands them and that a second publish does not trample curation.
 */
describe.skipIf(!dbReady())("bundle config seeding", () => {
  const prisma = testPrisma();
  const bundles = new BundleStore(prisma);
  const config = new ExtensionConfigStore(prisma);
  const MD_A = "9a0f1e7e-d84b-46e6-8596-ae5a60529e81";
  const MD_B = "7f30dfc3-0b80-4dcc-a3b9-0cd746fac005";

  beforeEach(async () => {
    await resetDb(prisma);
  });
  afterAll(async () => {
    await closeDb();
  });

  const manifest = (over: Record<string, unknown> = {}) => ({
    name: "viz",
    version: "1.0.0",
    publoader_api: "^2.0.0",
    entrypoint: "index.mjs",
    mangadex_group_id: "22222222-2222-4222-8222-222222222222",
    languages: ["en"],
    allowed_hosts: ["example.com"],
    data_files: { manga_id_map: "manga_id_map.json", override_options: "override_options.json" },
    ...over,
  });

  function publish(m: Record<string, unknown>, files: Record<string, unknown>) {
    const zip = new AdmZip();
    zip.addFile("manifest.json", Buffer.from(JSON.stringify(m), "utf8"));
    zip.addFile("index.mjs", Buffer.from("export default () => ({});\n", "utf8"));
    for (const [name, content] of Object.entries(files)) {
      zip.addFile(name, Buffer.from(JSON.stringify(content), "utf8"));
    }
    return bundles.publish({ zipData: zip.toBuffer(), manifest: m });
  }

  it("seeds a nested manga_id_map into namespaced rows", async () => {
    await publish(manifest(), {
      "manga_id_map.json": { vizmanga: { "709": MD_A }, shonenjump: { "709": MD_B } },
      "override_options.json": { custom_language: { jp: "ja" }, series_paid_only: ["1"] },
    });

    const rows = await prisma.trackedManga.findMany({ orderBy: { namespace: "asc" } });
    expect(rows.map((r) => [r.namespace, r.mangaId, r.mdMangaId, r.source])).toEqual([
      ["shonenjump", "709", MD_B, "bundle-import"],
      ["vizmanga", "709", MD_A, "bundle-import"],
    ]);
    expect(await config.load("viz")).toMatchObject({ custom_language: { jp: "ja" } });
  });

  it("seeds a flat manga_id_map into the default namespace", async () => {
    await publish(manifest({ name: "mangaplus" }), {
      "manga_id_map.json": { [MD_A]: ["100001", "200008"] },
    });
    const rows = await prisma.trackedManga.findMany({ orderBy: { mangaId: "asc" } });
    expect(rows.map((r) => [r.namespace, r.mangaId])).toEqual([
      ["", "100001"],
      ["", "200008"],
    ]);
  });

  it("corrects its own earlier import but leaves an operator's decision alone", async () => {
    await publish(manifest(), { "manga_id_map.json": { vizmanga: { "709": MD_A, "218": MD_A } } });
    // An operator repoints one of them by hand.
    await prisma.trackedManga.updateMany({
      where: { extension: "viz", namespace: "vizmanga", mangaId: "218" },
      data: { mdMangaId: MD_B, source: "operator:alice" },
    });

    await publish(manifest({ version: "1.0.1" }), {
      "manga_id_map.json": { vizmanga: { "709": MD_B, "218": MD_A } },
    });

    const rows = await prisma.trackedManga.findMany({ orderBy: { mangaId: "asc" } });
    expect(rows.map((r) => [r.mangaId, r.mdMangaId, r.source])).toEqual([
      // The file's correction lands, because this row came from the file.
      ["218", MD_B, "operator:alice"],
      ["709", MD_B, "bundle-import"],
    ]);
  });

  it("does not overwrite curated override options on a later publish", async () => {
    await publish(manifest(), { "override_options.json": { custom_language: { jp: "ja" } } });
    await config.replace("viz", { custom_language: { jp: "ko" } });
    await publish(manifest({ version: "1.0.1" }), {
      "override_options.json": { custom_language: { jp: "ja" } },
    });
    expect((await config.load("viz")).custom_language).toEqual({ jp: "ko" });
  });

  it("warns about a manifest language MangaDex does not have, without refusing", async () => {
    const result = await publish(manifest({ name: "mangaplus", languages: ["en", "pt_br"] }), {});
    // A typo like pt_br is worth an operator's attention, but MangaDex adds
    // codes and a hard rejection would have no override.
    expect(result.created).toBe(true);
    expect(result.warnings).toEqual([
      'manifest language "pt_br" is not a MangaDex language code',
    ]);
  });
});
