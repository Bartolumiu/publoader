import { ErrorSource } from "@prisma/client";
import type { Job, Prisma, PrismaClient } from "@prisma/client";
import { workerLabel, workerNames } from "../store/workers.js";

/**
 * The merged error feed, and the acknowledgements that let an operator empty it.
 *
 * The feed answers "what is broken right now?" by merging three tables:
 * dead-lettered jobs, failed or dead-lettered upload tasks, and quarantined
 * result submissions. It was read-only, which made it a wall rather than a
 * to-do list: a failure that had been read, understood and fixed (an upstream
 * outage, a bad bundle since replaced) stayed at the top forever, and the only
 * way to tell "new" from "old and handled" was to remember.
 *
 * Clearing an entry records an acknowledgement in `cleared_errors` and the feed
 * stops showing it. Three properties are what make that safe:
 *
 *   - It hides, it does not delete. The job, task or submission is untouched, so
 *     the Activity feed, the run views and `padmin dead-letter` still show the
 *     failure, and a cleared entry can be listed again (`includeCleared`) or
 *     restored.
 *   - A repeat failure comes back. The acknowledgement records the timestamp the
 *     feed showed at the time; anything that fails again moves its own timestamp
 *     past that and reappears as new. Clearing acknowledges one failure, never a
 *     row (see `ClearedError.errorAt` in the schema).
 *   - Nothing else changes behaviour. Retry, requeue and drain all still see
 *     every row: this is a view filter, not a state transition.
 *
 * This module is the single implementation behind the API route, the dashboard,
 * the Discord bot and `padmin`, so the four surfaces cannot drift.
 */

/** The feed's own name for each source, used in `kind`, wire payloads and the CLI. */
export const ERROR_FEED_SOURCES = ["job", "upload-task", "submission"] as const;

export type ErrorFeedSource = (typeof ERROR_FEED_SOURCES)[number];

const SOURCE_TO_ENUM: Record<ErrorFeedSource, ErrorSource> = {
  job: ErrorSource.JOB,
  "upload-task": ErrorSource.UPLOAD_TASK,
  submission: ErrorSource.SUBMISSION,
};

const ENUM_TO_SOURCE: Record<ErrorSource, ErrorFeedSource> = {
  [ErrorSource.JOB]: "job",
  [ErrorSource.UPLOAD_TASK]: "upload-task",
  [ErrorSource.SUBMISSION]: "submission",
};

/**
 * How many acknowledgements are loaded to build the feed's exclusion filter.
 *
 * The filter is sent to Postgres as `NOT (id = … AND ts <= … OR …)`, so its size
 * is the number of live acknowledgements. That set is bounded in practice: it
 * only grows by an operator clearing something, and `pruneClearedErrors` (run on
 * every clear) drops the ones whose row no longer exists. The cap is a safety
 * valve for a pathological case, and it fails in the safe direction: the OLDEST
 * acknowledgements stop hiding their entries, so an entry reappears rather than
 * being lost.
 */
const MAX_ACKNOWLEDGEMENTS = 500;

/** Upper bound on a single "clear everything" so one call cannot be unbounded. */
export const MAX_CLEAR_ALL = 500;

/** Operator notes are a hint for the next reader, not a document. */
const MAX_NOTE_LENGTH = 500;

export interface ErrorFeedEntry {
  at: Date;
  /** `job:DEAD_LETTER`, `upload-task:FAILED`, `submission:QUARANTINED`. */
  kind: string;
  source: ErrorFeedSource;
  subject: string;
  message: string;
  id: string;
  /** Present only on entries that have been acknowledged. */
  cleared?: { at: Date; by: string; note: string | null };
}

/** One entry to clear or restore. */
export interface ErrorRef {
  source: ErrorFeedSource;
  id: string;
}

type Acknowledgement = {
  source: ErrorSource;
  subjectId: string;
  errorAt: Date;
  clearedAt: Date;
  clearedBy: string;
  note: string | null;
};

