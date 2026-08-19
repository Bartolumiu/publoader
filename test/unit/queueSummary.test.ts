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

  it("announces a queue as finished once it has actually completed work", async () => {
    const { workers, sent } = workersWith();
    await workers.flushQueueSummary(new Map([["DELETE", { processed: 3, failed: 0 }]]));
    expect(titles(sent)).toEqual(["Delete: Finished all items in queue"]);
  });

  it("says nothing about finishing when every task failed and was requeued", async () => {
    const { workers, sent } = workersWith();
    await workers.flushQueueSummary(new Map([["DELETE", { processed: 0, failed: 2 }]]));
    expect(sent).toEqual([]);
  });

  it("still announces a partially failed drain, which did empty some of the queue", async () => {
    const { workers, sent } = workersWith();
    await workers.flushQueueSummary(new Map([["UPLOAD", { processed: 1, failed: 1 }]]));
    expect(titles(sent)).toEqual(["Upload: Finished all items in queue"]);
  });

  it("keeps the unavailable summary, which is where a failure count is reported", async () => {
    const { workers, sent } = workersWith();
    await workers.flushQueueSummary(new Map([["UNAVAILABLE", { processed: 0, failed: 4 }]]));
    expect(titles(sent)).toEqual(["0 chapters marked unavailable"]);
    expect(sent.flat()[0]?.description).toContain("Failed: 4");
  });

  it("sends nothing at all for a queue that did nothing", async () => {
    const { workers, sent } = workersWith();
    await workers.flushQueueSummary(new Map([["EDIT", { processed: 0, failed: 0 }]]));
    expect(sent).toEqual([]);
  });
});
