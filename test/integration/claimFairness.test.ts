import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { JobStore } from "../../src/core/store/jobs.js";
import { closeDb, dbReady, resetDb, testPrisma } from "./db.js";

/**
 * Rotation across the fleet, against real Postgres.
 *
 * Workers pull: whoever polls first claims. Left alone that means the fastest or
 * least-loaded host takes everything, which defeats the reason to run several -
 * publishers rate-limit per source IP, and one worker doing all the scraping is
 * one IP doing it.
 *
 * The rule is therefore "not the same worker twice in a row", and the cases that
 * matter are the ones where a naive version of that rule breaks something: a
 * one-worker fleet must not deadlock itself, and a peer that is heartbeating but
 * not actually polling must not hold the queue hostage.
 */
describe.skipIf(!dbReady())("claim fairness", () => {
  const prisma = testPrisma();
  const store = new JobStore(prisma, { baseSeconds: 1, maxSeconds: 4 });

  /** A worker that counts as alive: ACTIVE with a fresh heartbeat. */
  async function worker(name: string, heartbeatAgeSeconds = 0): Promise<string> {
    const row = await prisma.worker.create({
      data: {
        name,
        tokenHash: `hash-${name}`,
        status: "ACTIVE",
        trust: "TRUSTED",
        lastHeartbeatAt: new Date(Date.now() - heartbeatAgeSeconds * 1000),
      },
    });
    return row.id;
  }

  async function runWith(segments: number, key = "fairness-run"): Promise<void> {
    await store.createRun({
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
  }

  const claim = (id: string) => store.claim(id, { trust: "TRUSTED", leaseTtlSeconds: 300 });

  beforeEach(async () => {
    await resetDb(prisma);
  });
  afterAll(async () => {
    await closeDb();
  });

  it("refuses a second consecutive claim while another worker is alive", async () => {
    const a = await worker("a");
    await worker("b");
    await runWith(2);

    expect(await claim(a)).not.toBeNull();
    // Work is available and A is eligible for it in every other respect; the
    // only reason to refuse is that A also took the previous one.
    expect(await claim(a)).toBeNull();
    expect(await prisma.job.count({ where: { state: "PENDING" } })).toBe(1);
  });

  it("hands the next job to the other worker", async () => {
    const a = await worker("a");
    const b = await worker("b");
    await runWith(2);

    const first = await claim(a);
    const second = await claim(b);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.job.id).not.toBe(first!.job.id);
  });

  it("lets a worker claim again once someone else has", async () => {
    // The rule is about consecutive claims, not a per-worker quota: once B has
    // taken one, A is the next in line again rather than being rationed.
    const a = await worker("a");
    const b = await worker("b");
    await runWith(3);

    expect(await claim(a)).not.toBeNull();
    expect(await claim(b)).not.toBeNull();
    expect(await claim(a)).not.toBeNull();
    expect(await prisma.job.count({ where: { state: "PENDING" } })).toBe(0);
  });

  it("a single-worker fleet takes jobs back to back", async () => {
    // The failure this guards against is total: with one worker and a naive
    // anti-repeat rule, nothing is ever claimed again after the first job.
    const only = await worker("only");
    await runWith(3);

    for (let i = 0; i < 3; i += 1) {
      expect(await claim(only), `claim ${i + 1} of 3`).not.toBeNull();
    }
    expect(await prisma.job.count({ where: { state: "PENDING" } })).toBe(0);
  });

  it("ignores workers that have stopped heartbeating", async () => {
    // A registered-but-dead peer is not competition. Counting it would stall the
    // queue behind a host that is never going to poll again.
    const a = await worker("a");
    await worker("ghost", 3600);
    await runWith(2);

    expect(await claim(a)).not.toBeNull();
    expect(await claim(a), "a dead peer should not force A to stand aside").not.toBeNull();
  });

  it("releases the hold once the cooldown has passed", async () => {
    // Bounds the damage from a peer that heartbeats but never polls: A waits one
    // cooldown, not until the peer's heartbeat goes stale.
    const a = await worker("a");
    await worker("idle");
    await runWith(2);

    expect(await claim(a)).not.toBeNull();
    expect(await claim(a)).toBeNull();

    // Age the previous claim past the cooldown window.
    await prisma.job.updateMany({
      where: { leasedAt: { not: null } },
      data: { leasedAt: new Date(Date.now() - 120_000) },
    });
    expect(await claim(a), "A should be eligible again after the cooldown").not.toBeNull();
  });

  it("records when a job was claimed", async () => {
    // The rule reads this column; if the claim stopped writing it, every worker
    // would look like it had never claimed and the rule would quietly do nothing.
    const a = await worker("a");
    await runWith(1);
    const claimed = await claim(a);
    const row = await prisma.job.findUniqueOrThrow({ where: { id: claimed!.job.id } });
    expect(row.leasedAt).toBeInstanceOf(Date);
    expect(row.leaseWorkerId).toBe(a);
  });

  it("still never hands one job to two workers", async () => {
    // The fairness predicate lives inside the SELECT ... FOR UPDATE SKIP LOCKED,
    // so it must not have weakened the guarantee the whole system rests on.
    const ids = await Promise.all([worker("w1"), worker("w2"), worker("w3")]);
    await runWith(3);

    const claims = await Promise.all(ids.map((id) => claim(id)));
    const got = claims.filter((c) => c !== null).map((c) => c!.job.id);
    expect(new Set(got).size, "the same job was claimed twice").toBe(got.length);
  });
});
