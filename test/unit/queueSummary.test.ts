import { describe, expect, it } from "vitest";
import { UploadTaskWorkers, type TaskWorkerDeps } from "../../src/core/md/taskWorkers.js";
import type { DiscordEmbedInput } from "../../src/core/md/webhook.js";

/**
 * What the queue workers say at the end of a drain.
 *
 * "Finished all items in queue" was sent whenever a pass touched anything, and
 * a task that FAILS is touched: it goes back to the queue with a backoff and is
 * claimed again on the next pass, forever, if the failure is permanent. So a
 * single stuck task produced that message every few minutes, indefinitely, in a
 * channel where it is indistinguishable from real completions. Announcing a
 * queue as finished when nothing left it is also simply untrue.
 *
 * The same untruth had a second source: a drain is not one pass. While a run is
 * processing, tasks arrive in a trickle, so the uploader wakes, handles one, and
 * sleeps. Reporting per pass turned a single clean run into a message a minute,
 * every one of them announcing a queue that plainly was not finished. So the
 * totals now accumulate and are only reported once nothing is left to claim.
 */
describe("flushQueueSummary", () => {
  const workersWith = (): { workers: UploadTaskWorkers; sent: DiscordEmbedInput[][] } => {
    const sent: DiscordEmbedInput[][] = [];
    const notifier = {
      enabled: true,
      send: async (embeds: DiscordEmbedInput[]) => {
        sent.push(embeds);
      },
    };
    const workers = new UploadTaskWorkers({ notifier } as unknown as TaskWorkerDeps);
    return { workers, sent };
  };

  const titles = (sent: DiscordEmbedInput[][]): string[] =>
    sent.flat().map((embed) => embed.title ?? "");

  /** Nothing left to claim: the queue really is finished. */
  const drained = new Map<string, number>();

  it("announces a queue as finished once it has actually completed work", async () => {
    const { workers, sent } = workersWith();
    await workers.flushQueueSummary(new Map([["DELETE", { processed: 3, failed: 0 }]]), drained);
    expect(titles(sent)).toEqual(["Delete: Finished all items in queue"]);
  });

  it("says nothing about finishing when every task failed and was requeued", async () => {
    const { workers, sent } = workersWith();
    await workers.flushQueueSummary(new Map([["DELETE", { processed: 0, failed: 2 }]]), drained);
    expect(sent).toEqual([]);
  });

  it("still announces a partially failed drain, which did empty some of the queue", async () => {
    const { workers, sent } = workersWith();
    await workers.flushQueueSummary(new Map([["UPLOAD", { processed: 1, failed: 1 }]]), drained);
    expect(titles(sent)).toEqual(["Upload: Finished all items in queue"]);
  });

  it("keeps the unavailable summary, which is where a failure count is reported", async () => {
    const { workers, sent } = workersWith();
    await workers.flushQueueSummary(
      new Map([["UNAVAILABLE", { processed: 0, failed: 4 }]]),
      drained,
    );
    expect(titles(sent)).toEqual(["0 chapters marked unavailable"]);
    expect(sent.flat()[0]?.description).toContain("Failed: 4");
  });

  it("sends nothing at all for a queue that did nothing", async () => {
    const { workers, sent } = workersWith();
    await workers.flushQueueSummary(new Map([["EDIT", { processed: 0, failed: 0 }]]), drained);
    expect(sent).toEqual([]);
  });

  it("stays quiet while work is still queued", async () => {
    const { workers, sent } = workersWith();
    // One task handled, three still waiting: this drain is not over, and the
    // uploader will be back in a few seconds for the next one.
    await workers.flushQueueSummary(
      new Map([["UPLOAD", { processed: 1, failed: 0 }]]),
      new Map([["UPLOAD", 3]]),
    );
    expect(sent).toEqual([]);
  });

  it("reports one total for a drain that took several passes", async () => {
    const { workers, sent } = workersWith();
    await workers.flushQueueSummary(
      new Map([["UNAVAILABLE", { processed: 1, failed: 0 }]]),
      new Map([["UNAVAILABLE", 2]]),
    );
    await workers.flushQueueSummary(
      new Map([["UNAVAILABLE", { processed: 1, failed: 1 }]]),
      new Map([["UNAVAILABLE", 1]]),
    );
    expect(sent).toEqual([]);

    // The pass that empties it reports everything since the queue was last
    // clear, not just its own share.
    await workers.flushQueueSummary(
      new Map([["UNAVAILABLE", { processed: 1, failed: 0 }]]),
      drained,
    );
    expect(titles(sent)).toEqual([
      "3 chapters marked unavailable",
      "Unavailable: Finished all items in queue",
    ]);
    expect(sent.flat()[0]?.description).toContain("Failed: 1");
  });

  it("does not re-announce a queue that is already settled", async () => {
    const { workers, sent } = workersWith();
    await workers.flushQueueSummary(new Map([["EDIT", { processed: 2, failed: 0 }]]), drained);
    expect(titles(sent)).toEqual(["Edit: Finished all items in queue"]);

    // A later idle pass has nothing to add, and must not repeat itself.
    await workers.flushQueueSummary(new Map(), drained);
    expect(titles(sent)).toEqual(["Edit: Finished all items in queue"]);
  });
});
