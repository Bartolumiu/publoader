import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  UploadTaskWorkers,
  cardLanded,
  readVerifyState,
  type TaskWorkerDeps,
} from "../../src/core/md/taskWorkers.js";
import type { Logger } from "../../src/logging.js";
import type { UploadTask } from "@prisma/client";

/**
 * Whether a card actually reached MangaDex, which is the one thing the
 * unavailable flow may not get wrong.
 *
 * Every case here is taken from production. The verdict cases come from the
 * sweep of 2026-09-02, where 84 of the 100 newest carded chapters were archived
 * as done while MangaDex held no page for them, because the commit's echo was
 * accepted as proof. The waiting cases come from the night of 2026-09-03, when
 * 80 chapters failed in a row against an in-line confirmation that gave up
 * after forty seconds with the whole queue stopped behind it.
 */
describe("cardLanded", () => {
  it("passes a first card the chapter actually received", () => {
    expect(cardLanded({ pages: 0, version: 4 }, { pages: 1, version: 5 })).toBe(true);
  });

  it("fails a first card the chapter never received, however the commit echoed it", () => {
    // The commit echo is not an input at all: on 2026-09-03 eighty consecutive
    // commits echoed `resultingPages: 1` over chapters still page-less hours
    // later, and believing any of them would have archived all eighty.
    expect(cardLanded({ pages: 0, version: 4 }, { pages: 0, version: 5 })).toBe(false);
  });

  it("confirms a re-card from the version, since the page count cannot move", () => {
    expect(cardLanded({ pages: 1, version: 7 }, { pages: 1, version: 8 })).toBe(true);
  });

  it("fails a re-card whose version never moves, which is a commit that did nothing", () => {
    expect(cardLanded({ pages: 1, version: 7 }, { pages: 1, version: 7 })).toBe(false);
  });

  it("treats an unreadable chapter as a card that did not land", () => {
    expect(cardLanded({ pages: 0, version: 4 }, { pages: null, version: null })).toBe(false);
    expect(cardLanded({ pages: 1, version: 7 }, { pages: null, version: null })).toBe(false);
  });
});

describe("readVerifyState", () => {
  it("reads a marker this code wrote", () => {
    expect(
      readVerifyState({ cardVerify: { round: 2, pagesBefore: 0, versionBefore: 4, committedPages: 1 } }),
    ).toEqual({ round: 2, pagesBefore: 0, versionBefore: 4, committedPages: 1 });
  });

  it("has no marker for an ordinary task, which is what makes it write a card", () => {
    expect(readVerifyState({ force: true })).toBeNull();
  });

  it("rejects a half-shaped marker rather than deferring on nonsense", () => {
    // The payload is JSONB written by an older build of this same code, so a
    // marker missing its numbers is reachable. Falling through to writing a
    // fresh card is the recoverable direction; deferring forever is not.
    expect(readVerifyState({ cardVerify: { round: 1 } })).toBeNull();
    expect(readVerifyState({ cardVerify: "yes" })).toBeNull();
  });
});

/**
 * The deferred half: the task that already committed a card and came back to
 * find out whether it arrived.
 */
describe("verifyCard", () => {
  const logger = (): Logger =>
    ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) as unknown as Logger;

  const chapter = { mdChapterId: "chapter-id", extensionName: "mangaplus" };

  const workersReading = (after: { pages: number; version: number } | null) => {
    const chapterById = vi.fn(async () => (after === null ? null : { attributes: after }));
    const archiveUnavailable = vi.fn(async () => undefined);
    const archiveDeleted = vi.fn(async () => undefined);
    const update = vi.fn(async (_args: { where: { id: string }; data: { chapter: unknown } }) =>
      undefined,
    );
    const workers = new UploadTaskWorkers({
      md: { chapterById },
      notifier: { enabled: false },
      prisma: { uploadTask: { update } },
    } as unknown as TaskWorkerDeps);
    Object.assign(workers, { archiveUnavailable, archiveDeleted });
    return { workers, chapterById, archiveUnavailable, archiveDeleted, update };
  };

  const verify = (
    workers: UploadTaskWorkers,
    state: { round: number; pagesBefore: number; versionBefore: number; committedPages: number | null },
  ) =>
    (
      workers as unknown as {
        verifyCard: (
          task: UploadTask,
          chapter: unknown,
          raw: Record<string, unknown>,
          state: unknown,
          log: Logger,
        ) => Promise<{ defer: { seconds: number; chapter: Record<string, unknown> } } | null>;
      }
    ).verifyCard(
      { id: "task-id" } as UploadTask,
      chapter,
      { cardVerify: state, force: true },
      state,
      logger(),
    );

  beforeEach(() => vi.clearAllMocks());

  it("archives the chapter once the card is actually there", async () => {
    const { workers, archiveUnavailable } = workersReading({ pages: 1, version: 5 });

    const outcome = await verify(workers, {
      round: 1,
      pagesBefore: 0,
      versionBefore: 4,
      committedPages: 1,
    });

    expect(outcome).toBeNull();
    expect(archiveUnavailable).toHaveBeenCalledTimes(1);
  });

  it("does not archive a chapter the card has not reached, it comes back later", async () => {
    // The whole point: one read per claim, and the waiting happens on the queue
    // rather than in the drain. Nothing is recorded either way yet.
    const { workers, archiveUnavailable, chapterById } = workersReading({ pages: 0, version: 5 });

    const outcome = await verify(workers, {
      round: 1,
      pagesBefore: 0,
      versionBefore: 4,
      committedPages: 1,
    });

    expect(outcome?.defer.seconds).toBe(300);
    expect(readVerifyState(outcome?.defer.chapter ?? {})?.round).toBe(2);
    expect(chapterById).toHaveBeenCalledTimes(1);
    expect(archiveUnavailable).not.toHaveBeenCalled();
  });

  it("keeps the operator's sidecars on the payload it defers", async () => {
    const { workers } = workersReading({ pages: 0, version: 5 });

    const outcome = await verify(workers, {
      round: 1,
      pagesBefore: 0,
      versionBefore: 4,
      committedPages: 1,
    });

    expect(outcome?.defer.chapter["force"]).toBe(true);
  });

  it("fails the task once it has waited out every round", async () => {
    const { workers, update } = workersReading({ pages: 0, version: 5 });

    await expect(
      verify(workers, { round: 3, pagesBefore: 0, versionBefore: 4, committedPages: 1 }),
    ).rejects.toThrow(/did not land/);

    // The marker is taken off first, or the retry arrives back in here and
    // re-reads a chapter nobody has written to since, until the attempts run
    // out with no second card ever tried.
    expect(update).toHaveBeenCalledTimes(1);
    const written = update.mock.calls[0]?.[0].data.chapter as Record<string, unknown>;
    expect(readVerifyState(written)).toBeNull();
  });

  it("says what the commit claimed, so a disagreement is visible in the error", async () => {
    const { workers } = workersReading({ pages: 0, version: 5 });

    await expect(
      verify(workers, { round: 3, pagesBefore: 0, versionBefore: 4, committedPages: 1 }),
    ).rejects.toThrow(/commit echoed pages 1/);
  });

  it("records a chapter deleted under it as deleted, not as carded", async () => {
    const { workers, archiveDeleted, archiveUnavailable } = workersReading(null);

    const outcome = await verify(workers, {
      round: 1,
      pagesBefore: 0,
      versionBefore: 4,
      committedPages: 1,
    });

    expect(outcome).toBeNull();
    expect(archiveDeleted).toHaveBeenCalledTimes(1);
    expect(archiveUnavailable).not.toHaveBeenCalled();
  });
});
