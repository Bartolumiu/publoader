import { describe, expect, it } from "vitest";
import {
  decodeTaskCursor,
  encodeTaskCursor,
  reorderOffsetsMs,
  taskDedupeKey,
  uploadDedupeKey,
} from "../../src/core/store/uploadTasks.js";
import { manualTaskProblems } from "../../src/core/api/routes/queues.js";

/**
 * The rules an operator's queue edit is judged against, tested away from the
 * database because they are pure: which fields identify a task, what the
 * uploader needs in order to be able to run one at all, and how a position in
 * the queue is expressed.
 */

describe("taskDedupeKey", () => {
  it("derives an UPLOAD key exactly as the processor does", () => {
    const chapter = { chapterId: "src-9", chapterNumber: "4.5", chapterLanguage: "en" };
    expect(taskDedupeKey("UPLOAD", chapter)).toBe("src-9|4.5|en");
    // The one place both rules live, so drift between them is not possible.
    expect(taskDedupeKey("UPLOAD", chapter)).toBe(uploadDedupeKey(chapter));
  });

  it("keeps a partial UPLOAD key but refuses one with no identity at all", () => {
    // A chapter with no source id is normal — the number and language still
    // identify it — so the key is partial rather than rejected.
    expect(taskDedupeKey("UPLOAD", { chapterNumber: "1", chapterLanguage: "en" })).toBe("|1|en");
    // All three empty would occupy the single `||` slot for every such chapter,
    // which is the collision cli/migrate-from-mongo.ts also refuses.
    expect(taskDedupeKey("UPLOAD", {})).toBeNull();
    expect(taskDedupeKey("UPLOAD", { chapterId: null, chapterNumber: null, chapterLanguage: null })).toBeNull();
  });

  it("keys every other kind on the MangaDex chapter id", () => {
    for (const kind of ["EDIT", "DELETE", "UNAVAILABLE"] as const) {
      expect(taskDedupeKey(kind, { mdChapterId: "md-42" })).toBe("md-42");
      // Chapter-side identity is irrelevant here: these tasks act on a chapter
      // that already exists on MangaDex.
      expect(taskDedupeKey(kind, { chapterId: "src-9", chapterNumber: "1" })).toBeNull();
    }
  });
});

describe("task cursors", () => {
  const cursor = {
    notBefore: new Date("2026-07-30T10:00:00.000Z"),
    createdAt: new Date("2026-07-29T09:30:15.500Z"),
    id: "0f1e2d3c-4b5a-4968-8776-655443332211",
  };

  it("round-trips a queue position", () => {
    const decoded = decodeTaskCursor(encodeTaskCursor(cursor));
    expect(decoded).not.toBeNull();
    expect(decoded!.notBefore.toISOString()).toBe(cursor.notBefore.toISOString());
    expect(decoded!.createdAt.toISOString()).toBe(cursor.createdAt.toISOString());
    expect(decoded!.id).toBe(cursor.id);
  });

  it("survives being carried in a URL", () => {
    const encoded = encodeTaskCursor(cursor);
    // base64url, so no +/= to be mangled by a query string.
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeTaskCursor(decodeURIComponent(encodeURIComponent(encoded)))).not.toBeNull();
  });

  it("returns null for anything it did not issue, so the route can answer 400", () => {
    expect(decodeTaskCursor("not-a-cursor")).toBeNull();
    expect(decodeTaskCursor(Buffer.from("only|two").toString("base64url"))).toBeNull();
    expect(decodeTaskCursor(Buffer.from("a|b|c").toString("base64url"))).toBeNull();
    // A real-looking timestamp pair with a junk id is still rejected: the id
    // goes into a keyset comparison and must be a row identifier.
    expect(
      decodeTaskCursor(
        Buffer.from("2026-07-30T10:00:00.000Z|2026-07-30T10:00:00.000Z|../../etc").toString("base64url"),
      ),
    ).toBeNull();
  });
});