/**
 * Acknowledgements keyed by `source:id`, plus the per-source filter fragments
 * that exclude them from a query.
 */
class Acknowledgements {
  private readonly byKey = new Map<string, Acknowledgement>();

  constructor(rows: readonly Acknowledgement[]) {
    for (const row of rows) this.byKey.set(`${row.source}:${row.subjectId}`, row);
  }

  static async load(prisma: PrismaClient): Promise<Acknowledgements> {
    const rows = await prisma.clearedError.findMany({
      orderBy: { clearedAt: "desc" },
      take: MAX_ACKNOWLEDGEMENTS,
      select: { source: true, subjectId: true, errorAt: true, clearedAt: true, clearedBy: true, note: true },
    });
    return new Acknowledgements(rows);
  }

  get(source: ErrorFeedSource, id: string): Acknowledgement | undefined {
    return this.byKey.get(`${SOURCE_TO_ENUM[source]}:${id}`);
  }

  private forSource(source: ErrorFeedSource): Acknowledgement[] {
    const wanted = SOURCE_TO_ENUM[source];
    return [...this.byKey.values()].filter((row) => row.source === wanted);
  }

  /**
   * `NOT (this row is acknowledged and has not failed since)`, or `{}` when
   * nothing from this source is acknowledged.
   *
   * The timestamp compared is the column the feed shows as the failure time,
   * which is the one the acknowledgement was taken against: `updatedAt` for jobs
   * and upload tasks, `createdAt` for submissions. Submission rows never change,
   * so an acknowledged submission stays cleared; a fresh rejection from the same
   * worker is a fresh row with a fresh id.
   *
   * One method per model rather than a generic one over a column name: Prisma's
   * where-inputs are distinct types, and a shared version buys nothing but casts.
   */
  jobExclusion(): Prisma.JobWhereInput {
    const rows = this.forSource("job");
    if (rows.length === 0) return {};
    return { NOT: { OR: rows.map((row) => ({ id: row.subjectId, updatedAt: { lte: row.errorAt } })) } };
  }

  /**
   * The complement of `jobExclusion`: only jobs whose latest failure has been
   * acknowledged. Behind the "cleared only" view, and behind the count of what
   * the default view is hiding.
   *
   * With nothing acknowledged this must match NOTHING, so it cannot fall back to
   * `{}` the way the exclusions do: an empty `in` is the filter that is false for
   * every row rather than true for every row.
   */
  jobInclusion(): Prisma.JobWhereInput {
    const rows = this.forSource("job");
    if (rows.length === 0) return { id: { in: [] } };
    return { OR: rows.map((row) => ({ id: row.subjectId, updatedAt: { lte: row.errorAt } })) };
  }

  uploadTaskExclusion(): Prisma.UploadTaskWhereInput {
    const rows = this.forSource("upload-task");
    if (rows.length === 0) return {};
    return { NOT: { OR: rows.map((row) => ({ id: row.subjectId, updatedAt: { lte: row.errorAt } })) } };
  }

  submissionExclusion(): Prisma.ResultSubmissionWhereInput {
    const rows = this.forSource("submission");
    if (rows.length === 0) return {};
    return { NOT: { OR: rows.map((row) => ({ id: row.subjectId, createdAt: { lte: row.errorAt } })) } };
  }

  /** The complement of `submissionExclusion`; see `jobInclusion` on the empty case. */
  submissionInclusion(): Prisma.ResultSubmissionWhereInput {
    const rows = this.forSource("submission");
    if (rows.length === 0) return { id: { in: [] } };
    return { OR: rows.map((row) => ({ id: row.subjectId, createdAt: { lte: row.errorAt } })) };
  }
}

/** `[extension] segment 2/4`-style subject lines, one per source. */
function jobSubject(job: { extension: string; segmentIndex: number; segmentTotal: number }): string {
  return `${job.extension} · segment ${job.segmentIndex + 1}/${job.segmentTotal}`;
}

