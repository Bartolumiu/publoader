import { describe, expect, it, vi } from "vitest";

import {
  UploadTaskWorkers,
  dueForIndexCheck,
  type TaskWorkerDeps,
} from "../../src/core/md/taskWorkers.js";
import type { DiscordEmbedInput } from "../../src/core/md/webhook.js";
import type { MdChapter } from "../../src/core/md/types.js";

/**
 * A commit MangaDex accepts is not a chapter anyone can read: the id comes back
 * straight away and indexing happens after, and when it does not happen the
 * platform has nothing to say about it. The task is DONE, `uploaded_chapters`
 * has a row, and no retry is owed because the upload did work.
 *
 * uploader.py caught this with `check_all_chapters_uploaded`. The port dropped
 * it -- `notIndexedEmbed` came across with no caller -- so these cover the sweep
 * that puts it back.
 */

const MINUTE = 60_000;

const chapter = (id: string): MdChapter => ({ id }) as unknown as MdChapter;

const workersWith = (
  found: (ids: string[]) => MdChapter[],
): {
  workers: UploadTaskWorkers;
  sent: DiscordEmbedInput[][];
  asked: string[][];
  errors: unknown[];
} => {
  const sent: DiscordEmbedInput[][] = [];
  const asked: string[][] = [];
  const errors: unknown[] = [];
  const deps = {
    md: {
      chaptersByIds: async (ids: string[]) => {
        asked.push(ids);
        return found(ids);
      },
    },
    notifier: {
      enabled: true,
      send: async (embeds: DiscordEmbedInput[]) => {
        sent.push(embeds);
      },
    },
    log: {
      info: () => {},
      error: (payload: unknown) => {
        errors.push(payload);
      },
    },
  };
  return {
    workers: new UploadTaskWorkers(deps as unknown as TaskWorkerDeps),
    sent,
    asked,
    errors,
  };
};

/** Put an id in the map and make it old enough to be asked about. */
const noteAgo = (workers: UploadTaskWorkers, id: string, agoMs: number): void => {
  vi.setSystemTime(new Date(Date.now() - agoMs));
  workers.noteCommitted(id);
  vi.useRealTimers();
};

describe("dueForIndexCheck", () => {
  const now = 1_000 * MINUTE;

  it("leaves a fresh commit alone, because MangaDex has not had time yet", () => {
    const pending = new Map([["a", now - MINUTE]]);
    expect(dueForIndexCheck(pending, now, 10)).toEqual([]);
  });

  it("asks about a commit once the grace has passed", () => {
    const pending = new Map([["a", now - 6 * MINUTE]]);
    expect(dueForIndexCheck(pending, now, 10)).toEqual(["a"]);
  });

  it("takes the oldest first, so a backfill drains in the order it went up", () => {
    const pending = new Map([
      ["young", now - 6 * MINUTE],
      ["oldest", now - 60 * MINUTE],
      ["middle", now - 20 * MINUTE],
    ]);
    expect(dueForIndexCheck(pending, now, 2)).toEqual(["oldest", "middle"]);
  });

  it("caps a sweep, so a 28k backfill is not one tick of hundreds of requests", () => {
    const pending = new Map(
      Array.from({ length: 900 }, (_, i) => [`c${i}`, now - 10 * MINUTE] as const),
    );
    expect(dueForIndexCheck(pending, now, 500)).toHaveLength(500);
  });
});

describe("sweepNotIndexed", () => {
  it("says nothing when there is nothing committed", async () => {
    const { workers, sent, asked } = workersWith((ids) => ids.map(chapter));
    await workers.sweepNotIndexed();
    expect(asked).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("does not ask MangaDex about a chapter that only just went up", async () => {
    const { workers, asked } = workersWith((ids) => ids.map(chapter));
    workers.noteCommitted("fresh");
    await workers.sweepNotIndexed();
    expect(asked).toEqual([]);
  });

  it("stays quiet when every chapter indexed, unlike the Python it replaces", async () => {
    // check_all_chapters_uploaded posted "N chapters indexed" on every drain.
    // The equivalent per-queue "finished" embed was removed from this platform
    // as spam; the count goes to the log instead.
    const { workers, sent, asked } = workersWith((ids) => ids.map(chapter));
    noteAgo(workers, "a", 10 * MINUTE);
    noteAgo(workers, "b", 10 * MINUTE);
    await workers.sweepNotIndexed();
    expect(asked).toEqual([["a", "b"]]);
    expect(sent).toEqual([]);
  });

  it("reports the chapters MangaDex accepted and never indexed", async () => {
    const { workers, sent, errors } = workersWith((ids) =>
      ids.filter((id) => id !== "ghost").map(chapter),
    );
    noteAgo(workers, "ok", 10 * MINUTE);
    noteAgo(workers, "ghost", 10 * MINUTE);
    await workers.sweepNotIndexed();

    expect(sent.flat().map((embed) => embed.title)).toEqual(["1 chapters not indexed"]);
    expect(sent.flat()[0]?.description).toContain("https://mangadex.org/chapter/ghost");
    expect(sent.flat()[0]?.description).not.toContain("chapter/ok");
    // The log is the durable record; the webhook is not.
    expect(errors).toHaveLength(1);
  });

  it("reports a chapter once and then forgets it", async () => {
    const { workers, sent } = workersWith(() => []);
    noteAgo(workers, "ghost", 10 * MINUTE);
    await workers.sweepNotIndexed();
    await workers.sweepNotIndexed();
    expect(sent).toHaveLength(1);
  });

  it("keeps the ids when the read fails, rather than dropping them into silence", async () => {
    let attempt = 0;
    const { workers, sent } = workersWith((ids) => {
      attempt += 1;
      if (attempt === 1) throw new Error("MangaDex is down");
      return ids.filter((id) => id !== "ghost").map(chapter);
    });
    noteAgo(workers, "ghost", 10 * MINUTE);

    await expect(workers.sweepNotIndexed()).rejects.toThrow("MangaDex is down");
    // The housekeeping loop swallows that and comes back five seconds later.
    await workers.sweepNotIndexed();
    expect(sent.flat().map((embed) => embed.title)).toEqual(["1 chapters not indexed"]);
  });

  it("does not post when no webhook is configured, but still logs", async () => {
    const errors: unknown[] = [];
    const workers = new UploadTaskWorkers({
      md: { chaptersByIds: async () => [] },
      notifier: {
        enabled: false,
        send: async () => {
          throw new Error("must not send");
        },
      },
      log: { info: () => {}, error: (payload: unknown) => errors.push(payload) },
    } as unknown as TaskWorkerDeps);
    noteAgo(workers, "ghost", 10 * MINUTE);

    await workers.sweepNotIndexed();
    expect(errors).toHaveLength(1);
  });
});
