import { describe, expect, it } from "vitest";
import { mergeEnvelopes } from "../../src/core/processor/processor.js";
import { decideForManga, type DecideInput } from "../../src/core/processor/dedupe.js";
import type { ResultEnvelope } from "../../src/contracts/envelope.js";
import type { MdChapter } from "../../src/core/md/types.js";

/** The MangaDex account these fixtures pretend publoader uploads as. */
const BOT = "74d95af1-7492-4fca-bc44-10c9142703e8";

const envelope = (over: Partial<ResultEnvelope> = {}): ResultEnvelope =>
  ({
    envelopeVersion: 1,
    jobId: "00000000-0000-4000-8000-00000000000a",
    leaseId: "00000000-0000-4000-8000-00000000000b",
    segmentKey: null,
    extension: "alpha_manga",
    bundleSha256: "a".repeat(64),
    idempotencyKey: "k",
    status: "ok",
    error: null,
    updatedChapters: [],
    allChapters: [],
    untrackedManga: [],
    failedManga: [],
    trackedMangadexIds: [],
    mangadexGroupId: null,
    overrideOptions: {},
    extensionLanguages: [],
    stats: {},
    ...over,
  }) as ResultEnvelope;

describe("failedManga", () => {
  it("unions the failures reported by every segment", () => {
    const merged = mergeEnvelopes(
      [
        envelope({ segmentKey: "0/2", failedManga: ["709000346"] }),
        envelope({ segmentKey: "1/2", failedManga: ["800111", "709000346"] }),
      ],
      "alpha_manga",
    );
    expect([...merged.failedManga].sort()).toEqual(["709000346", "800111"]);
  });

  it("defaults to no failures so existing extensions are unaffected", () => {
    expect(mergeEnvelopes([envelope()], "alpha_manga").failedManga).toEqual([]);
  });

  it("keeps a complete catalogue complete when only some titles failed", () => {
    // A per-title failure is not a reason to throw away removal information for
    // every other title: that is the blunt behaviour this replaced.
    const merged = mergeEnvelopes([envelope({ failedManga: ["709000346"] })], "alpha_manga");
    expect(merged.allChapters).not.toBeNull();
  });
});

describe("removal safety for an unreadable title", () => {
  const mdChapter = (id: string, externalUrl: string): MdChapter =>
    ({
      id,
      attributes: {
        chapter: "1",
        volume: null,
        title: "t",
        translatedLanguage: "en",
        externalUrl,
        pages: 0,
        version: 1,
      },
      relationships: [
        { type: "manga", id: "md-manga" },
        { type: "scanlation_group", id: "group" },
        // Removal now requires proving we uploaded the chapter; without this
        // every case below would pass for the wrong reason.
        { type: "user", id: BOT },
      ],
    }) as unknown as MdChapter;

  const input = (allMangaChapters: DecideInput["allMangaChapters"]): DecideInput => ({
    mangadexMangaId: "md-manga",
    updatedChapters: [],
    allMangaChapters,
    chaptersOnMd: [
      mdChapter("c1", "https://example.com/1"),
      mdChapter("c2", "https://example.com/2"),
    ],
    postedMdUpdates: [],
    overrideOptions: {},
    languages: ["en"],
    groupId: "group",
    cleanDb: true,
    botUserId: BOT,
  });

  it("removes nothing when the title could not be read", () => {
    // This is the whole point of reporting failures rather than skipping the
    // title silently. An unreadable title contributes no entries, and an empty
    // catalogue for a title means "the publisher dropped everything" -- which
    // would unpublish its entire back catalogue because one request 404'd.
    expect(decideForManga(input(null)).toRemove).toEqual([]);
  });

  it("still removes chapters when the publisher genuinely lists none", () => {
    // The counterpart: an empty list from a title that WAS read is real
    // evidence, and must keep working.
    expect(decideForManga(input([])).toRemove).toHaveLength(2);
  });
});

describe("ownership gating", () => {
  const chapterBy = (id: string, uploader: string | null): MdChapter =>
    ({
      id,
      attributes: {
        chapter: "1",
        volume: null,
        title: "t",
        translatedLanguage: "en",
        externalUrl: "https://example.com/gone",
        pages: 0,
        version: 1,
      },
      relationships: [
        { type: "manga", id: "md-manga" },
        { type: "scanlation_group", id: "group" },
        ...(uploader === null ? [] : [{ type: "user", id: uploader }]),
      ],
    }) as unknown as MdChapter;

  const decide = (chaptersOnMd: MdChapter[], botUserId: string | null): DecideInput => ({
    mangadexMangaId: "md-manga",
    updatedChapters: [],
    // Empty catalogue: the publisher lists nothing, so everything below is
    // eligible for removal and only ownership decides.
    allMangaChapters: [],
    chaptersOnMd,
    postedMdUpdates: [],
    overrideOptions: {},
    languages: ["en"],
    groupId: "group",
    cleanDb: true,
    botUserId,
  });

  it("leaves a chapter uploaded by somebody else alone", () => {
    // The bug this guards: publoader queued chapters it had not uploaded for
    // deletion. Sharing a scanlation group is not authorship, and deleting
    // another person's chapter is not something a later run can undo.
    const theirs = chapterBy("theirs", "11111111-2222-3333-4444-555555555555");
    expect(decideForManga(decide([theirs], BOT)).toRemove).toEqual([]);
  });

  it("still removes our own chapter alongside theirs", () => {
    const ours = chapterBy("ours", BOT);
    const theirs = chapterBy("theirs", "11111111-2222-3333-4444-555555555555");
    expect(decideForManga(decide([ours, theirs], BOT)).toRemove.map((c) => c.id)).toEqual(["ours"]);
  });

  it("removes nothing when the uploader was not read", () => {
    // chaptersForManga asks for includes[]=user; if that ever stops arriving,
    // the safe answer is to do nothing rather than assume the chapter is ours.
    expect(decideForManga(decide([chapterBy("unknown", null)], BOT)).toRemove).toEqual([]);
  });

  it("removes nothing when no bot user id is configured", () => {
    expect(decideForManga(decide([chapterBy("ours", BOT)], null)).toRemove).toEqual([]);
  });
});