export interface ListErrorsOptions {
  limit: number;
  /**
   * Show acknowledged entries too, annotated with who cleared them and when.
   * This is the "what did we already deal with?" view; the default feed is the
   * to-do list.
   */
  includeCleared?: boolean;
  /** Only acknowledged entries: the review list behind the dashboard's toggle. */
  clearedOnly?: boolean;
}

/**
 * The feed, newest first.
 *
 * Every source is queried at the full `limit` before merging: splitting the
 * budget between them would hide a burst in one source behind old rows from
 * another. `FAILED` exists on upload tasks but not on jobs (a job that exhausts
 * its attempts goes straight to `DEAD_LETTER`), which is why the two halves
 * filter on different state sets.
 */
export async function listErrors(
  prisma: PrismaClient,
  options: ListErrorsOptions,
): Promise<{ errors: ErrorFeedEntry[]; clearedHidden: number }> {
  const acks = await Acknowledgements.load(prisma);
  const showAll = options.includeCleared === true || options.clearedOnly === true;

  const [jobs, tasks, submissions] = await Promise.all([
    prisma.job.findMany({
      where: { state: "DEAD_LETTER", ...(showAll ? {} : acks.jobExclusion()) },
      orderBy: { updatedAt: "desc" },
      take: options.limit,
      select: {
        id: true,
        runId: true,
        extension: true,
        state: true,
        segmentIndex: true,
        segmentTotal: true,
        errorClass: true,
        lastError: true,
        updatedAt: true,
      },
    }),
    prisma.uploadTask.findMany({
      where: {
        state: { in: ["FAILED", "DEAD_LETTER"] },
        ...(showAll ? {} : acks.uploadTaskExclusion()),
      },
      orderBy: { updatedAt: "desc" },
      take: options.limit,
      select: { id: true, kind: true, state: true, dedupeKey: true, lastError: true, updatedAt: true },
    }),
    prisma.resultSubmission.findMany({
      where: { state: "QUARANTINED", ...(showAll ? {} : acks.submissionExclusion()) },
      orderBy: { createdAt: "desc" },
      take: options.limit,
      select: { id: true, jobId: true, workerId: true, rejectReason: true, createdAt: true },
    }),
  ]);

  const workerNameById = await workerNames(
    prisma,
    submissions.map((submission) => submission.workerId),
  );

  const entries: ErrorFeedEntry[] = [
    ...jobs.map((job) => ({
      at: job.updatedAt,
      kind: `job:${job.state}`,
      source: "job" as const,
      subject: jobSubject(job),
      message: job.errorClass ? `[${job.errorClass}] ${job.lastError ?? ""}` : (job.lastError ?? ""),
      id: job.id,
    })),
    ...tasks.map((task) => ({
      at: task.updatedAt,
      kind: `upload-task:${task.state}`,
      source: "upload-task" as const,
      subject: `${task.kind} · ${task.dedupeKey}`,
      message: task.lastError ?? "",
      id: task.id,
    })),
    ...submissions.map((submission) => ({
      at: submission.createdAt,
      kind: "submission:QUARANTINED",
      source: "submission" as const,
      subject: `worker ${workerLabel(submission.workerId, workerNameById)} · job ${submission.jobId}`,
      message: submission.rejectReason ?? "",
      id: submission.id,
    })),
  ];

  // Annotate rather than re-filter: the queries above already excluded cleared
  // entries unless they were asked for, and an entry whose acknowledgement is
  // older than its latest failure is deliberately shown as outstanding.
  const annotated = entries.map((entry) => {
    const ack = acks.get(entry.source, entry.id);
    if (!ack || ack.errorAt < entry.at) return entry;
    return { ...entry, cleared: { at: ack.clearedAt, by: ack.clearedBy, note: ack.note } };
  });

  const visible = options.clearedOnly ? annotated.filter((entry) => entry.cleared) : annotated;

  return {
    errors: visible.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, options.limit),
    clearedHidden: showAll ? 0 : await countCleared(prisma),
  };
}

