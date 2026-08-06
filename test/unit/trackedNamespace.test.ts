import { describe, expect, it } from "vitest";
import {
  buildMangaIdMap,
  normaliseNamespace,
  parsePairs,
} from "../../src/core/store/trackedManga.js";
import { parseMangaIdMapFile } from "../../src/core/store/bundles.js";
import { normaliseMangadexLanguage } from "../../src/contracts/languages.js";

const MD_A = "9a0f1e7e-d84b-46e6-8596-ae5a60529e81";
const MD_B = "7f30dfc3-0b80-4dcc-a3b9-0cd746fac005";
const MD_C = "333f4d22-7753-4e3b-b0da-0a69b2cdce4f";

/**
 * The namespace exists because one extension is not guaranteed to have one flat
 * external id space: viz serves `shonenjump` and `vizmanga` from a single
 * extension, and `709` under each is a different series. These tests pin the two
 * places that fact has to survive; reading the file, and building the lease.
 */
describe("manga id map wire shape", () => {
  it("stays flat while every row is in the default id space", () => {
    const { mangaIdMap, namespaced } = buildMangaIdMap([
      { namespace: "", mangaId: "100001", mdMangaId: MD_C },
      { namespace: "", mangaId: "200008", mdMangaId: MD_C },
      { namespace: "", mangaId: "100002", mdMangaId: MD_A },
    ]);

    expect(namespaced).toBe(false);
    // Byte-for-byte mangaplus's manga_id_map.json, so an unmodified runner and
    // an unmodified extension see exactly what they saw before namespaces.
    expect(mangaIdMap).toEqual({ [MD_C]: ["100001", "200008"], [MD_A]: ["100002"] });
  });

  it("nests by namespace as soon as one row names a catalogue", () => {
    const { mangaIdMap, namespaced } = buildMangaIdMap([
      { namespace: "vizmanga", mangaId: "709", mdMangaId: MD_A },
      { namespace: "shonenjump", mangaId: "709", mdMangaId: MD_B },
    ]);

    expect(namespaced).toBe(true);
    // The same external id under two catalogues is two distinct series. Under
    // the old flat key it was one row and one of the two was lost.
    expect(mangaIdMap).toEqual({
      vizmanga: { [MD_A]: ["709"] },
      shonenjump: { [MD_B]: ["709"] },
    });
  });

  it("keeps default-space rows under the empty key when others are namespaced", () => {
    const { mangaIdMap, namespaced } = buildMangaIdMap([
      { namespace: "", mangaId: "legacy", mdMangaId: MD_C },
      { namespace: "vizmanga", mangaId: "709", mdMangaId: MD_A },
    ]);

    expect(namespaced).toBe(true);
    // Dropping them would hide half the catalogue; inventing a name for them
    // would not match the file an operator curates.
    expect(mangaIdMap).toEqual({ "": { [MD_C]: ["legacy"] }, vizmanga: { [MD_A]: ["709"] } });
  });

  it("still maps MANY external ids onto ONE mangadex title", () => {
    // Uniqueness is on the external side only, which is what makes the legacy
    // {mdId: [externalIds]} file shape expressible at all.
    const { mangaIdMap } = buildMangaIdMap([
      { namespace: "", mangaId: "100003", mdMangaId: MD_C },
      { namespace: "", mangaId: "100120", mdMangaId: MD_C },
      { namespace: "", mangaId: "600002", mdMangaId: MD_C },
    ]);
    expect(mangaIdMap).toEqual({ [MD_C]: ["100003", "100120", "600002"] });
  });

  it("is empty and flat for an extension with nothing tracked", () => {
    expect(buildMangaIdMap([])).toEqual({ mangaIdMap: {}, namespaced: false });
  });
});

