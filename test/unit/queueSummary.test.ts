import { describe, expect, it } from "vitest";
import { UploadTaskWorkers, type TaskWorkerDeps } from "../../src/core/md/taskWorkers.js";
import type { DiscordEmbedInput } from "../../src/core/md/webhook.js";

/**
 * What the queue workers say at the end of a drain, which is now: nothing,
 * unless the queue is UNAVAILABLE.
 *
 * Every kind used to announce "Finished all items in queue". The message said
 * nothing an operator could act on — the work itself is already reported per
 * chapter — and it arrived once per kind, so a drain touching UPLOAD, EDIT and
 * DELETE posted three of them. UNAVAILABLE is the exception: it sends no
 * per-chapter embeds, so its summary is the only report of what it did.
 *
 * The accumulation is still here and still matters. A drain is not one pass:
 * while a run is processing, tasks arrive in a trickle, so the uploader wakes,
 * handles one, and sleeps. Totals accumulate and are reported once nothing is
 * left to claim, so a multi-pass drain yields one summary, not one per pass.
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

  it("says nothing when a queue finishes its work", async () => {
    const { workers, sent } = workersWith();
    await workers.flushQueueSummary(new Map([["DELETE", { processed: 3, failed: 0 }]]), drained);
    expect(sent).toEqual([]);
  });

  it("says nothing for a partially failed drain either", async () => {
    const { workers, sent } = workersWith();
    await workers.flushQueueSummary(new Map([["UPLOAD", { processed: 1, failed: 1 }]]), drained);
    expect(sent).toEqual([]);
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
      new Map([["UNAVAILABLE", { processed: 1, failed: 0 }]]),
      new Map([["UNAVAILABLE", 3]]),
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
    expect(titles(sent)).toEqual(["3 chapters marked unavailable"]);
    expect(sent.flat()[0]?.description).toContain("Failed: 1");
  });

  it("does not re-announce a queue that is already settled", async () => {
    const { workers, sent } = workersWith();
    await workers.flushQueueSummary(
      new Map([["UNAVAILABLE", { processed: 2, failed: 0 }]]),
      drained,
    );
    expect(titles(sent)).toEqual(["2 chapters marked unavailable"]);

    // A later idle pass has nothing to add, and must not repeat itself.
    await workers.flushQueueSummary(new Map(), drained);
    expect(titles(sent)).toEqual(["2 chapters marked unavailable"]);
  });
});