/**
 * How many acknowledged entries the default feed is hiding, so a caller can say
 * "nothing outstanding (4 cleared)" instead of implying the platform has been
 * quiet. Counted from the acknowledgement table, whose rows are pruned when
 * their subject disappears.
 */
async function countCleared(prisma: PrismaClient): Promise<number> {
  return prisma.clearedError.count();
}

/**
 * Outstanding entries, for the dashboard's nav badge and `/stats`.
 *
 * Counts rather than lists, and applies the same exclusion the feed does; a
 * badge that kept counting failures an operator had already cleared would train
 * them to ignore the badge.
 */
export async function countOutstandingErrors(prisma: PrismaClient): Promise<{
  total: number;
  jobs: number;
  uploadTasks: number;
  submissions: number;
}> {
  const acks = await Acknowledgements.load(prisma);
  const [jobs, uploadTasks, submissions] = await Promise.all([
    prisma.job.count({ where: { state: "DEAD_LETTER", ...acks.jobExclusion() } }),
    prisma.uploadTask.count({
      where: { state: { in: ["FAILED", "DEAD_LETTER"] }, ...acks.uploadTaskExclusion() },
    }),
    prisma.resultSubmission.count({ where: { state: "QUARANTINED", ...acks.submissionExclusion() } }),
  ]);
  return { total: jobs + uploadTasks + submissions, jobs, uploadTasks, submissions };
}

/**
 * Which acknowledged rows a listing wants: the default to-do list, the full
 * record, or only what has been dealt with.
 *
 * Shared by the error feed, the dead-letter queue and the quarantine so the
 * three surfaces answer the same question the same way. They used to disagree:
 * clearing an entry emptied the feed while the dead-letter tab, the quarantine
 * card, `padmin dead-letter` and the overview's job-state tile went on
 * reporting the same failures, so "I have dealt with these" was true on one
 * page and false on four.
 */
export type ClearedView = "without" | "with" | "only";

/** The quarantine listing's row: the submission plus the worker's display name. */
export interface QuarantinedSubmission {
  id: string;
  jobId: string;
  workerId: string | null;
  rejectReason: string | null;
  createdAt: Date;
  workerName: string | null;
}

/**
 * The dead-letter queue, on the feed's terms.
 *
 * The same rows as before — nothing is deleted and no state changes — but an
 * acknowledged job drops out of the default listing, and `clearedHidden` says
 * how many, so the queue can never look empty by accident. Replay still reaches
 * every row: `cleared: "with"` lists them, and retry never consulted this filter
 * in the first place.
 */
export async function listDeadLetterJobs(
  prisma: PrismaClient,
  options: { limit: number; cleared?: ClearedView },
): Promise<{ jobs: (Job & { cleared?: ErrorFeedEntry["cleared"] })[]; clearedHidden: number }> {
  const view = options.cleared ?? "without";
  const acks = await Acknowledgements.load(prisma);
  const ackFilter = view === "without" ? acks.jobExclusion() : view === "only" ? acks.jobInclusion() : {};

  const [jobs, clearedHidden] = await Promise.all([
    prisma.job.findMany({
      where: { state: "DEAD_LETTER", ...ackFilter },
      orderBy: { updatedAt: "desc" },
      take: options.limit,
    }),
    view === "without"
      ? prisma.job.count({ where: { state: "DEAD_LETTER", ...acks.jobInclusion() } })
      : Promise.resolve(0),
  ]);

  // Annotated on the rule the feed uses: an acknowledgement older than the row's
  // latest failure is stale, and the row reads as outstanding again.
  return {
    jobs: jobs.map((job) => {
      const ack = acks.get("job", job.id);
      if (!ack || ack.errorAt < job.updatedAt) return job;
      return { ...job, cleared: { at: ack.clearedAt, by: ack.clearedBy, note: ack.note } };
    }),
    clearedHidden,
  };
}

/**
 * Quarantined submissions, on the same terms as `listDeadLetterJobs`.
 *
 * A submission row never changes, so an acknowledged quarantine stays cleared: a
 * fresh rejection from the same worker arrives as a new row with a new id, and
 * shows up outstanding.
 */
