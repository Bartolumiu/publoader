import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { JobStore } from "../../src/core/store/jobs.js";
import { closeDb, dbReady, resetDb, testPrisma } from "./db.js";

/**
 * Killing a run in progress.
 *
 * The point of a kill, as opposed to cancelling one job, is that NOTHING the run
 * had outstanding may still land. Two properties carry that, and both are
 * enforced elsewhere in the system, so the tests here check that cancelRun
 * actually engages them:
 *
 *   - `cancel_requested` blocks a re-claim, so an abandoned job cannot be picked
 *     up again after the lease sweeper requeues it;
 *   - the run goes to CANCELLED directly, so `advanceRuns`: which only moves
 *     PENDING/EXECUTING runs; can never carry it into processing.
 */
describe.skipIf(!dbReady())("cancelling a run", () => {
  const prisma = testPrisma();
  const store = new JobStore(prisma, { baseSeconds: 1, maxSeconds: 4 });

  async function worker(name: string): Promise<string> {
    const row = await prisma.worker.create({
      data: { name, tokenHash: `hash-${name}`, status: "ACTIVE", trust: "TRUSTED", lastHeartbeatAt: new Date() },
    });
    return row.id;
  }

  async function runWith(segments: number, key = "cancel-run"): Promise<string> {
    const { run } = await store.createRun({
      idempotencyKey: key,
      extension: "mangaplus",
      extensionVersion: "1.0.0",
      bundleSha256: "a".repeat(64),
      kind: "UPDATE",
      segments: Array.from({ length: segments }, (_, i) => ({
        index: i,
        total: segments,
        key: `seg-${i}`,
        mangaIds: [],
      })),
    });
    return run.id;
  }

  const claim = (id: string) => store.claim(id, { trust: "TRUSTED", leaseTtlSeconds: 300 });

  beforeEach(async () => {
    await resetDb(prisma);
  });
  afterAll(async () => {
    await closeDb();
  });

  it("cancels queued jobs and the run in one action", async () => {
    const runId = await runWith(3);
    const outcome = await store.cancelRun(runId);

    expect(outcome).toMatchObject({ result: "cancelled", jobsCancelled: 3, previousState: "PENDING" });
    expect(await prisma.job.count({ where: { runId, state: "CANCELLED" } })).toBe(3);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: runId } })).state).toBe("CANCELLED");
  });

  it("kills a job a worker is already executing", async () => {
    const a = await worker("a");
    const runId = await runWith(2);
    const leased = await claim(a);
    expect(leased).not.toBeNull();

    await store.cancelRun(runId);

    const job = await prisma.job.findUniqueOrThrow({ where: { id: leased!.job.id } });
    expect(job.state).toBe("CANCELLED");
    // The flag is what the worker sees on its next renewal, and what stops the
    // job being handed out again.
    expect(job.cancelRequested).toBe(true);
  });

  it("leaves nothing claimable afterwards", async () => {
    // The failure this guards against: a killed run whose jobs come back through
    // the lease sweeper and get executed by somebody else minutes later.
    const a = await worker("a");
    const b = await worker("b");
    const runId = await runWith(3);
    await claim(a);
    await store.cancelRun(runId);

    // Simulate the sweeper putting an abandoned job back on the queue.
    await prisma.job.updateMany({ where: { runId }, data: { state: "PENDING" } });
    expect(await claim(b)).toBeNull();
  });

  it("does not let advanceRuns carry a cancelled run into processing", async () => {
    const runId = await runWith(2);
    await store.cancelRun(runId);
    await store.advanceRuns();
    // Not INGESTING, and not DEAD_LETTER either; this was a decision, not a
    // failure, and the state an operator reads should say so.
    expect((await prisma.run.findUniqueOrThrow({ where: { id: runId } })).state).toBe("CANCELLED");
  });

  it("refuses a run that has already finished", async () => {
    const runId = await runWith(1);
    await prisma.run.update({ where: { id: runId }, data: { state: "PROCESSED" } });
    const outcome = await store.cancelRun(runId);
    // Cancelling completed work would be a lie about what happened.
    expect(outcome).toMatchObject({ result: "rejected", previousState: "PROCESSED" });
  });

  it("reports an unknown run rather than pretending to cancel it", async () => {
    expect(await store.cancelRun("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("cancel-all stops every unfinished run, and only those", async () => {
    const first = await runWith(2, "run-a");
    const second = await runWith(2, "run-b");
    await prisma.run.update({ where: { id: second }, data: { state: "PROCESSED" } });
    const third = await runWith(1, "run-c");

    const stopped = await store.cancelActiveRuns();
    expect(stopped.runs).toBe(2);
    expect(stopped.jobs).toBe(3);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: first } })).state).toBe("CANCELLED");
    expect((await prisma.run.findUniqueOrThrow({ where: { id: third } })).state).toBe("CANCELLED");
    // The finished one is untouched.
    expect((await prisma.run.findUniqueOrThrow({ where: { id: second } })).state).toBe("PROCESSED");
  });

  it("cancel-all can be scoped to one extension", async () => {
    const mine = await runWith(1, "run-mine");
    const { run: other } = await store.createRun({
      idempotencyKey: "run-other",
      extension: "alpha_manga",
      extensionVersion: "1.0.0",
      bundleSha256: "b".repeat(64),
      kind: "UPDATE",
      segments: [],
    });

    const stopped = await store.cancelActiveRuns("mangaplus");
    expect(stopped.runs).toBe(1);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: mine } })).state).toBe("CANCELLED");
    expect((await prisma.run.findUniqueOrThrow({ where: { id: other.id } })).state).not.toBe("CANCELLED");
  });
});
