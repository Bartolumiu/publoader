import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { JobStore } from "../../src/core/store/jobs.js";
import { ResultStore } from "../../src/core/store/results.js";
import { closeDb, dbReady, resetDb, testPrisma } from "./db.js";

/**
 * Lease-model correctness against REAL Postgres locking. These tests are the
 * evidence for: single-owner execution, expiry recovery without overlap,
 * late-result superseding, idempotent creation, and cancellation.
 */
describe.skipIf(!dbReady())("job lease store", () => {
  const prisma = testPrisma();
  const store = new JobStore(prisma, { baseSeconds: 1, maxSeconds: 4 });

  const createRun = (key = "run-key-1", segments?: Parameters<JobStore["createRun"]>[0]["segments"]) =>
    store.createRun({
      idempotencyKey: key,
      extension: "mangaplus",
      extensionVersion: "0.3.00",
      bundleSha256: "a".repeat(64),
      kind: "UPDATE",
      segments,
    });

  beforeEach(async () => {
    await resetDb(prisma);
  });
  afterAll(async () => {
    await closeDb();
  });

  it("creates runs idempotently: same key never duplicates jobs", async () => {
    const first = await createRun();
    const second = await createRun();
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);
    expect(await prisma.job.count()).toBe(1);
  });

  it("a single job can only be claimed by ONE of many concurrent claimers", async () => {
    await createRun();
    const claims = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.claim(`worker-${i}`, { trust: "TRUSTED", leaseTtlSeconds: 60 }),
      ),
    );
    const winners = claims.filter((c) => c !== null);
    expect(winners).toHaveLength(1);
    const job = await prisma.job.findFirstOrThrow();
    expect(job.state).toBe("LEASED");
    expect(job.leaseWorkerId).toBe(winners[0]!.job.leaseWorkerId);
  });

  it("renew and complete require the current lease id", async () => {
    await createRun();
    const claimed = await store.claim("w1", { trust: "TRUSTED", leaseTtlSeconds: 60 });
    expect(claimed).not.toBeNull();
    const { job, leaseId } = claimed!;

    expect(await store.renew(job.id, "00000000-0000-4000-8000-000000000000", 60)).toBeNull();
    expect(await store.complete(job.id, "00000000-0000-4000-8000-000000000000")).toBe(false);
    expect(await store.renew(job.id, leaseId, 60)).not.toBeNull();
    expect(await store.complete(job.id, leaseId)).toBe(true);
    // Completing again is a no-op (state no longer LEASED/RUNNING).
    expect(await store.complete(job.id, leaseId)).toBe(false);
  });

  it("expired leases are recovered by the sweeper without overlapping execution", async () => {
    await createRun();
    const claimed = await store.claim("w1", { trust: "TRUSTED", leaseTtlSeconds: 60 });
    const { job, leaseId } = claimed!;
    // Force-expire the lease (simulates worker crash / network loss).
    await prisma.job.update({
      where: { id: job.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });

    const swept = await store.sweepExpiredLeases();
    expect(swept.requeued).toHaveLength(1);

    // The crashed worker can no longer renew or complete its stale lease.
    expect(await store.renew(job.id, leaseId, 60)).toBeNull();
    expect(await store.complete(job.id, leaseId)).toBe(false);

    // A new worker claims attempt 2 after the backoff window.
    await prisma.job.update({ where: { id: job.id }, data: { notBefore: new Date() } });
    const reclaimed = await store.claim("w2", { trust: "TRUSTED", leaseTtlSeconds: 60 });
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.job.attempt).toBe(2);
  });

  it("exhausted attempts dead-letter instead of requeueing forever", async () => {
    await createRun();
    await prisma.job.updateMany({ data: { maxAttempts: 1 } });
    const claimed = await store.claim("w1", { trust: "TRUSTED", leaseTtlSeconds: 60 });
    await prisma.job.update({
      where: { id: claimed!.job.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    const swept = await store.sweepExpiredLeases();
    expect(swept.deadLettered).toHaveLength(1);
    expect(swept.requeued).toHaveLength(0);
    const job = await prisma.job.findFirstOrThrow();
    expect(job.state).toBe("DEAD_LETTER");
  });

  it("late results after lease reassignment are superseded, never double-committed", async () => {
    await createRun();
    const results = new ResultStore(prisma);
    const first = await store.claim("w1", { trust: "TRUSTED", leaseTtlSeconds: 60 });
    // Lease expires; job requeued; second worker claims and completes.
    await prisma.job.update({
      where: { id: first!.job.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    await store.sweepExpiredLeases();
    await prisma.job.update({ where: { id: first!.job.id }, data: { notBefore: new Date() } });
    const second = await store.claim("w2", { trust: "TRUSTED", leaseTtlSeconds: 60 });

    const mkEnvelope = (leaseId: string, attempt: number) =>
      ({
        idempotencyKey: `res:${first!.job.id}:${attempt}`,
        jobId: first!.job.id,
        leaseId,
        segmentKey: null,
      }) as never;

    // Second (current) worker commits.
    const subB = await results.record(mkEnvelope(second!.leaseId, 2), "w2", 2);
    expect(await results.commit(subB.submission.id, first!.job.id, second!.leaseId)).toBe(true);

    // First (stale) worker's late submission cannot commit.
    const subA = await results.record(mkEnvelope(first!.leaseId, 1), "w1", 1);
    expect(await results.commit(subA.submission.id, first!.job.id, first!.leaseId)).toBe(false);

    const committed = await prisma.resultSubmission.findMany({ where: { state: "COMMITTED" } });
    expect(committed).toHaveLength(1);
    expect(committed[0]!.workerId).toBe("w2");
  });

  it("the partial unique index admits exactly one COMMITTED row per job", async () => {
    await createRun();
    const claimed = await store.claim("w1", { trust: "TRUSTED", leaseTtlSeconds: 60 });
    const jobId = claimed!.job.id;
    await prisma.resultSubmission.create({
      data: { idempotencyKey: "k1", jobId, attempt: 1, leaseId: claimed!.leaseId, workerId: "w1", envelope: {}, state: "COMMITTED" },
    });
    await expect(
      prisma.resultSubmission.create({
        data: { idempotencyKey: "k2", jobId, attempt: 1, leaseId: claimed!.leaseId, workerId: "w1", envelope: {}, state: "COMMITTED" },
      }),
    ).rejects.toThrow();
  });

  it("segmented runs: deterministic keys, per-segment jobs, run advances only when all succeed", async () => {
    const segments = [
      { index: 0, total: 2, key: "seg0", mangaIds: ["1", "2"] },
      { index: 1, total: 2, key: "seg1", mangaIds: ["3"] },
    ];
    const { run } = await createRun("seg-run", segments);
    expect(await prisma.job.count({ where: { runId: run.id } })).toBe(2);

    const c1 = await store.claim("w1", { trust: "TRUSTED", leaseTtlSeconds: 60 });
    await store.complete(c1!.job.id, c1!.leaseId);
    await store.advanceRuns();
    expect((await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).state).toBe("EXECUTING");

    const c2 = await store.claim("w2", { trust: "TRUSTED", leaseTtlSeconds: 60 });
    await store.complete(c2!.job.id, c2!.leaseId);
    const { readyRunIds } = await store.advanceRuns();
    expect(readyRunIds).toContain(run.id);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).state).toBe("INGESTING");
  });

  it("cancellation: pending cancels immediately; running is flagged via renew", async () => {
    await createRun("c1");
    const job = await prisma.job.findFirstOrThrow();
    expect(await store.cancel(job.id)).toBe("cancelled");

    await createRun("c2");
    const job2 = await prisma.job.findFirstOrThrow({ where: { state: "PENDING" } });
    const claimed = await store.claim("w1", { trust: "TRUSTED", leaseTtlSeconds: 60 });
    expect(claimed!.job.id).toBe(job2.id);
    expect(await store.cancel(job2.id)).toBe("flagged");
    const renewed = await store.renew(job2.id, claimed!.leaseId, 60);
    expect(renewed!.cancelRequested).toBe(true);
  });

  it("COMMUNITY workers cannot claim TRUSTED-only jobs", async () => {
    await store.createRun({
      idempotencyKey: "trusted-run",
      extension: "k_manga",
      extensionVersion: "1.0",
      bundleSha256: "b".repeat(64),
      kind: "UPDATE",
      minTrust: "TRUSTED",
    });
    expect(await store.claim("community-w", { trust: "COMMUNITY", leaseTtlSeconds: 60 })).toBeNull();
    expect(await store.claim("trusted-w", { trust: "TRUSTED", leaseTtlSeconds: 60 })).not.toBeNull();
  });
});