export async function listQuarantinedSubmissions(
  prisma: PrismaClient,
  options: { limit: number; cleared?: ClearedView },
): Promise<{
  quarantined: (QuarantinedSubmission & { cleared?: ErrorFeedEntry["cleared"] })[];
  clearedHidden: number;
}> {
  const view = options.cleared ?? "without";
  const acks = await Acknowledgements.load(prisma);
  const ackFilter =
    view === "without" ? acks.submissionExclusion() : view === "only" ? acks.submissionInclusion() : {};

  const [rows, clearedHidden] = await Promise.all([
    prisma.resultSubmission.findMany({
      where: { state: "QUARANTINED", ...ackFilter },
      orderBy: { createdAt: "desc" },
      take: options.limit,
      select: { id: true, jobId: true, workerId: true, rejectReason: true, createdAt: true },
    }),
    view === "without"
      ? prisma.resultSubmission.count({ where: { state: "QUARANTINED", ...acks.submissionInclusion() } })
      : Promise.resolve(0),
  ]);

  const names = await workerNames(
    prisma,
    rows.map((row) => row.workerId),
  );

  return {
    quarantined: rows.map((row) => {
      const named = { ...row, workerName: row.workerId ? (names.get(row.workerId) ?? null) : null };
      const ack = acks.get("submission", row.id);
      if (!ack || ack.errorAt < row.createdAt) return named;
      return { ...named, cleared: { at: ack.clearedAt, by: ack.clearedBy, note: ack.note } };
    }),
    clearedHidden,
  };
}

/** What a clear or restore did, per entry, so a caller can report honestly. */
export interface ClearResult {
  cleared: ErrorRef[];
  /** Refs that named nothing currently in the feed, with why. */
  skipped: { source: ErrorFeedSource | null; id: string; reason: string }[];
  /** Acknowledgements dropped because their row no longer exists. */
  pruned: number;
}

/**
 * Shortest id prefix accepted. Long enough that a prefix is a deliberate
 * shorthand rather than a slip that could match half the table, and the tables
 * that print truncated ids print eight characters.
 */
const MIN_ID_PREFIX = 4;

/** One candidate row, always carrying the FULL id whatever was typed. */
interface Match {
  source: ErrorFeedSource;
  id: string;
  errorAt: Date;
}

/**
 * Rows from one source whose id starts with `idOrPrefix` and which are currently
 * failing.
 *
 * Two things are deliberate here. The state filters are the same ones the feed
 * uses, so clearing something that is NOT failing is a reported no-op rather
 * than a silent write: acknowledging a healthy row would hide its NEXT failure.
 * And matching is by prefix, because every surface that lists errors prints
 * truncated ids: Discord, `padmin errors`, the dashboard's short columns. An
 * operator reading `3f9a1c2b` off a table should be able to type it.
 *
 * `take: 2` is enough: one match resolves, two means ambiguous, and which two
 * does not change the answer.
 */
async function matchSource(
  prisma: PrismaClient,
  source: ErrorFeedSource,
  idOrPrefix: string,
): Promise<Match[]> {
  if (source === "job") {
    const rows = await prisma.job.findMany({
      where: { id: { startsWith: idOrPrefix }, state: "DEAD_LETTER" },
      select: { id: true, updatedAt: true },
      take: 2,
    });
    return rows.map((row) => ({ source, id: row.id, errorAt: row.updatedAt }));
  }
  if (source === "upload-task") {
    const rows = await prisma.uploadTask.findMany({
      where: { id: { startsWith: idOrPrefix }, state: { in: ["FAILED", "DEAD_LETTER"] } },
      select: { id: true, updatedAt: true },
      take: 2,
    });
    return rows.map((row) => ({ source, id: row.id, errorAt: row.updatedAt }));
  }
  const rows = await prisma.resultSubmission.findMany({
    where: { id: { startsWith: idOrPrefix }, state: "QUARANTINED" },
    select: { id: true, createdAt: true },
    take: 2,
  });
  return rows.map((row) => ({ source, id: row.id, errorAt: row.createdAt }));
}