describe("reorderOffsetsMs", () => {
  it("puts a front-moved group strictly before the anchor, in the order given", () => {
    // Negative and increasing: relative to the earliest other pending row, so
    // every listed task is claimed before it, and among themselves in sequence.
    expect(reorderOffsetsMs("front", 3)).toEqual([-3, -2, -1]);
    const offsets = reorderOffsetsMs("front", 4);
    expect(offsets.every((value) => value < 0)).toBe(true);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
  });

  it("puts a back-moved group strictly after the anchor", () => {
    expect(reorderOffsetsMs("back", 3)).toEqual([1, 2, 3]);
  });

  it("starts a resequenced group at its own anchor", () => {
    // Offset 0 for the first: the group keeps the slot it already had and only
    // its internal order changes.
    expect(reorderOffsetsMs("sequence", 3)).toEqual([0, 1, 2]);
  });

  it("returns one offset per id, all distinct, for every mode", () => {
    for (const mode of ["front", "back", "sequence"] as const) {
      const offsets = reorderOffsetsMs(mode, 50);
      expect(offsets).toHaveLength(50);
      // Distinct instants: two rows sharing one `not_before` would be claimed in
      // an arbitrary order, which is the thing a reorder is meant to fix.
      expect(new Set(offsets).size).toBe(50);
    }
    expect(reorderOffsetsMs("front", 0)).toEqual([]);
  });
});

describe("manualTaskProblems", () => {
  const upload = {
    chapterId: "src-1",
    chapterNumber: "7",
    chapterLanguage: "en",
    mdMangaId: "9a1b1c1d-0000-4000-8000-000000000000",
    mdGroupId: "4f1de6a2-f0c5-4ac5-bce5-02c7dbb67deb",
  };

  it("accepts a payload the uploader could execute", () => {
    expect(manualTaskProblems("UPLOAD", upload)).toEqual([]);
    expect(manualTaskProblems("DELETE", { mdChapterId: "md-1" })).toEqual([]);
    expect(manualTaskProblems("UNAVAILABLE", { mdChapterId: "md-1" })).toEqual([]);
    expect(manualTaskProblems("EDIT", { mdChapterId: "md-1", payload: { title: "x" } })).toEqual([]);
  });

  it("names each field taskWorkers would throw on", () => {
    // Every message below stands in for a TaskError raised after the task was
    // claimed — for UPLOAD, after a MangaDex upload session was already open.
    expect(manualTaskProblems("UPLOAD", { ...upload, mdMangaId: null }).join()).toContain("mdMangaId");
    expect(manualTaskProblems("UPLOAD", { ...upload, mdGroupId: null }).join()).toContain("mdGroupId");
    expect(manualTaskProblems("UPLOAD", { ...upload, chapterLanguage: null }).join()).toContain(
      "chapterLanguage",
    );
    for (const kind of ["EDIT", "DELETE", "UNAVAILABLE"] as const) {
      expect(manualTaskProblems(kind, {}).join()).toContain("mdChapterId");
    }
  });

  it("requires a non-empty payload on an EDIT, because the edit body is the task", () => {
    const missing = manualTaskProblems("EDIT", { mdChapterId: "md-1" });
    expect(missing.join()).toContain("payload");
    // An empty object, an array and a string are all "no fields to change".
    expect(manualTaskProblems("EDIT", { mdChapterId: "md-1", payload: {} }).join()).toContain("payload");
    expect(manualTaskProblems("EDIT", { mdChapterId: "md-1", payload: [] }).join()).toContain("payload");
    expect(manualTaskProblems("EDIT", { mdChapterId: "md-1", payload: "title" }).join()).toContain("payload");
  });

  it("reports every problem at once rather than the first", () => {
    // An operator filling a form should not have to submit five times to find
    // out what else is wrong.
    const problems = manualTaskProblems("UPLOAD", {});
    expect(problems.length).toBeGreaterThanOrEqual(4);
    expect(problems.join()).toContain("dedupe key");
  });

  it("treats an empty string as absent, matching chapterFromJson", () => {
    // The queue payload reader coerces "" to null, so validation must agree —
    // otherwise a blank form field would pass here and fail on claim.
    expect(manualTaskProblems("DELETE", { mdChapterId: "" }).join()).toContain("mdChapterId");
    expect(manualTaskProblems("UPLOAD", { ...upload, mdGroupId: "" }).join()).toContain("mdGroupId");
  });
});
