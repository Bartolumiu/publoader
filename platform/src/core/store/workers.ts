import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient, Worker, TrustTier } from "@prisma/client";

/**
 * Worker identity, enrollment, and credential lifecycle.
 *
 * Credentials are bearer tokens shown exactly once; only sha256 hashes are
 * stored. Enrollment tokens are single-use and expiring; worker tokens are
 * individually revocable. Nothing here ever returns a stored secret.
 */

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export class WorkerStore {
  constructor(private readonly prisma: PrismaClient) {}

  /** Operator mints an enrollment token (returned once, stored hashed). */
  async createEnrollToken(opts: {
    trust?: TrustTier;
    note?: string;
    ttlHours?: number;
  }): Promise<{ token: string; expiresAt: Date }> {
    const token = newToken("pe");
    const expiresAt = new Date(Date.now() + (opts.ttlHours ?? 24) * 3600 * 1000);
    await this.prisma.enrollToken.create({
      data: {
        tokenHash: hashToken(token),
        trust: opts.trust ?? "COMMUNITY",
        note: opts.note ?? null,
        expiresAt,
      },
    });
    return { token, expiresAt };
  }

  /**
   * Exchange a valid enrollment token for a worker identity + credential.
   * Consuming the token is a guarded single-row update, so a token can only
   * ever enroll one worker even under concurrent attempts.
   */
  async enroll(opts: {
    enrollToken: string;
    name: string;
    capabilities?: unknown;
    agentVersion?: string;
  }): Promise<{ workerId: string; workerToken: string; trust: TrustTier } | null> {
    const tokenHash = hashToken(opts.enrollToken);
    const row = await this.prisma.enrollToken.findUnique({ where: { tokenHash } });
    if (!row || row.revoked || row.expiresAt < new Date()) return null;
    if (row.singleUse && row.usedByWorkerId) return null;

    const workerToken = newToken("pw");
    const worker = await this.prisma.worker.create({
      data: {
        name: opts.name.slice(0, 128),
        tokenHash: hashToken(workerToken),
        trust: row.trust,
        capabilities: (opts.capabilities as object) ?? {},
        agentVersion: opts.agentVersion ?? null,
        lastHeartbeatAt: new Date(),
      },
    });

    const consumed = await this.prisma.enrollToken.updateMany({
      where: { id: row.id, usedByWorkerId: null, revoked: false },
      data: { usedByWorkerId: worker.id },
    });
    if (row.singleUse && consumed.count !== 1) {
      // Lost the race to another enrollment — roll back our worker.
      await this.prisma.worker.delete({ where: { id: worker.id } });
      return null;
    }
    return { workerId: worker.id, workerToken, trust: worker.trust };
  }

  /** Authenticate a presented worker token. Revoked/drained rules applied by caller. */
  async authenticate(workerToken: string): Promise<Worker | null> {
    const worker = await this.prisma.worker.findUnique({
      where: { tokenHash: hashToken(workerToken) },
    });
    if (!worker || worker.status === "REVOKED") return null;
    return worker;
  }

  async heartbeat(workerId: string, agentVersion?: string): Promise<void> {
    await this.prisma.worker.update({
      where: { id: workerId },
      data: {
        lastHeartbeatAt: new Date(),
        ...(agentVersion ? { agentVersion } : {}),
      },
    });
  }

  async setStatus(workerId: string, status: "ACTIVE" | "DRAINED" | "REVOKED"): Promise<boolean> {
    const res = await this.prisma.worker.updateMany({
      where: { id: workerId },
      data: { status },
    });
    return res.count === 1;
  }

  async list(): Promise<Worker[]> {
    return this.prisma.worker.findMany({ orderBy: { createdAt: "asc" } });
  }
}