/**
 * Resolve an id or prefix, optionally narrowed to one source.
 *
 * Without a source all three tables are asked, because typing
 * `padmin errors clear <id>` or `/errors clear id:<id>` should not require the
 * operator to first classify what kind of thing failed. Ambiguity (a prefix
 * matching two rows, or one id present in two sources) is reported, never
 * guessed: clearing the wrong entry hides a failure nobody has looked at.
 */
async function resolveMatch(
  prisma: PrismaClient,
  idOrPrefix: string,
  source?: ErrorFeedSource,
): Promise<Match | { error: string }> {
  if (idOrPrefix.length < MIN_ID_PREFIX) {
    return { error: `id must be at least ${MIN_ID_PREFIX} characters (a full id or a leading prefix)` };
  }
  const sources = source ? [source] : ERROR_FEED_SOURCES;
  const found: Match[] = [];
  for (const candidate of sources) found.push(...(await matchSource(prisma, candidate, idOrPrefix)));

  if (found.length === 0) {
    return {
      error: source
        ? `no ${source} matching this id is currently failing`
        : "nothing currently failing matches this id",
    };
  }
  if (found.length > 1) {
    const detail = found.map((match) => `${match.source} ${match.id.slice(0, 8)}`).join(", ");
    return { error: `ambiguous: matches ${detail}; use a longer id` };
  }
  return found[0]!;
}

export interface ClearOptions {
  actor: string;
  /** Explicit entries. Either these, `ids`, or `all` must be given. */
  refs?: readonly ErrorRef[];
  /** Bare ids, resolved against all three sources. */
  ids?: readonly string[];
  /** Clear everything currently outstanding, up to `MAX_CLEAR_ALL`. */
  all?: boolean;
  note?: string | null;
}

/**
 * Acknowledge failures.
 *
 * Idempotent per entry: clearing an already-cleared entry refreshes the
 * acknowledgement against the row's current timestamp, which is the behaviour a
 * retry loop wants ("I looked again, still fine to hide").
 */
export async function clearErrors(prisma: PrismaClient, options: ClearOptions): Promise<ClearResult> {
  const note = options.note?.trim() ? options.note.trim().slice(0, MAX_NOTE_LENGTH) : null;
  const resolved: { ref: ErrorRef; errorAt: Date }[] = [];
  const skipped: ClearResult["skipped"] = [];

  if (options.all) {
    // The outstanding feed IS the list to clear, so it is read through the same
    // path the operator was looking at; clearing cannot acknowledge something
    // they could not see.
    const { errors } = await listErrors(prisma, { limit: MAX_CLEAR_ALL });
    for (const entry of errors) resolved.push({ ref: { source: entry.source, id: entry.id }, errorAt: entry.at });
  }

  for (const ref of options.refs ?? []) {
    const match = await resolveMatch(prisma, ref.id, ref.source);
    if ("error" in match) {
      skipped.push({ source: ref.source, id: ref.id, reason: match.error });
      continue;
    }
    resolved.push({ ref: { source: match.source, id: match.id }, errorAt: match.errorAt });
  }

  for (const id of options.ids ?? []) {
    const match = await resolveMatch(prisma, id);
    if ("error" in match) {
      skipped.push({ source: null, id, reason: match.error });
      continue;
    }
    resolved.push({ ref: { source: match.source, id: match.id }, errorAt: match.errorAt });
  }

  // De-duplicate: `all` plus an explicit ref, or the same id twice, would
  // otherwise upsert the same key twice inside one transaction.
  const unique = new Map<string, { ref: ErrorRef; errorAt: Date }>();
  for (const item of resolved) unique.set(`${item.ref.source}:${item.ref.id}`, item);

  if (unique.size > 0) {
    await prisma.$transaction(
      [...unique.values()].map(({ ref, errorAt }) =>
        prisma.clearedError.upsert({
          where: { source_subjectId: { source: SOURCE_TO_ENUM[ref.source], subjectId: ref.id } },
          create: {
            source: SOURCE_TO_ENUM[ref.source],
            subjectId: ref.id,
            errorAt,
            clearedBy: options.actor.slice(0, 256),
            note,
          },
          update: { errorAt, clearedAt: new Date(), clearedBy: options.actor.slice(0, 256), note },
        }),
      ),
    );
  }

  return {
    cleared: [...unique.values()].map((item) => item.ref),
    skipped,
    pruned: await pruneClearedErrors(prisma),
  };
}

