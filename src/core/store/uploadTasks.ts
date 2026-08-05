import { randomUUID } from "node:crypto";
import {
  Prisma,
  type PrismaClient,
  type UploadTask,
  type UploadTaskKind,
  type UploadTaskState,
} from "@prisma/client";

/**
 * Central MangaDex work queues — the Postgres replacement for the Mongo
 * `to_upload` / `to_edit` / `to_delete` / `to_unavailable` collections.
 *
 * Insertion preserves today's `$setOnInsert` upsert semantics via a unique
 * (kind, dedupe_key) constraint + ON CONFLICT DO NOTHING: re-processing a run
 * or ingesting overlapping results can never enqueue the same chapter twice.
 * Draining uses the same SKIP LOCKED lease pattern as jobs, so multiple
 * uploader processes are safe.
 *
 * The operator half of this file (list/retry/remove/purge/reorder/manual add)
 * follows jobs.ts to the letter: every mutation is one statement, or one
 * transaction, whose WHERE clause names the expected prior state. Zero rows
 * affected means the caller lost the race and must report a refusal — there is
 * no read-then-write anywhere, and nothing here can touch a LEASED row, which
 * belongs to a live uploader process.
 */

export const UPLOAD_TASK_KINDS = ["UPLOAD", "EDIT", "DELETE", "UNAVAILABLE"] as const;
export const UPLOAD_TASK_STATES = ["PENDING", "LEASED", "DONE", "FAILED", "DEAD_LETTER"] as const;

/** States an operator may retry back into the queue. */
export const RETRYABLE_STATES = ["FAILED", "DEAD_LETTER"] as const satisfies readonly UploadTaskState[];

/**
 * States a row may be deleted from without an extra flag. DONE is deliberately
 * absent: a DONE row is half of the double-upload guard (the other half being
 * `upload_logs`), so dropping one re-arms the processor to enqueue that chapter
 * again. Callers must pass `includeCompleted` and say so out loud.
 */
export const REMOVABLE_STATES = ["PENDING", "FAILED", "DEAD_LETTER"] as const satisfies readonly UploadTaskState[];

/**
 * Hard ceiling on one bulk mutation. Bulk here means "an operator clicked
 * select-all", not "migrate the queue" — a capped-and-reported batch is far
 * easier to reason about after the fact than a statement that touched 90k rows
 * because a filter was wider than intended.
 */
export const BULK_CAP = 1000;
/** Same idea for a whole-queue purge, which is expected to be larger. */
export const PURGE_CAP = 5000;

export function uploadDedupeKey(chapter: {
  chapterId?: string | null;
  chapterNumber?: string | null;
  chapterLanguage?: string | null;
}): string {
  return `${chapter.chapterId ?? ""}|${chapter.chapterNumber ?? ""}|${chapter.chapterLanguage ?? ""}`;
}

/**
 * The dedupe key for a hand-built task, derived exactly as the producers do:
 * `uploadDedupeKey` for UPLOAD (processor.ts) and the MangaDex chapter id for
 * every other kind (processor.enqueueRemovals, and the EDIT branch above it).
 * Returning null rather than a degenerate key is what stops a chapter with no
 * identity at all from occupying the `||` slot — the same guard
 * cli/migrate-from-mongo.ts applies to legacy documents.
 */
export function taskDedupeKey(
  kind: UploadTaskKind,
  chapter: {
    chapterId?: string | null;
    chapterNumber?: string | null;
    chapterLanguage?: string | null;
    mdChapterId?: string | null;
  },
): string | null {
  if (kind === "UPLOAD") {
    const key = uploadDedupeKey(chapter);
    return key === "||" ? null : key;
  }
  return chapter.mdChapterId ?? null;
}

/** Filter shared by the list, bulk-mutation and purge paths. */
export interface UploadTaskFilter {
  kinds?: readonly UploadTaskKind[];
  states?: readonly UploadTaskState[];
  /** Case-insensitive substring over `dedupe_key`. */
  dedupeKey?: string;
  attemptMin?: number;
  attemptMax?: number;
}

