import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient, type UploadTask, type UploadTaskKind } from "@prisma/client";

/**
 * Central MangaDex work queues — the Postgres replacement for the Mongo
 * `to_upload` / `to_edit` / `to_delete` / `to_unavailable` collections.
 *
 * Insertion preserves today's `$setOnInsert` upsert semantics via a unique
 * (kind, dedupe_key) constraint + ON CONFLICT DO NOTHING: re-processing a run
 * or ingesting overlapping results can never enqueue the same chapter twice.
 * Draining uses the same SKIP LOCKED lease pattern as jobs, so multiple
 * uploader processes are safe.
 */

export function uploadDedupeKey(chapter: {
  chapterId?: string | null;
  chapterNumber?: string | null;
  chapterLanguage?: string | null;
}): string {
  return `${chapter.chapterId ?? ""}|${chapter.chapterNumber ?? ""}|${chapter.chapterLanguage ?? ""}`;
}

export class UploadTaskStore {
  constructor(private readonly prisma: PrismaClient) {}

  /** Enqueue if absent. Returns true when a new task row was created. */
  async enqueue(kind: UploadTaskKind, dedupeKey: string, chapter: unknown): Promise<boolean> {
    const res = await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO upload_tasks (id, kind, dedupe_key, chapter, state, created_at, updated_at)
      VALUES (${randomUUID()}, ${kind}::"UploadTaskKind", ${dedupeKey},
              ${JSON.stringify(chapter)}::jsonb, 'PENDING', now(), now())
      ON CONFLICT (kind, dedupe_key) DO NOTHING
    `);
    return res === 1;
  }

  /** Claim one due task of the given kind (SKIP LOCKED lease). */
  async claim(kind: UploadTaskKind, leaseTtlSeconds: number): Promise<UploadTask | null> {
    const leaseId = randomUUID();
    const rows = await this.prisma.$queryRaw<UploadTask[]>(Prisma.sql`
      WITH candidate AS (
        SELECT id FROM upload_tasks
        WHERE kind = ${kind}::"UploadTaskKind" AND state = 'PENDING' AND not_before <= now()
        ORDER BY not_before ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE upload_tasks t
      SET state = 'LEASED', lease_id = ${leaseId},
          lease_expires_at = now() + make_interval(secs => ${leaseTtlSeconds}),
          attempt = t.attempt + 1, updated_at = now()
      FROM candidate WHERE t.id = candidate.id
      RETURNING t.id, t.kind, t.dedupe_key AS "dedupeKey", t.chapter, t.state,
        t.attempt, t.max_attempts AS "maxAttempts", t.not_before AS "notBefore",
        t.lease_id AS "leaseId", t.lease_expires_at AS "leaseExpiresAt",
        t.last_error AS "lastError", t.created_at AS "createdAt",
        t.updated_at AS "updatedAt"
    `);
    return rows[0] ?? null;
  }

  async completeDone(taskId: string, leaseId: string): Promise<boolean> {
    const res = await this.prisma.uploadTask.updateMany({
      where: { id: taskId, leaseId, state: "LEASED" },
      data: { state: "DONE" },
    });
    return res.count === 1;
  }

  async fail(taskId: string, leaseId: string, message: string, retryDelaySeconds: number): Promise<"requeued" | "dead_letter" | "rejected"> {
    const task = await this.prisma.uploadTask.findUnique({ where: { id: taskId } });
    if (!task) return "rejected";
    if (task.attempt >= task.maxAttempts) {
      const res = await this.prisma.uploadTask.updateMany({
        where: { id: taskId, leaseId, state: "LEASED" },
        data: { state: "DEAD_LETTER", lastError: message.slice(0, 4000) },
      });
      return res.count === 1 ? "dead_letter" : "rejected";
    }
    const res = await this.prisma.uploadTask.updateMany({
      where: { id: taskId, leaseId, state: "LEASED" },
      data: {
        state: "PENDING",
        lastError: message.slice(0, 4000),
        notBefore: new Date(Date.now() + retryDelaySeconds * 1000),
        leaseId: null,
        leaseExpiresAt: null,
      },
    });
    return res.count === 1 ? "requeued" : "rejected";
  }

  /** Sweeper for crashed uploader processes. */
  async sweepExpired(): Promise<number> {
    return this.prisma.$executeRaw(Prisma.sql`
      UPDATE upload_tasks
      SET state = 'PENDING', lease_id = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE state = 'LEASED' AND lease_expires_at < now()
    `);
  }

  async depths(): Promise<{ kind: string; state: string; count: number }[]> {
    const rows = await this.prisma.$queryRaw<{ kind: string; state: string; count: bigint }[]>(
      Prisma.sql`SELECT kind::text, state::text, count(*) FROM upload_tasks GROUP BY kind, state`,
    );
    return rows.map((r) => ({ kind: r.kind, state: r.state, count: Number(r.count) }));
  }
}
