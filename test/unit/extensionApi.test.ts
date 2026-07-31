import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChapterInput,
  CollectResult,
  MangaInput,
  NODE_RUNNER_VERSION,
} from "../../src/contracts/extensionApi.js";
import {
  createExtensionContext,
  invertMangaIdMap,
  resolveDataFilePath,
} from "../../src/extsdk/context.js";

const validChapter = {
  chapterId: "c1",
  chapterUrl: "https://example.com/c1",
  mangaId: "m1",
};

describe("ChapterInput", () => {
  it("fills every optional field with null", () => {
    const parsed = ChapterInput.parse(validChapter);
    expect(parsed).toMatchObject({
      chapterTimestamp: null,
      chapterExpire: null,
      chapterLanguage: null,
      chapterNumber: null,
      chapterTitle: null,
      chapterVolume: null,
      mdMangaId: null,
      mangaName: null,
      mangaUrl: null,
    });
  });

  it("requires the three identifying fields", () => {
    expect(() => ChapterInput.parse({ chapterUrl: "u", mangaId: "m" })).toThrow();
    expect(() => ChapterInput.parse({ chapterId: "c", mangaId: "m" })).toThrow();
    expect(() => ChapterInput.parse({ chapterId: "c", chapterUrl: "u" })).toThrow();
  });

  it("rejects unknown fields rather than silently dropping them", () => {
    // .strict() is the point: a typo'd field name is a bug in the extension,
    // and letting it through would mean data quietly never arriving.
    expect(() => ChapterInput.parse({ ...validChapter, chapterNumbr: "1" })).toThrow();
  });

  it("requires datetimes to carry an offset", () => {
    expect(() =>
      ChapterInput.parse({ ...validChapter, chapterTimestamp: "2026-01-01 00:00:00" }),
    ).toThrow();
    expect(() =>
      ChapterInput.parse({ ...validChapter, chapterTimestamp: "2026-01-01T00:00:00Z" }),
    ).not.toThrow();
    expect(() =>
      ChapterInput.parse({ ...validChapter, chapterTimestamp: "2026-01-01T00:00:00+09:00" }),
    ).not.toThrow();
  });

  it("requires mdMangaId to be a uuid when present", () => {
    expect(() => ChapterInput.parse({ ...validChapter, mdMangaId: "not-a-uuid" })).toThrow();
    expect(() =>
      ChapterInput.parse({ ...validChapter, mdMangaId: "11111111-1111-4111-8111-111111111111" }),
    ).not.toThrow();
  });

  it("enforces the field length caps", () => {
    expect(() => ChapterInput.parse({ ...validChapter, chapterNumber: "x".repeat(65) })).toThrow();
    expect(() => ChapterInput.parse({ ...validChapter, chapterUrl: "u".repeat(2049) })).toThrow();
  });

  it("accepts page images as byte arrays and caps the count", () => {
    expect(() =>
      ChapterInput.parse({ ...validChapter, images: [new Uint8Array([1, 2, 3])] }),
    ).not.toThrow();
    expect(() => ChapterInput.parse({ ...validChapter, images: ["not bytes"] })).toThrow();
    expect(() =>
      ChapterInput.parse({
        ...validChapter,
        images: Array.from({ length: 501 }, () => new Uint8Array()),
      }),
    ).toThrow();
  });
});

describe("MangaInput", () => {
  it("requires all four fields", () => {
    expect(() =>
      MangaInput.parse({ mangaId: "m", mangaName: "n", mangaLanguage: "en", mangaUrl: "u" }),
    ).not.toThrow();
    expect(() => MangaInput.parse({ mangaId: "m", mangaName: "n", mangaLanguage: "en" })).toThrow();
  });
});

describe("CollectResult", () => {
  it("defaults an empty result to the safe shape", () => {
    const parsed = CollectResult.parse({});
    expect(parsed.updatedChapters).toEqual([]);
    expect(parsed.untrackedManga).toEqual([]);
    // null, not []: absence of a catalogue means "no removal information",
    // never "everything was removed".
    expect(parsed.allChapters).toBeNull();
  });

  it("keeps an explicitly empty catalogue distinct from an absent one", () => {
    expect(CollectResult.parse({ allChapters: [] }).allChapters).toEqual([]);
    expect(CollectResult.parse({ allChapters: null }).allChapters).toBeNull();
  });

  it("rejects unknown top-level keys", () => {
    expect(() => CollectResult.parse({ chapters: [] })).toThrow();
  });

  it("rejects a malformed chapter inside a valid envelope", () => {
    expect(() => CollectResult.parse({ updatedChapters: [{ chapterId: "c1" }] })).toThrow();
  });

  it("pins the runner wire version at 2", () => {
    expect(NODE_RUNNER_VERSION).toBe(2);
  });
});