/** A queue row without its `chapter` payload — what list views return. */
export interface UploadTaskRow {
  id: string;
  kind: string;
  dedupeKey: string;
  state: string;
  attempt: number;
  maxAttempts: number;
  notBefore: Date;
  leaseId: string | null;
  leaseExpiresAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Enough of a row to explain why a mutation refused it. */
export interface UploadTaskStateRow {
  id: string;
  kind: string;
  dedupeKey: string;
  state: string;
  leaseId: string | null;
  leaseExpiresAt: Date | null;
  updatedAt: Date;
}

export type ReorderMode = "front" | "back" | "sequence" | "defer";

/**
 * Keyset position in the queue's own ordering. Offset paging cannot be used
 * here: the uploader mutates `not_before` constantly, so page 2 of an offset
 * scan silently skips or repeats rows as the queue drains.
 */
export interface TaskCursor {
  notBefore: Date;
  createdAt: Date;
  id: string;
}

export function encodeTaskCursor(row: TaskCursor): string {
  const raw = `${row.notBefore.toISOString()}|${row.createdAt.toISOString()}|${row.id}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}

/** Null for anything unparseable; the caller answers 400 rather than guessing. */
export function decodeTaskCursor(raw: string): TaskCursor | null {
  const parts = Buffer.from(raw, "base64url").toString("utf8").split("|");
  if (parts.length !== 3) return null;
  const [notBefore, createdAt, id] = parts as [string, string, string];
  const a = new Date(notBefore);
  const b = new Date(createdAt);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  return { notBefore: a, createdAt: b, id };
}

/**
 * Millisecond offsets from the mode's anchor, one per id in the order given.
 *
 * Reordering is expressed purely as `not_before` — see the comment on
 * `UploadTaskStore.reorder` for why — so "position in the queue" is arithmetic
 * on an instant. Steps are 1 ms apart, which postgres stores exactly
 * (timestamptz is microsecond-resolution) and which is far below any interval
 * an operator cares about.
 */
export function reorderOffsetsMs(mode: Exclude<ReorderMode, "defer">, count: number): number[] {
  const offsets: number[] = [];
  for (let i = 0; i < count; i++) {
    // front: strictly before the anchor (the earliest other pending row), in
    // order. back: strictly after it. sequence: from the group's own earliest
    // instant, so the group keeps its place and only its internal order moves.
    if (mode === "front") offsets.push(-(count - i));
    else if (mode === "back") offsets.push(i + 1);
    else offsets.push(i);
  }
  return offsets;
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

  /**
   * Queue a chapter action an operator asked for, superseding a settled row.
   *
   * `enqueue` cannot serve this. Its ON CONFLICT DO NOTHING is what makes the
   * processor idempotent, but it also means the (kind, dedupe_key) slot for a
   * chapter is occupied FOREVER once the task completes — nothing deletes DONE
   * rows — so a second operator action on the same chapter would silently do
   * nothing. That is correct for the processor (it re-derives the same work
   * every run) and wrong for a person who has just corrected a title and wants
   * it pushed again.
   *
   * So a settled row is reset in place: same slot, new payload, PENDING, fresh
   * attempt budget, due now. Which states count as settled is the whole safety
   * property and it lives in the WHERE clause of the one statement:
   *
   *  - LEASED is excluded because an uploader is mid-flight against MangaDex.
   *  - PENDING is excluded because the work is already queued; overwriting it
   *    would change what a queued task does under an operator who is watching
   *    the queue, and "it is already queued" is a better answer than a silent
   *    rewrite.
   *
   * Both come back as null, and the caller reads the row afterwards purely to
   * name the state in its refusal — never to decide whether to write.
   *
   * UPLOAD is not accepted, by type and at runtime: resetting a DONE UPLOAD row
   * removes half of the double-upload guard (see REMOVABLE_STATES), and every
   * chapter this is reachable from is already on MangaDex.
   */
  async requeueForChapter(
    kind: Exclude<UploadTaskKind, "UPLOAD">,
    dedupeKey: string,
    chapter: unknown,
    opts: { maxAttempts?: number } = {},
  ): Promise<{ task: UploadTaskRow; superseded: boolean } | null> {
    if (kind === ("UPLOAD" as UploadTaskKind)) {
      throw new Error("requeueForChapter does not accept UPLOAD: it would re-arm a double upload");
    }
    const rows = await this.prisma.$queryRaw<(UploadTaskRow & { inserted: boolean })[]>(Prisma.sql`
      INSERT INTO upload_tasks (id, kind, dedupe_key, chapter, state, attempt, max_attempts,
                                not_before, created_at, updated_at)
      VALUES (${randomUUID()}, ${kind}::"UploadTaskKind", ${dedupeKey},
              ${JSON.stringify(chapter)}::jsonb, 'PENDING', 0,
              coalesce(${opts.maxAttempts ?? null}::int, 5), now(), now(), now())
      ON CONFLICT (kind, dedupe_key) DO UPDATE
        SET chapter = EXCLUDED.chapter, state = 'PENDING', attempt = 0,
            max_attempts = EXCLUDED.max_attempts, not_before = now(),
            lease_id = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = now()
        WHERE upload_tasks.state IN ('DONE', 'FAILED', 'DEAD_LETTER')
      -- xmax is 0 on a freshly inserted tuple and carries the updating
      -- transaction id on one that took the DO UPDATE branch. It is the only
      -- way to tell "queued" from "requeued" without a second statement, and
      -- the difference matters: superseding a DONE row is worth saying out loud
      -- in the response and in the audit trail.
      RETURNING id, kind::text AS kind, dedupe_key AS "dedupeKey", state::text AS state,
                attempt, max_attempts AS "maxAttempts", not_before AS "notBefore",
                lease_id AS "leaseId", lease_expires_at AS "leaseExpiresAt",
                last_error AS "lastError", created_at AS "createdAt",
                updated_at AS "updatedAt", (xmax = 0) AS inserted
    `);
    const row = rows[0];
    if (!row) return null;
    const { inserted, ...task } = row;
    return { task, superseded: !inserted };
  }

  /**
   * Every queue row for one dedupe key, across kinds. For a chapter that is
   * `mdChapterId` — the key EDIT, DELETE and UNAVAILABLE all use — so this
   * answers "is anything already queued against this chapter?".
   */
  async forDedupeKey(dedupeKey: string): Promise<UploadTaskRow[]> {
    return this.forDedupeKeys([dedupeKey]);
  }

  /**
   * The same question for many chapters in one query, which is what a bulk
   * action's dry run asks: it has to predict, for every chapter in the set,
   * whether the write would be accepted — and doing that one chapter at a time
   * would make the preview slower than the operation it previews.
   */
  async forDedupeKeys(dedupeKeys: readonly string[]): Promise<UploadTaskRow[]> {
    if (dedupeKeys.length === 0) return [];
    return this.prisma.$queryRaw<UploadTaskRow[]>(Prisma.sql`
      SELECT ${TASK_COLUMNS} FROM upload_tasks t
      WHERE t.dedupe_key = ANY(${[...dedupeKeys]}::text[])
      ORDER BY t.updated_at DESC
    `);
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

  // ---------------------------------------------------------------- operator

  /**
   * One page of the queue in the order it will actually drain, plus the total
   * matching the filter.
   *
   * `not_before ASC` is the claim query's ordering, so this list answers "what
   * runs next?" rather than "what changed last?" (which is what ordering by
   * `updated_at` answers, and which is why the same list keyed on `updated_at`
   * could never be used to verify a reorder). `created_at, id` are appended
   * only to make the ordering total, which keyset paging requires; the claim
   * query breaks ties arbitrarily and does not need to care.
   */
  async list(
    filter: UploadTaskFilter,
    opts: { limit: number; cursor?: TaskCursor | null },
  ): Promise<{ tasks: UploadTaskRow[]; total: number; nextCursor: string | null }> {
    const parts = taskWhere(filter);
    if (opts.cursor) {
      parts.push(
        Prisma.sql`(t.not_before, t.created_at, t.id) > (${opts.cursor.notBefore}, ${opts.cursor.createdAt}, ${opts.cursor.id})`,
      );
    }
    // One row beyond the page, so "is there a next page?" needs no second count.
    const [rows, counted] = await Promise.all([
      this.prisma.$queryRaw<UploadTaskRow[]>(Prisma.sql`
        SELECT ${TASK_COLUMNS} FROM upload_tasks t
        ${combine(parts)}
        ORDER BY t.not_before ASC, t.created_at ASC, t.id ASC
        LIMIT ${opts.limit + 1}
      `),
      this.prisma.$queryRaw<{ total: bigint }[]>(Prisma.sql`
        SELECT count(*) AS total FROM upload_tasks t ${combine(taskWhere(filter))}
      `),
    ]);

    const page = rows.slice(0, opts.limit);
    const last = page[page.length - 1];
    return {
      tasks: page,
      total: Number(counted[0]?.total ?? 0),
      nextCursor: rows.length > opts.limit && last ? encodeTaskCursor(last) : null,
    };
  }

  /** One row including its `chapter` payload — the detail/edit view. */
  async get(id: string): Promise<(UploadTaskRow & { chapter: unknown }) | null> {
    const rows = await this.prisma.$queryRaw<(UploadTaskRow & { chapter: unknown })[]>(Prisma.sql`
      SELECT ${TASK_COLUMNS}, t.chapter FROM upload_tasks t WHERE t.id = ${id}
    `);
    return rows[0] ?? null;
  }

  /**
   * Current state of specific ids, for explaining a refusal. Only ever read
   * AFTER a guarded mutation reported fewer rows than asked for — never before
   * one, which would be the read-then-write this file does not do.
   */
  async statesOf(ids: readonly string[]): Promise<Map<string, UploadTaskStateRow>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<UploadTaskStateRow[]>(Prisma.sql`
      SELECT t.id, t.kind::text AS kind, t.dedupe_key AS "dedupeKey", t.state::text AS state,
             t.lease_id AS "leaseId", t.lease_expires_at AS "leaseExpiresAt",
             t.updated_at AS "updatedAt"
      FROM upload_tasks t WHERE t.id = ANY(${[...ids]}::text[])
    `);
    return new Map(rows.map((row) => [row.id, row]));
  }

  /** Ids matching a filter, in queue order, capped. Backs `{filter: …}` bulk calls. */
  async idsMatching(filter: UploadTaskFilter, cap: number): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT t.id FROM upload_tasks t ${combine(taskWhere(filter))}
      ORDER BY t.not_before ASC, t.created_at ASC, t.id ASC
      LIMIT ${cap}
    `);
    return rows.map((row) => row.id);
  }

  async countMatching(filter: UploadTaskFilter): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ total: bigint }[]>(Prisma.sql`
      SELECT count(*) AS total FROM upload_tasks t ${combine(taskWhere(filter))}
    `);
    return Number(rows[0]?.total ?? 0);
  }

  /** Per kind+state counts for a filter — the depth breakdown a purge reports. */
  async breakdown(filter: UploadTaskFilter): Promise<{ kind: string; state: string; count: number }[]> {
    const rows = await this.prisma.$queryRaw<{ kind: string; state: string; count: bigint }[]>(Prisma.sql`
      SELECT t.kind::text AS kind, t.state::text AS state, count(*) AS count
      FROM upload_tasks t ${combine(taskWhere(filter))}
      GROUP BY t.kind, t.state ORDER BY t.kind, t.state
    `);
    return rows.map((row) => ({ kind: row.kind, state: row.state, count: Number(row.count) }));
  }

  /**
   * FAILED/DEAD_LETTER -> PENDING with a fresh attempt budget and due now.
   *
   * The budget resets because the operator is asserting the cause is fixed;
   * leaving `attempt` at `maxAttempts` would dead-letter the task again on the
   * first hiccup. LEASED rows cannot match the WHERE clause, so a worker's task
   * is untouchable here by construction rather than by a check.
   */
  async retryMany(ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE upload_tasks
      SET state = 'PENDING', attempt = 0, not_before = now(),
          lease_id = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE id = ANY(${[...ids]}::text[])
        AND state = ANY(${[...RETRYABLE_STATES]}::text[]::"UploadTaskState"[])
      RETURNING id
    `);
    return rows.map((row) => row.id);
  }

  /**
   * Delete rows outright. Returns what went, so the caller can report it rather
   * than a count — "3 deleted" is not an audit trail, and these rows do not
   * exist afterwards to look up.
   */
  async removeMany(
    ids: readonly string[],
    opts: { includeCompleted: boolean },
  ): Promise<{ id: string; kind: string; dedupeKey: string; state: string }[]> {
    if (ids.length === 0) return [];
    const states = opts.includeCompleted ? [...REMOVABLE_STATES, "DONE"] : [...REMOVABLE_STATES];
    return this.prisma.$queryRaw<{ id: string; kind: string; dedupeKey: string; state: string }[]>(Prisma.sql`
      DELETE FROM upload_tasks
      WHERE id = ANY(${[...ids]}::text[])
        AND state = ANY(${states}::text[]::"UploadTaskState"[])
      RETURNING id, kind::text AS kind, dedupe_key AS "dedupeKey", state::text AS state
    `);
  }

  /**
   * Whole-queue delete by filter, capped. LEASED is excluded in the statement
   * itself (not by the caller's filter) so no combination of inputs can reach a
   * row a worker owns; DONE likewise needs `includeCompleted`.
   *
   * The inner SELECT is what applies the cap: `DELETE … LIMIT` is not valid SQL,
   * and an uncapped delete is exactly the operation that turns a too-wide filter
   * into an unrecoverable morning.
   */
  async purge(
    filter: UploadTaskFilter,
    opts: { includeCompleted: boolean; cap: number },
  ): Promise<{ id: string; kind: string; dedupeKey: string; state: string }[]> {
    const states = opts.includeCompleted ? [...REMOVABLE_STATES, "DONE"] : [...REMOVABLE_STATES];
    const parts = taskWhere(filter);
    parts.push(Prisma.sql`t.state = ANY(${states}::text[]::"UploadTaskState"[])`);
    return this.prisma.$queryRaw<{ id: string; kind: string; dedupeKey: string; state: string }[]>(Prisma.sql`
      DELETE FROM upload_tasks
      WHERE id IN (
        SELECT t.id FROM upload_tasks t ${combine(parts)}
        ORDER BY t.not_before ASC, t.created_at ASC, t.id ASC
        LIMIT ${opts.cap}
      )
      RETURNING id, kind::text AS kind, dedupe_key AS "dedupeKey", state::text AS state
    `);
  }

  /**
   * Reprioritise PENDING rows by rewriting `not_before`.
   *
   * WHY `not_before` AND NOT A PRIORITY COLUMN: the claim query already reads
   * `WHERE state = 'PENDING' AND not_before <= now() ORDER BY not_before ASC`,
   * so `not_before` *is* the queue's priority — it is both the readiness gate
   * and the sort key. Adding a `priority` column would need a schema change, a
   * change to that ORDER BY, and would then leave two fields deciding order,
   * with the awkward question of which wins when a backing-off task (future
   * `not_before`) carries a high priority. Writing an instant needs none of
   * that: "run this next" is `not_before` before everyone else's, "run it later"
   * is `not_before` further out, and the semantics of "not yet due" are
   * preserved for free.
   *
   * Every mode is one statement whose WHERE names PENDING, so a row a worker
   * leased between the operator's click and this update simply is not returned.
   * The anchor is a scalar subquery inside that same statement rather than a
   * prior SELECT, which keeps the whole thing atomic.
   */
  async reorder(
    ids: readonly string[],
    mode: ReorderMode,
    deferSeconds = 0,
  ): Promise<{ id: string; notBefore: Date }[]> {
    if (ids.length === 0) return [];
    const idArray = [...ids];

    if (mode === "defer") {
      // Relative to now() for a row already due, so deferring a long-overdue
      // task by 60s means "in a minute" rather than "a minute after a date that
      // has passed", which would be no deferral at all.
      return this.prisma.$queryRaw<{ id: string; notBefore: Date }[]>(Prisma.sql`
        UPDATE upload_tasks
        SET not_before = greatest(not_before, now()) + make_interval(secs => ${deferSeconds}),
            updated_at = now()
        WHERE id = ANY(${idArray}::text[]) AND state = 'PENDING'
        RETURNING id, not_before AS "notBefore"
      `);
    }

    const offsets = reorderOffsetsMs(mode, idArray.length);
    const pairs = Prisma.join(
      idArray.map((id, index) => Prisma.sql`(${id}::text, ${(offsets[index] ?? 0) / 1000}::double precision)`),
      ", ",
    );
    // front/back anchor on the rest of the queue and are clamped to now(), so
    // "front" is due immediately even when every other pending row is backing
    // off into the future. sequence anchors on the listed rows themselves,
    // which is what makes it a relative reordering rather than a queue jump.
    const anchor =
      mode === "front"
        ? Prisma.sql`SELECT least(coalesce(min(not_before), now()), now()) AS at
                     FROM upload_tasks WHERE state = 'PENDING' AND NOT (id = ANY(${idArray}::text[]))`
        : mode === "back"
          ? Prisma.sql`SELECT greatest(coalesce(max(not_before), now()), now()) AS at
                       FROM upload_tasks WHERE state = 'PENDING' AND NOT (id = ANY(${idArray}::text[]))`
          : Prisma.sql`SELECT coalesce(min(not_before), now()) AS at
                       FROM upload_tasks WHERE state = 'PENDING' AND id = ANY(${idArray}::text[])`;

    return this.prisma.$queryRaw<{ id: string; notBefore: Date }[]>(Prisma.sql`
      WITH anchor AS (${anchor})
      UPDATE upload_tasks t
      SET not_before = anchor.at + make_interval(secs => v.secs), updated_at = now()
      FROM (VALUES ${pairs}) AS v(id, secs), anchor
      WHERE t.id = v.id AND t.state = 'PENDING'
      RETURNING t.id, t.not_before AS "notBefore"
    `);
  }

  /**
   * Enqueue a hand-built task, returning the row or null when the unique
   * (kind, dedupe_key) constraint already holds one. Same INSERT … ON CONFLICT
   * DO NOTHING as `enqueue`, because that constraint is the whole reason a
   * double upload is impossible; the caller turns null into a 409 naming the
   * existing task rather than silently doing nothing.
   */
  async createManual(
    kind: UploadTaskKind,
    dedupeKey: string,
    chapter: unknown,
    opts: { notBefore?: Date; maxAttempts?: number } = {},
  ): Promise<UploadTaskRow | null> {
    const rows = await this.prisma.$queryRaw<UploadTaskRow[]>(Prisma.sql`
      INSERT INTO upload_tasks (id, kind, dedupe_key, chapter, state, attempt, max_attempts,
                                not_before, created_at, updated_at)
      VALUES (${randomUUID()}, ${kind}::"UploadTaskKind", ${dedupeKey},
              ${JSON.stringify(chapter)}::jsonb, 'PENDING', 0,
              coalesce(${opts.maxAttempts ?? null}::int, 5),
              coalesce(${opts.notBefore ?? null}::timestamptz, now()), now(), now())
      ON CONFLICT (kind, dedupe_key) DO NOTHING
      RETURNING id, kind::text AS kind, dedupe_key AS "dedupeKey", state::text AS state,
                attempt, max_attempts AS "maxAttempts", not_before AS "notBefore",
                lease_id AS "leaseId", lease_expires_at AS "leaseExpiresAt",
                last_error AS "lastError", created_at AS "createdAt", updated_at AS "updatedAt"
    `);
    return rows[0] ?? null;
  }

  /**
   * Correct a task that has not run yet.
   *
   * `expectedUpdatedAt` is optimistic concurrency: the caller read the row to
   * merge a partial chapter patch and to derive the new dedupe key in the one
   * place that logic lives (`taskDedupeKey`), so the write pins the version it
   * read. Anything that touched the row in between — a claim, another edit, the
   * sweeper — leaves this at zero rows, which the caller reports as losing the
   * race instead of clobbering. Deriving the key in SQL instead would avoid the
   * read but would make the dedupe rule exist twice, in two languages.
   *
   * Throws P2002 on a dedupe-key collision; that is the unique constraint doing
   * its job and the caller turns it into a 409.
   */
  async patchPending(
    id: string,
    patch: {
      chapter: unknown;
      dedupeKey: string;
      notBefore?: Date;
      maxAttempts?: number;
      expectedUpdatedAt: Date;
    },
  ): Promise<boolean> {
    const res = await this.prisma.uploadTask.updateMany({
      where: { id, state: "PENDING", updatedAt: patch.expectedUpdatedAt },
      data: {
        chapter: patch.chapter as Prisma.InputJsonValue,
        dedupeKey: patch.dedupeKey,
        ...(patch.notBefore ? { notBefore: patch.notBefore } : {}),
        ...(patch.maxAttempts === undefined ? {} : { maxAttempts: patch.maxAttempts }),
      },
    });
    return res.count === 1;
  }
}

// ------------------------------------------------------------------ internals

/** Every column except `chapter`, aliased to the Prisma field names. */
const TASK_COLUMNS = Prisma.sql`t.id, t.kind::text AS kind, t.dedupe_key AS "dedupeKey",
  t.state::text AS state, t.attempt, t.max_attempts AS "maxAttempts",
  t.not_before AS "notBefore", t.lease_id AS "leaseId",
  t.lease_expires_at AS "leaseExpiresAt", t.last_error AS "lastError",
  t.created_at AS "createdAt", t.updated_at AS "updatedAt"`;

/**
 * Filter predicates, parameterised. The enum comparisons keep the enum type
 * (via text[] -> enum[]) rather than casting the column to text, so the
 * (state, not_before) index stays usable.
 */
function taskWhere(filter: UploadTaskFilter): Prisma.Sql[] {
  const parts: Prisma.Sql[] = [];
  if (filter.kinds && filter.kinds.length > 0) {
    parts.push(Prisma.sql`t.kind = ANY(${[...filter.kinds]}::text[]::"UploadTaskKind"[])`);
  }
  if (filter.states && filter.states.length > 0) {
    parts.push(Prisma.sql`t.state = ANY(${[...filter.states]}::text[]::"UploadTaskState"[])`);
  }
  // Parameterised, so a `%` an operator types is a wildcard they meant and a
  // quote is data either way.
  if (filter.dedupeKey) parts.push(Prisma.sql`t.dedupe_key ILIKE ${`%${filter.dedupeKey}%`}`);
  if (filter.attemptMin !== undefined) parts.push(Prisma.sql`t.attempt >= ${filter.attemptMin}`);
  if (filter.attemptMax !== undefined) parts.push(Prisma.sql`t.attempt <= ${filter.attemptMax}`);
  return parts;
}

function combine(parts: Prisma.Sql[]): Prisma.Sql {
  return parts.length > 0 ? Prisma.sql`WHERE ${Prisma.join(parts, " AND ")}` : Prisma.empty;
}
