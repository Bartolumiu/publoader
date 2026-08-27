import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { logSink } from "../../src/core/observability/logSink.js";

/**
 * The size bound on `log_events`.
 *
 * `prune` bounds how OLD a line may get and therefore bounds nothing about
 * size: a loud day writes in an hour what a quiet week does, and none of it is
 * eligible for the age pass until it is `logRetentionDays` old. A disk that
 * fills stops Postgres outright -- it cannot write `postmaster.pid`, so it does
 * not start -- which is a whole-platform outage caused by diagnostics. So the
 * cap is the bound that has to hold today, and these are the properties that
 * make it trustworthy:
 *
 *  - under the cap it deletes NOTHING. A bound that trims on every pass would
 *    quietly cost the newest lines on a quiet system.
 *  - over the cap it deletes by the cutoff timestamp, so the delete rides the
 *    `created_at` index rather than walking millions of rows via OFFSET.
 *  - a failure returns 0 rather than throwing. This runs inside the scheduler
 *    loop; an exception escaping it would take the loop down over housekeeping.
 *  - with no database it is a no-op, because workers never enable the sink.
 */
describe("logSink.capRows", () => {
  const stub = (over: { cutoff?: Date | null; deleted?: number; throws?: boolean }) => {
    const deleteMany = vi.fn(async () => ({ count: over.deleted ?? 0 }));
    const queryRaw = vi.fn(async () => {
      if (over.throws) throw new Error("db gone");
      return over.cutoff ? [{ created_at: over.cutoff }] : [];
    });
    const prisma = {
      $queryRaw: queryRaw,
      logEvent: { deleteMany },
    } as unknown as PrismaClient;
    return { prisma, deleteMany, queryRaw };
  };

  it("is a no-op before the sink has a database", async () => {
    // Asserted first: `enable` is process-wide, so this is the only point at
    // which the un-enabled state exists.
    await expect(logSink.capRows(1000)).resolves.toBe(0);
  });

  it("deletes nothing when the table is under the cap", async () => {
    const { prisma, deleteMany } = stub({ cutoff: null });
    logSink.enable(prisma);

    await expect(logSink.capRows(2_000_000)).resolves.toBe(0);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("deletes by cutoff timestamp once past the cap", async () => {
    const cutoff = new Date("2026-08-01T00:00:00.000Z");
    const { prisma, deleteMany } = stub({ cutoff, deleted: 4321 });
    logSink.enable(prisma);

    await expect(logSink.capRows(1000)).resolves.toBe(4321);
    expect(deleteMany).toHaveBeenCalledWith({ where: { createdAt: { lt: cutoff } } });
  });

  it("returns 0 rather than throwing when the database fails", async () => {
    const { prisma, deleteMany } = stub({ throws: true });
    logSink.enable(prisma);

    await expect(logSink.capRows(1000)).resolves.toBe(0);
    expect(deleteMany).not.toHaveBeenCalled();
  });
});