describe("parsePairs", () => {
  it("reads two-column lines into the default namespace", () => {
    const { rows, errors } = parsePairs(`ext-1,${MD_A}`);
    expect(errors).toEqual([]);
    expect(rows).toEqual([{ mangaId: "ext-1", mdMangaId: MD_A, namespace: "" }]);
  });

  it("reads a third column as the namespace, in any column order", () => {
    const { rows, errors } = parsePairs(
      [
        `vizmanga,709,${MD_A}`,
        `${MD_B} shonenjump 709`, // uuid first
        `shonenjump;${MD_A};218`, // uuid in the middle
      ].join("\n"),
    );
    expect(errors).toEqual([]);
    // The uuid is found by shape; the two remaining values keep their relative
    // order, so namespace comes before external id.
    expect(rows).toEqual([
      { namespace: "vizmanga", mangaId: "709", mdMangaId: MD_A },
      { namespace: "shonenjump", mangaId: "709", mdMangaId: MD_B },
      { namespace: "shonenjump", mangaId: "218", mdMangaId: MD_A },
    ]);
  });

  it("applies defaultNamespace only to lines that do not name one", () => {
    const { rows } = parsePairs(`709,${MD_A}\nshonenjump,218,${MD_B}`, {
      defaultNamespace: "vizmanga",
    });
    expect(rows.map((r) => r.namespace)).toEqual(["vizmanga", "shonenjump"]);
  });

  it("keeps the header skip, comments, and per-line errors", () => {
    const { rows, errors } = parsePairs(
      [
        "external_id,mangadex_id",
        `good,${MD_A}`,
        "# comment",
        "no-uuid,also-not-a-uuid",
        "lonely",
        `Bad Namespace,709,${MD_B}`,
        `a,b,c,${MD_A}`,
      ].join("\n"),
    );
    expect(rows).toEqual([{ mangaId: "good", mdMangaId: MD_A, namespace: "" }]);
    expect(errors.map((e) => e.line)).toEqual([4, 5, 6, 7]);
    expect(errors[2]!.reason).toContain("namespace");
    expect(errors[3]!.reason).toContain("at most three");
  });

  it("lower-cases both the namespace and the title id", () => {
    const { rows } = parsePairs(`VizManga,709,${MD_A.toUpperCase()}`);
    expect(rows).toEqual([{ namespace: "vizmanga", mangaId: "709", mdMangaId: MD_A }]);
  });

  it("treats absent, blank, and whitespace namespaces as the default", () => {
    expect(normaliseNamespace(undefined)).toBe("");
    expect(normaliseNamespace("  ")).toBe("");
    expect(normaliseNamespace(" VizManga ")).toBe("vizmanga");
  });
});

describe("parseMangaIdMapFile", () => {
  it("reads the reverse shape mangaplus ships", () => {
    expect(parseMangaIdMapFile({ [MD_C]: ["100001", "200008"] })).toEqual([
      { namespace: "", mangaId: "100001", mdMangaId: MD_C },
      { namespace: "", mangaId: "200008", mdMangaId: MD_C },
    ]);
  });

  it("reads the forward shape alpha_manga ships", () => {
    // This shape used to be dropped on the floor: the old parser required array
    // values, so alpha_manga's whole map seeded nothing.
    expect(parseMangaIdMapFile({ "6000597": MD_A, "7000146": MD_B })).toEqual([
      { namespace: "", mangaId: "6000597", mdMangaId: MD_A },
      { namespace: "", mangaId: "7000146", mdMangaId: MD_B },
    ]);
  });

  it("reads the nested shape viz ships, one namespace per catalogue", () => {
    // Row order follows Object.entries, which puts integer-like keys in numeric
    // order regardless of how the file listed them; 218 before 709 here. Order
    // is not significant to any caller (the rows go to createMany), but the
    // expectation has to match it.
    expect(
      parseMangaIdMapFile({ shonenjump: {}, vizmanga: { "709": MD_A, "218": MD_B } }),
    ).toEqual([
      { namespace: "vizmanga", mangaId: "218", mdMangaId: MD_B },
      { namespace: "vizmanga", mangaId: "709", mdMangaId: MD_A },
    ]);
  });

  it("accepts a namespace whose contents are in the reverse shape", () => {
    expect(parseMangaIdMapFile({ vizmanga: { [MD_A]: ["709", "710"] } })).toEqual([
      { namespace: "vizmanga", mangaId: "709", mdMangaId: MD_A },
      { namespace: "vizmanga", mangaId: "710", mdMangaId: MD_A },
    ]);
  });

  it("skips rows where neither side is a mangadex id, rather than inserting them backwards", () => {
    expect(
      parseMangaIdMapFile({
        "not-a-uuid": "also-not-a-uuid",
        "no-uuid-key": ["1", "2"],
        good: MD_A,
      }),
    ).toEqual([{ namespace: "", mangaId: "good", mdMangaId: MD_A }]);
  });

  it("returns nothing for a document that is not an object", () => {
    expect(parseMangaIdMapFile([])).toEqual([]);
    expect(parseMangaIdMapFile(null)).toEqual([]);
    expect(parseMangaIdMapFile("nope")).toEqual([]);
  });
});

describe("mangadex language allowlist", () => {
  it("accepts the codes the real manifests and configs use", () => {
    for (const code of ["en", "es", "fr", "id", "pt-br", "ru", "th", "de", "vi", "es-la"]) {
      expect(normaliseMangadexLanguage(code)).toBe(code);
    }
  });

  it("canonicalises case and surrounding whitespace", () => {
    expect(normaliseMangadexLanguage(" PT-BR ")).toBe("pt-br");
  });

  it("refuses codes MangaDex would not accept", () => {
    // `pt_br` is the typo that matters: it silently stops protecting every
    // Brazilian-Portuguese chapter from the removal pass.
    for (const code of ["pt_br", "klingon", "", "NULL", "e"]) {
      expect(normaliseMangadexLanguage(code)).toBeNull();
    }
    expect(normaliseMangadexLanguage(7)).toBeNull();
    expect(normaliseMangadexLanguage(undefined)).toBeNull();
  });
});
