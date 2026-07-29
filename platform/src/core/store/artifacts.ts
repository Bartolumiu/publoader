import { createHash } from "node:crypto";
import type { PrismaClient, Artifact } from "@prisma/client";

export const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
export const ALLOWED_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
/** Artifacts not referenced by a committed result are GC'd after this. */
const DEFAULT_TTL_HOURS = 48;

/**
 * Checksummed binary artifacts (chapter page images). Stored in Postgres for
 * v1 behind this interface; swapping to object storage changes only this file.
 */
export class ArtifactStore {
  constructor(private readonly prisma: PrismaClient) {}

  async put(opts: {
    data: Buffer;
    contentType: string;
    declaredSha256: string;
    jobId?: string;
    workerId?: string;
  }): Promise<{ artifact: Artifact } | { error: string }> {
    if (opts.data.length === 0 || opts.data.length > MAX_ARTIFACT_BYTES) {
      return { error: `artifact size ${opts.data.length} outside limits` };
    }
    if (!ALLOWED_CONTENT_TYPES.has(opts.contentType)) {
      return { error: `content type ${opts.contentType} not allowed` };
    }
    const sha256 = createHash("sha256").update(opts.data).digest("hex");
    if (sha256 !== opts.declaredSha256.toLowerCase()) {
      return { error: "sha256 mismatch between declared and received content" };
    }
    const artifact = await this.prisma.artifact.create({
      data: {
        sha256,
        size: opts.data.length,
        contentType: opts.contentType,
        // Prisma v6 Bytes columns take Uint8Array (Buffer's SharedArrayBuffer
        // possibility makes it incompatible as-typed).
        data: new Uint8Array(opts.data),
        jobId: opts.jobId ?? null,
        workerId: opts.workerId ?? null,
        expiresAt: new Date(Date.now() + DEFAULT_TTL_HOURS * 3600 * 1000),
      },
    });
    return { artifact };
  }

  async get(id: string): Promise<Artifact | null> {
    return this.prisma.artifact.findUnique({ where: { id } });
  }

  /** Pin artifacts referenced by a committed result (clears TTL). */
  async pin(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.artifact.updateMany({
      where: { id: { in: ids } },
      data: { expiresAt: null },
    });
  }

  async deleteMany(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.artifact.deleteMany({ where: { id: { in: ids } } });
  }

  async gcExpired(): Promise<number> {
    const res = await this.prisma.artifact.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return res.count;
  }
}
