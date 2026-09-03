import { describe, expect, it, vi } from "vitest";

import { UploadSessionLock } from "../../src/core/md/sessionLock.js";
import { UploadTaskWorkers, type TaskWorkerDeps } from "../../src/core/md/taskWorkers.js";
import type { Chapter } from "../../src/core/md/types.js";

/**
 * The account has one upload session. Running the UNAVAILABLE queue beside the
 * others is only safe because the stretch of each worker that holds a session
 * takes turns; without that, the `currentUploadSession` cleanup each worker
 * runs deletes the session the other one is uploading into.
 */
describe("UploadSessionLock", () => {
  /** A deferred, so a turn can be held open while the test inspects the lock. */
  const gate = () => {
    let open!: () => void;
    const waited = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { waited, open };
  };

  it("does not let a second worker in while the first holds the session", async () => {
    const lock = new UploadSessionLock();
    const first = gate();
    const order: string[] = [];

    const a = lock.run(async () => {
      order.push("a:in");
      await first.waited;
      order.push("a:out");
    });
    const b = lock.run(async () => {
      order.push("b:in");
    });

    // `b` has been asked for and has not started: that is the whole property.
    // Drained rather than ticked once: taking a turn costs a microtask or two
    // of its own, so a single tick would prove only that nothing had run yet.
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(["a:in"]);
    expect(lock.busy).toBe(true);
    expect(lock.queued).toBe(1);

    first.open();
    await Promise.all([a, b]);
    expect(order).toEqual(["a:in", "a:out", "b:in"]);
    expect(lock.busy).toBe(false);
  });

  it("serves waiters in the order they arrived, so neither queue starves", async () => {
    const lock = new UploadSessionLock();
    const first = gate();
    const order: number[] = [];

    const held = lock.run(async () => {
      await first.waited;
    });
    const rest = [1, 2, 3].map((n) => lock.run(async () => void order.push(n)));

    first.open();
    await Promise.all([held, ...rest]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("releases the session when a turn throws, and the next turn still runs", async () => {
    // A failed upload must not wedge the lock: the queue behind it would stop
    // for good, which is worse than the failure that caused it.
    const lock = new UploadSessionLock();

    await expect(
      lock.run(async () => {
        throw new Error("commit refused");
      }),
    ).rejects.toThrow("commit refused");

    await expect(lock.run(async () => "next")).resolves.toBe("next");
    expect(lock.busy).toBe(false);
  });

  it("gives each caller its own result rather than the previous turn's", async () => {
    const lock = new UploadSessionLock();
    const results = await Promise.all([lock.run(async () => "a"), lock.run(async () => "b")]);
    expect(results).toEqual(["a", "b"]);
  });
});

/**
 * Which failures reach Discord.
 *
 * A card that did not land is the one failure nobody can act on from a channel:
 * it is bulk work, and when it fails it fails in runs because the cause is on
 * MangaDex's side. On the night of 2026-09-03 that would have been 80 embeds
 * saying the same thing about 80 different uuids.
 */
describe("queue embeds", () => {
  const chapter = (): Chapter =>
    ({
      extensionName: "mangaplus",
      mdChapterId: "chapter-id",
      chapterNumber: "12",
      chapterLanguage: "en",
    }) as unknown as Chapter;

  const workersWithNotifier = () => {
    const send = vi.fn(async (_embeds: unknown[]) => undefined);
    const workers = new UploadTaskWorkers({
      notifier: { enabled: true, send },
    } as unknown as TaskWorkerDeps);
    const queue = (action: string, success: boolean, detail?: string) =>
      (
        workers as unknown as {
          queue: (a: string, c: Chapter, id: string | null, ok: boolean, d?: string) => void;
        }
      ).queue(action, chapter(), "chapter-id", success, detail);
    return { workers, send, queue };
  };

  it("does not post an embed when an unavailable edit fails", async () => {
    const { workers, send, queue } = workersWithNotifier();

    queue("Unavailable", false, "the card did not land on chapter chapter-id");
    await workers.flushNotifications();

    expect(send).not.toHaveBeenCalled();
  });

  it("still posts the failures an operator can do something about", async () => {
    const { workers, send, queue } = workersWithNotifier();

    queue("Upload", false, "MangaDex refused the commit");
    queue("Delete", false, "403");
    queue("Restore", false, "the card was not removed");
    await workers.flushNotifications();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toHaveLength(3);
  });

  it("keeps unavailable successes off the channel too, unless asked for", async () => {
    // Unchanged behaviour, restated: successes are off by default for every
    // action, so the suppression above is the only new silence.
    const { workers, send, queue } = workersWithNotifier();

    queue("Unavailable", true);
    await workers.flushNotifications();

    expect(send).not.toHaveBeenCalled();
  });
});
