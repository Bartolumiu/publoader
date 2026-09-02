import { describe, expect, it, vi, beforeEach } from "vitest";

// The confirmation sleeps five seconds between reads, eight times over. Mocking
// the timer rather than shortening the constant keeps the test honest about the
// production values: a change to CARD_CONFIRM_ATTEMPTS is still exercised here.
vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => undefined) }));

import { UploadTaskWorkers, type TaskWorkerDeps } from "../../src/core/md/taskWorkers.js";
import type { Logger } from "../../src/logging.js";

/**
 * Whether a card actually reached MangaDex, which is the one thing the
 * unavailable flow may not get wrong.
 *
 * Every case here is taken from the sweep of 2026-09-02, where 84 of the 100
 * newest carded chapters were archived as done while MangaDex held no page for
 * them. The cause was that `confirmCardLanded` accepted the commit's echo as
 * proof; the echo turned out to claim a page where none landed and claim none
 * where one did, in the same sweep, an hour apart.
 */
describe("confirmCardLanded", () => {
  const logger = (): Logger =>
    ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) as unknown as Logger;

  /** A worker whose only live dependency is the chapter read. */
  const workersReading = (pageCounts: (number | null)[]) => {
    const chapterById = vi.fn(async () => {
      const pages = pageCounts.shift() ?? null;
      return pages === null ? null : { attributes: { pages, version: 9 } };
    });
    const workers = new UploadTaskWorkers({ md: { chapterById } } as unknown as TaskWorkerDeps);
    return { workers, chapterById };
  };

  const confirm = (
    workers: UploadTaskWorkers,
    before: { pages: number; version: number },
    committed: { attributes?: { version?: number; pages?: number } } | null,
  ): Promise<void> =>
    (
      workers as unknown as {
        confirmCardLanded: (
          id: string,
          before: { pages: number; version: number },
          committed: { attributes?: { version?: number; pages?: number } } | null,
          log: Logger,
        ) => Promise<void>;
      }
    ).confirmCardLanded("chapter-id", before, committed, logger());

  beforeEach(() => vi.clearAllMocks());

  it("fails a first card the chapter never received, however the commit echoed it", async () => {
    // The 19:38 batch: `resultingPages: 1` from the commit, nothing on the
    // chapter. This returned success before, and archived the chapter.
    const { workers, chapterById } = workersReading([0, 0, 0, 0, 0, 0, 0, 0]);

    await expect(confirm(workers, { pages: 0, version: 4 }, { attributes: { pages: 1 } })).rejects.toThrow(
      /did not land/,
    );
    expect(chapterById).toHaveBeenCalledTimes(8);
  });

  it("says what the commit claimed, so a disagreement is visible in the error", async () => {
    const { workers } = workersReading([0, 0, 0, 0, 0, 0, 0, 0]);

    await expect(
      confirm(workers, { pages: 0, version: 4 }, { attributes: { pages: 1 } }),
    ).rejects.toThrow(/commit echoed pages 1/);
  });

  it("passes a first card that did land, even though the commit echoed no page", async () => {
    // The 21:14 batch: `resultingPages: 0` from the commit, and the page was
    // there once MangaDex caught up about fifteen seconds later.
    const { workers, chapterById } = workersReading([0, 0, 1]);

    await expect(
      confirm(workers, { pages: 0, version: 4 }, { attributes: { pages: 0 } }),
    ).resolves.toBeUndefined();
    expect(chapterById).toHaveBeenCalledTimes(3);
  });

  it("keeps reading past a stale read rather than failing a working card", async () => {
    // A read that lags its own write is the thing the retry budget exists for,
    // and the budget has to outlast the lag actually measured in production.
    const { workers, chapterById } = workersReading([0, 0, 0, 0, 0, 0, 1]);

    await expect(confirm(workers, { pages: 0, version: 4 }, null)).resolves.toBeUndefined();
    expect(chapterById).toHaveBeenCalledTimes(7);
  });

  it("treats a chapter that has gone unreadable as a card that did not land", async () => {
    const { workers } = workersReading([null, null, null, null, null, null, null, null]);

    await expect(confirm(workers, { pages: 0, version: 4 }, null)).rejects.toThrow(
      /pages 0 -> unknown/,
    );
  });

  it("returns a re-card immediately without spending a read on it", async () => {
    // Unchanged behaviour, and deliberate: a re-card that quietly fails leaves
    // the OLD card in place, not a live chapter looking dead, and reading here
    // is what made a 2,425 chapter sweep take days.
    const { workers, chapterById } = workersReading([]);

    await expect(
      confirm(workers, { pages: 1, version: 7 }, { attributes: { version: 7 } }),
    ).resolves.toBeUndefined();
    expect(chapterById).not.toHaveBeenCalled();
  });
});