describe("invertMangaIdMap", () => {
  it("inverts the lease's {md: [externals]} shape", () => {
    const map = invertMangaIdMap({
      "11111111-1111-4111-8111-111111111111": ["m1", "m1-alt"],
      "22222222-2222-4222-8222-222222222222": ["m2"],
    });
    expect(map.get("m1")).toBe("11111111-1111-4111-8111-111111111111");
    expect(map.get("m1-alt")).toBe("11111111-1111-4111-8111-111111111111");
    expect(map.get("m2")).toBe("22222222-2222-4222-8222-222222222222");
    expect(map.size).toBe(3);
  });

  it("survives junk values without throwing", () => {
    const map = invertMangaIdMap({ a: "not-an-array" as unknown as string[], b: [] });
    expect(map.size).toBe(0);
  });
});

describe("resolveDataFilePath", () => {
  const bundle = "/bundles/e2etest";

  it("resolves through the manifest's data_files alias", () => {
    expect(resolveDataFilePath(bundle, { manga_id_map: "manga_id_map.json" }, "manga_id_map")).toBe(
      "/bundles/e2etest/manga_id_map.json",
    );
  });

  it("falls back to treating the name as a relative path", () => {
    expect(resolveDataFilePath(bundle, {}, "data/extra.json")).toBe(
      "/bundles/e2etest/data/extra.json",
    );
  });

  it("refuses to escape the bundle directory", () => {
    expect(() => resolveDataFilePath(bundle, {}, "../../etc/passwd")).toThrow(/outside the bundle/);
    expect(() => resolveDataFilePath(bundle, { evil: "../../../etc/passwd" }, "evil")).toThrow(
      /outside the bundle/,
    );
  });

  it("refuses absolute paths", () => {
    expect(() => resolveDataFilePath(bundle, {}, "/etc/passwd")).toThrow(/absolute/);
  });

  it("does not treat a sibling with a shared prefix as inside", () => {
    expect(() => resolveDataFilePath(bundle, {}, "../e2etest-evil/x.json")).toThrow(
      /outside the bundle/,
    );
  });
});

describe("createExtensionContext", () => {
  function makeBundle(): string {
    const dir = mkdtempSync(join(tmpdir(), "publoader-ctx-"));
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(join(dir, "manga_id_map.json"), '{"a":["b"]}');
    writeFileSync(join(dir, "nested", "deep.txt"), "deep");
    return dir;
  }

  const manifest = {
    name: "fixture",
    allowed_hosts: ["example.com"],
    data_files: { manga_id_map: "manga_id_map.json" },
    languages: ["en"],
  };

  it("exposes the inverted map, a frozen manifest, and data files", async () => {
    const bundleDir = makeBundle();
    const { ctx } = createExtensionContext({
      manifest,
      bundleDir,
      mangaIdMap: { "11111111-1111-4111-8111-111111111111": ["m1"] },
      logStream: { write: () => true },
    });

    expect(ctx.mangaIdMap.get("m1")).toBe("11111111-1111-4111-8111-111111111111");
    expect(Object.isFrozen(ctx.manifest)).toBe(true);
    expect(await ctx.dataFile("manga_id_map")).toBe('{"a":["b"]}');
    expect(await ctx.dataFile("nested/deep.txt")).toBe("deep");
    await expect(ctx.dataFile("../../../etc/passwd")).rejects.toThrow(/outside the bundle/);
  });

  it("enforces the manifest's allowed_hosts through ctx.fetch", async () => {
    const { ctx } = createExtensionContext({
      manifest,
      bundleDir: makeBundle(),
      fetch: { minIntervalMs: 0, fetchImpl: (async () => new Response("ok")) as typeof fetch },
      logStream: { write: () => true },
    });
    await expect(ctx.fetch("https://example.com/x")).resolves.toBeInstanceOf(Response);
    await expect(ctx.fetch("https://elsewhere.test/x")).rejects.toThrow(/allowed_hosts/);
  });

  it("logs JSON lines to the stream it was given, never stdout", () => {
    const lines: string[] = [];
    const { ctx } = createExtensionContext({
      manifest,
      bundleDir: makeBundle(),
      logFields: { jobId: "job-1" },
      logStream: {
        write: (chunk: string) => {
          lines.push(chunk);
          return true;
        },
      },
    });
    ctx.log("hello", { count: 3 });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(parsed["message"]).toBe("hello");
    expect(parsed["count"]).toBe(3);
    expect(parsed["jobId"]).toBe("job-1");
    expect(parsed["source"]).toBe("extension");
  });
});
