import { Prisma, type PrismaClient, type ResultSubmission } from "@prisma/client";
import type { ResultEnvelope } from "../../contracts/envelope.js";

export type IngestOutcome =
  | { outcome: "committed"; submissionId: string }
  | { outcome: "superseded"; submissionId: string; reason: string }
  | { outcome: "quarantined"; submissionId: string; reason: string }
  | { outcome: "job_failed"; submissionId: string; disposition: string };

/**
 * Result submission persistence + the exactly-once commit marker.
 *
 * A partial unique index (one COMMITTED row per job_id, created in the
 * migration) makes it structurally impossible for two submissions, duplicate,
 * late, or malicious, to both commit for the same job. Everything else keys
 * off that invariant.
 */
export class ResultStore {
  constructor(private readonly prisma: PrismaClient) {}

  /** Record (idempotently) an incoming submission before any judgment. */
  async record(
    envelope: ResultEnvelope,
    workerId: string,
    attempt: number,
  ): Promise<{ submission: ResultSubmission; duplicate: boolean }> {
    try {
      const submission = await this.prisma.resultSubmission.create({
        data: {
          idempotencyKey: envelope.idempotencyKey,
          jobId: envelope.jobId,
          attempt,
          leaseId: envelope.leaseId,
          workerId,
          envelope: envelope as unknown as Prisma.InputJsonValue,
        },
      });
      return { submission, duplicate: false };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const existing = await this.prisma.resultSubmission.findUnique({
          where: { idempotencyKey: envelope.idempotencyKey },
        });
        if (existing) return { submission: existing, duplicate: true };
      }
      throw err;
    }
  }

  async markSuperseded(submissionId: string, reason: string): Promise<void> {
    await this.prisma.resultSubmission.updateMany({
      where: { id: submissionId, state: "RECEIVED" },
      data: { state: "SUPERSEDED", rejectReason: reason.slice(0, 2000) },
    });
  }

  async markQuarantined(submissionId: string, reason: string): Promise<void> {
    await this.prisma.resultSubmission.updateMany({
      where: { id: submissionId, state: "RECEIVED" },
      data: { state: "QUARANTINED", rejectReason: reason.slice(0, 2000) },
    });
  }

  /**
   * Atomically: flip this submission to COMMITTED (the partial unique index
   * admits at most one per job) AND mark the job SUCCEEDED gated on the lease.
   * Either both happen or neither. Returns false if another submission already
   * committed or the lease is no longer current.
   */
  async commit(submissionId: string, jobId: string, leaseId: string): Promise<boolean> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const flipped = await tx.resultSubmission.updateMany({
          where: { id: submissionId, state: "RECEIVED" },
          data: { state: "COMMITTED" },
        });
        if (flipped.count !== 1) throw new CommitLost("submission not in RECEIVED");
        const jobDone = await tx.job.updateMany({
          where: { id: jobId, leaseId, state: { in: ["LEASED", "RUNNING"] } },
          data: {
            state: "SUCCEEDED",
            errorClass: null,
            lastError: null,
          },
        });
        if (jobDone.count !== 1) throw new CommitLost("lease no longer current");
      });
      return true;
    } catch (err) {
      if (err instanceof CommitLost) return false;
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        // Partial unique index: someone else already committed for this job.
        return false;
      }
      throw err;
    }
  }

  /** The committed envelope for a job (used by the processor). */
  async committedForJob(jobId: string): Promise<ResultSubmission | null> {
    return this.prisma.resultSubmission.findFirst({
      where: { jobId, state: "COMMITTED" },
    });
  }

  async listQuarantined(limit = 50): Promise<ResultSubmission[]> {
    return this.prisma.resultSubmission.findMany({
      where: { state: "QUARANTINED" },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }
}

class CommitLost extends Error {}
