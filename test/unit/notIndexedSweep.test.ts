import { describe, expect, it } from "vitest";

import {
  UploadTaskWorkers,
  notIndexedTitle,
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

/** One unstamped COMMITTED row, committed `agoMs` ago. */
type Row = { id: string; mdChapterId: string | null; createdAt: Date };
const row = (mdChapterId: string | null, agoMs: number): Row => ({
  id: `log-${mdChapterId}-${agoMs}`,
  mdChapterId,
  createdAt: new Date(Date.now() - agoMs),
});

const workersWith = (
  rows: Row[],
  found: (ids: string[]) => MdChapter[],
  notifierEnabled = true,
): {
  workers: UploadTaskWorkers;
  sent: DiscordEmbedInput[][];
  asked: string[][];
  stamped: string[][];
  errors: unknown[];
} => {
  const sent: DiscordEmbedInput[][] = [];
  const asked: string[][] = [];
  const stamped: string[][] = [];
  const errors: unknown[] = [];

  const deps = {
    prisma: {
      uploadLog: {
        // The real filtering is the query's; this stands in for the parts the
        // sweep actually depends on -- the grace window and the cap.
        findMany: async (args: {
          where: { createdAt: { lte: Date } };
          take: number;
        }): Promise<Row[]> =>
          rows.filter((r) => r.createdAt <= args.where.createdAt.lte).slice(0, args.take),
        updateMany: async (args: { where: { id: { in: string[] } } }) => {
          stamped.push(args.where.id.in);
          return { count: args.where.id.in.length };
        },
      },
    },
    md: {
      chaptersByIds: async (ids: string[]) => {
        asked.push(ids);
        return found(ids);
      },
    },
    notifier: {
      enabled: notifierEnabled,
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
    stamped,
    errors,
  };
};

describe("notIndexedTitle", () => {
  it("counts one chapter as one chapter", () => {
    expect(notIndexedTitle(["a"])).toBe("1 chapter not indexed");
  });

  it("names the true count, not the number the embed had room for", () => {
    // Discord clips a description at 4096 characters and says nothing about it,
    // so a title taken from the listed ids would turn a 500-chapter outage into
    // a 30-chapter one.
    const missing = Array.from({ length: 500 }, (_, i) => `c${i}`);
    expect(notIndexedTitle(missing, 30)).toContain("500 chapters not indexed");
    expect(notIndexedTitle(missing, 30)).toContain("first 30 listed");
  });

  it("does not apologise for truncation it did not do", () => {
    expect(notIndexedTitle(["a", "b"], 30)).toBe("2 chapters not indexed");
  });
});

describe("sweepNotIndexed", () => {
  it("says nothing when nothing is waiting to be checked", async () => {
    const { workers, sent, asked } = workersWith([], (ids) => ids.map(chapter));
    await workers.sweepNotIndexed();
    expect(asked).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("does not ask MangaDex about a chapter that only just went up", async () => {
    const { workers, asked } = workersWith([row("fresh", MINUTE)], (ids) => ids.map(chapter));
    await workers.sweepNotIndexed();
    expect(asked).toEqual([]);
  });

  it("stays quiet when every chapter indexed, unlike the Python it replaces", async () => {
    // check_all_chapters_uploaded posted "N chapters indexed" on every drain.
    // The equivalent per-queue "finished" embed was removed from this platform
    // as spam; the count goes to the log instead.
    const { workers, sent, asked } = workersWith(
      [row("a", 10 * MINUTE), row("b", 10 * MINUTE)],
      (ids) => ids.map(chapter),
    );
    await workers.sweepNotIndexed();
    expect(asked).toEqual([["a", "b"]]);
    expect(sent).toEqual([]);
  });

  it("names the chapters MangaDex accepted and never indexed", async () => {
    const { workers, sent, errors } = workersWith(
      [row("ok", 10 * MINUTE), row("ghost", 10 * MINUTE)],
      (ids) => ids.filter((id) => id !== "ghost").map(chapter),
    );
    await workers.sweepNotIndexed();

    expect(sent.flat().map((embed) => embed.title)).toEqual(["1 chapter not indexed"]);
    expect(sent.flat()[0]?.description).toContain("https://mangadex.org/chapter/ghost");
    expect(sent.flat()[0]?.description).not.toContain("chapter/ok");
    // The log is the durable record; the webhook is not.
    expect(errors).toHaveLength(1);
  });

  it("stamps what it checked, so a chapter is reported once", async () => {
    const { workers, stamped } = workersWith(
      [row("ok", 10 * MINUTE), row("ghost", 10 * MINUTE)],
      () => [],
    );
    await workers.sweepNotIndexed();
    // Both rows, not just the missing one: a chapter that indexed is settled too.
    expect(stamped).toEqual([["log-ok-600000", "log-ghost-600000"]]);
  });

  it("asks once for a chapter with two commit rows, and stamps both", async () => {
    // A retry whose prior commit had vanished uploads again and writes a second
    // COMMITTED row against the same chapter id.
    const rows = [row("twice", 20 * MINUTE), { ...row("twice", 10 * MINUTE), id: "log-retry" }];
    const { workers, asked, stamped } = workersWith(rows, (ids) => ids.map(chapter));
    await workers.sweepNotIndexed();
    expect(asked).toEqual([["twice"]]);
    expect(stamped).toEqual([["log-twice-1200000", "log-retry"]]);
  });

  it("keeps the rows unstamped when the read fails, rather than dropping them", async () => {
    const { workers, stamped } = workersWith([row("ghost", 10 * MINUTE)], () => {
      throw new Error("MangaDex is down");
    });
    await expect(workers.sweepNotIndexed()).rejects.toThrow("MangaDex is down");
    // Nothing was settled, so the next tick asks again.
    expect(stamped).toEqual([]);
  });

  it("truncates the list but never the count", async () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(`c${i}`, 10 * MINUTE));
    const { workers, sent } = workersWith(rows, () => []);
    await workers.sweepNotIndexed();

    const embed = sent.flat()[0];
    expect(embed?.title).toContain("40 chapters not indexed");
    expect(embed?.title).toContain("first 30 listed");
    expect(embed?.description?.split("\n").filter(Boolean)).toHaveLength(30);
  });

  it("does not post when no webhook is configured, but still logs", async () => {
    const { workers, sent, errors } = workersWith([row("ghost", 10 * MINUTE)], () => [], false);
    await workers.sweepNotIndexed();
    expect(sent).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});
