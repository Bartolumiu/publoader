import { describe, expect, it } from "vitest";
import { mdVolume } from "../../src/core/md/client.js";

/**
 * The volumes MangaDex refuses, and the commit they were failing.
 *
 * Every value here came out of omoi's queue on 2026-09-09, where the commit
 * answered:
 *
 *   400 Error validating /chapterDraft/volume: Does not match the regex
 *       pattern ^(0|[1-9]\d*)((\.\d+){1,2})?[a-z]?$
 *
 * and the task retried into the same rejection until it dead-lettered.
 */
describe("mdVolume", () => {
  it("keeps the volumes MangaDex accepts", () => {
    for (const ok of ["0", "1", "2", "7", "23", "1.5", "10.25", "1.2.3", "4a"]) {
      expect(mdVolume(ok)).toBe(ok);
    }
  });

  it("drops a printed volume NAME to null", () => {
    // omoi reports the volume as it is printed on the book.
    expect(mdVolume("Kiss Me At the Stroke of Midnight 1")).toBeNull();
    expect(mdVolume("Don't Toy With Me, Miss Nagatoro 1")).toBeNull();
    expect(mdVolume("My Pink is Overflowing 1")).toBeNull();
    expect(mdVolume("1 (Omnibus)")).toBeNull();
    expect(mdVolume("23:45")).toBeNull();
  });

  it("passes null through rather than inventing a volume", () => {
    expect(mdVolume(null)).toBeNull();
    expect(mdVolume(undefined)).toBeNull();
    expect(mdVolume("")).toBeNull();
  });

  it("trims, so whitespace alone does not lose a good volume", () => {
    expect(mdVolume("  3  ")).toBe("3");
  });

  it("does not accept a leading zero or a bare dot, which the pattern forbids", () => {
    expect(mdVolume("01")).toBeNull();
    expect(mdVolume(".5")).toBeNull();
    expect(mdVolume("1.")).toBeNull();
  });
});
