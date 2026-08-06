import { describe, expect, it } from "vitest";
import {
  UnsupportedMangaIdMapError,
  invertMangaIdMap,
} from "../../src/extsdk/context.js";

/**
 * The tracked map arrives from the control plane in one of two shapes, and a
 * runtime that understands only the first must REFUSE the second rather than
 * misread it.
 *
 * Why refusing matters more than it looks: inverting a namespaced map with
 * flat-only code yields an empty lookup, and an empty lookup is
 * indistinguishable from "this extension tracks nothing". The extension would
 * then report its entire catalogue as untracked, and an extension with
 * `auto_create_titles` enabled turns that into a request to create a duplicate
 * MangaDex title for every series it publishes; public, and someone else's
 * cleanup. A failed job that retries is strictly the better outcome.
 */
describe("invertMangaIdMap", () => {
  const flat = {
    "333f4d22-7753-4e3b-b0da-0a69b2cdce4f": ["100001", "200008"],
    "fa3e0b2f-4e1f-48ee-9af0-1de9dc28ca51": ["100002"],
  };

  it("inverts the flat shape, mapping many external ids onto one title", () => {
    const map = invertMangaIdMap(flat);
    // The many-to-one direction mangaplus relies on: one id per language edition.
    expect(map.get("100001")).toBe("333f4d22-7753-4e3b-b0da-0a69b2cdce4f");
    expect(map.get("200008")).toBe("333f4d22-7753-4e3b-b0da-0a69b2cdce4f");
    expect(map.get("100002")).toBe("fa3e0b2f-4e1f-48ee-9af0-1de9dc28ca51");
    expect(map.size).toBe(3);
  });

  it("coerces numeric ids, which the legacy files contain", () => {
    const map = invertMangaIdMap({ "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa": [709 as never] });
    expect(map.get("709")).toBe("aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa");
  });

  it("refuses a namespaced map when the control plane flags it", () => {
    expect(() => invertMangaIdMap(flat, { namespaced: true })).toThrow(
      UnsupportedMangaIdMapError,
    );
  });

  it("refuses a nested map even when the flag is missing", () => {
    // Flag and payload disagreeing is still a disagreement this code cannot
    // resolve safely, so it must not fall through to an empty lookup.
    const namespaced = {
      vizmanga: { "9a0f1e7e-d84b-46e6-8596-ae5a60529e81": ["709"] },
      shonenjump: {},
    };
    expect(() => invertMangaIdMap(namespaced)).toThrow(UnsupportedMangaIdMapError);
  });

  it("never returns an empty map for a non-empty namespaced input", () => {
    // The specific regression being locked down: silence, not a wrong answer.
    const namespaced = { vizmanga: { "9a0f1e7e-d84b-46e6-8596-ae5a60529e81": ["709"] } };
    let threw = false;
    try {
      const result = invertMangaIdMap(namespaced);
      expect(result.size, "returned an empty map instead of refusing").toBeGreaterThan(0);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("treats a genuinely empty map as empty, not as an error", () => {
    // A brand-new extension legitimately tracks nothing yet.
    expect(invertMangaIdMap({}).size).toBe(0);
    expect(invertMangaIdMap({}, { namespaced: false }).size).toBe(0);
  });
});