export interface RestoreOptions {
  refs?: readonly ErrorRef[];
  ids?: readonly string[];
  /** Un-clear everything, putting every acknowledged entry back in the feed. */
  all?: boolean;
}

/**
 * Put cleared entries back in the feed.
 *
 * The undo for a fat-fingered "clear all", and the way to re-open something that
 * turned out not to be fixed. Unlike clearing, this does not check the subject's
 * state: deleting an acknowledgement is safe whatever the row is doing, and
 * refusing to delete one because its row healed would leave un-deletable rows.
 */
export async function restoreErrors(
  prisma: PrismaClient,
  options: RestoreOptions,
): Promise<{ restored: number }> {
  if (options.all) {
    const { count } = await prisma.clearedError.deleteMany({});
    return { restored: count };
  }

  // Ids match by prefix here too, for the same reason as clearing: the tables an
  // operator reads them off are truncated. A prefix that matches two
  // acknowledgements restores both, which is the safe direction to be wrong in:
  // restoring shows a failure again, it never hides one.
  const usable = (id: string) => id.length >= MIN_ID_PREFIX;
  const conditions: Prisma.ClearedErrorWhereInput[] = [
    ...(options.refs ?? [])
      .filter((ref) => usable(ref.id))
      .map((ref) => ({ source: SOURCE_TO_ENUM[ref.source], subjectId: { startsWith: ref.id } })),
    // No source needed: the acknowledgement row holds it already, so "forget
    // whatever was cleared under this id" needs no probing of the three tables.
    ...(options.ids ?? []).filter(usable).map((id) => ({ subjectId: { startsWith: id } })),
  ];
  if (conditions.length === 0) return { restored: 0 };

  const { count } = await prisma.clearedError.deleteMany({ where: { OR: conditions } });
  return { restored: count };
}

/**
 * Drop acknowledgements whose subject no longer exists.
 *
 * Rows do disappear (upload tasks are deleted once drained, and a purge takes
 * jobs with it), and a stranded acknowledgement is dead weight in the exclusion
 * filter every feed read builds. Cheap enough (three anti-joins over a table
 * with tens of rows) to run on every clear, which is the only thing that grows
 * it.
 */
export async function pruneClearedErrors(prisma: PrismaClient): Promise<number> {
  const deleted = await prisma.$executeRaw`
    DELETE FROM cleared_errors c
    WHERE (c.source = 'JOB' AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = c.subject_id))
       OR (c.source = 'UPLOAD_TASK' AND NOT EXISTS (SELECT 1 FROM upload_tasks t WHERE t.id = c.subject_id))
       OR (c.source = 'SUBMISSION' AND NOT EXISTS (SELECT 1 FROM result_submissions r WHERE r.id = c.subject_id))
  `;
  return deleted;
}

/** Every acknowledgement, newest first: the audit-ish "what did we mute?" list. */
export async function listClearedErrors(
  prisma: PrismaClient,
  limit: number,
): Promise<{ source: ErrorFeedSource; id: string; errorAt: Date; clearedAt: Date; clearedBy: string; note: string | null }[]> {
  const rows = await prisma.clearedError.findMany({
    orderBy: { clearedAt: "desc" },
    take: limit,
  });
  return rows.map((row) => ({
    source: ENUM_TO_SOURCE[row.source],
    id: row.subjectId,
    errorAt: row.errorAt,
    clearedAt: row.clearedAt,
    clearedBy: row.clearedBy,
    note: row.note,
  }));
}
