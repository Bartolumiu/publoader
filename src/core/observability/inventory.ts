import { JobState, ResultState, RunState, UploadTaskKind, UploadTaskState, WorkerStatus } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { metrics } from "../../metrics.js";
import { countOutstandingErrors } from "./errorFeed.js";

/**
 * The database-derived gauges: queue depths, backlog ages, table growth.
 *
 * Two rules make these safe to alert on.
 *
 * 1. Every label value is seeded to 0 before the counts are applied. A
 *    `groupBy` returns no row for a state with no rows, so without seeding a
 *    depth gauge would either keep its last value forever (a queue that
 *    drained still reading 50) or be absent entirely (an alert on
 *    `> 0` that can never fire because the series does not exist).
 * 2. The reads happen first and the gauges are written synchronously
 *    afterwards, so a scrape can never catch the registry mid-update with a
 *    reset-to-zero it should not see.
 *
 * Called from the scheduler service loop: it is the process that already ticks
 * on a fixed interval, and it is the one place all of this is visible from.
 */

/** Table-size accounting is the only read here that is not O(1); throttle it. */
const ARTIFACT_SCAN_INTERVAL_MS = 300_000;
let lastArtifactScanMs = 0;

interface ArtifactSizeRow {
  rows: bigint | number;
  bytes: bigint | number;
}

function ageSeconds(from: Date | null | undefined, now: Date): number {
  if (!from) return 0;
  return Math.max(0, (now.getTime() - from.getTime()) / 1000);
}

export async function collectInventoryMetrics(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<void> {
  const [
    jobStates,
    workerStates,
    runStates,
    resultStates,
    uploadTasks,
    oldestPending,
    oldestIngesting,
    outstandingErrors,
  ] = await Promise.all([
    prisma.job.groupBy({ by: ["state"], _count: true }),
    prisma.worker.groupBy({ by: ["status"], _count: true }),
    prisma.run.groupBy({ by: ["state"], _count: true }),
    prisma.resultSubmission.groupBy({ by: ["state"], _count: true }),
    prisma.uploadTask.groupBy({ by: ["kind", "state"], _count: true }),
    // "Due" matters: a job whose notBefore is in the future is waiting on
    // backoff by design and is not a backlog.
    prisma.job.aggregate({
      _min: { createdAt: true },
      where: { state: JobState.PENDING, notBefore: { lte: now } },
    }),
    prisma.run.aggregate({
      _min: { updatedAt: true },
      where: { state: RunState.INGESTING },
    }),
    // The acknowledgement-aware counts, so the dead-letter depth has an
    // alertable twin an operator can actually drive back to zero.
    countOutstandingErrors(prisma),
  ]);

  metrics.jobQueueDepth.reset();
  for (const state of Object.values(JobState)) metrics.jobQueueDepth.set({ state }, 0);
  let deadLetter = 0;
  for (const row of jobStates) {
    metrics.jobQueueDepth.set({ state: row.state }, row._count);
    if (row.state === JobState.DEAD_LETTER) deadLetter = row._count;
  }
  metrics.deadLetterJobs.set(deadLetter);
  metrics.deadLetterJobsOutstanding.set(outstandingErrors.jobs);

  metrics.workersByStatus.reset();
  for (const status of Object.values(WorkerStatus)) metrics.workersByStatus.set({ status }, 0);
  for (const row of workerStates) metrics.workersByStatus.set({ status: row.status }, row._count);

  metrics.runsByState.reset();
  for (const state of Object.values(RunState)) metrics.runsByState.set({ state }, 0);
  for (const row of runStates) metrics.runsByState.set({ state: row.state }, row._count);

  metrics.resultSubmissions.reset();
  for (const state of Object.values(ResultState)) metrics.resultSubmissions.set({ state }, 0);
  for (const row of resultStates) metrics.resultSubmissions.set({ state: row.state }, row._count);

  metrics.uploadTasks.reset();
  for (const kind of Object.values(UploadTaskKind)) {
    for (const state of Object.values(UploadTaskState)) {
      metrics.uploadTasks.set({ kind, state }, 0);
    }
  }
  for (const row of uploadTasks) {
    metrics.uploadTasks.set({ kind: row.kind, state: row.state }, row._count);
  }

  metrics.oldestPendingJobAgeSeconds.set(ageSeconds(oldestPending._min.createdAt, now));
  metrics.oldestIngestingRunAgeSeconds.set(ageSeconds(oldestIngesting._min.updatedAt, now));

  if (now.getTime() - lastArtifactScanMs >= ARTIFACT_SCAN_INTERVAL_MS) {
    lastArtifactScanMs = now.getTime();
    // pg_total_relation_size is catalogue arithmetic (O(1)) and counts TOAST,
    // which is where artifact bodies actually live; SUM(size) would miss the
    // compression and per-row overhead that fills the disk.
    const rows = await prisma.$queryRawUnsafe<ArtifactSizeRow[]>(
      `SELECT count(*) AS rows, pg_total_relation_size('artifacts') AS bytes FROM artifacts`,
    );
    const row = rows[0];
    if (row) {
      metrics.artifactRows.set(Number(row.rows));
      metrics.artifactBytes.set(Number(row.bytes));
    }
  }
}

/** Tests only: forget the throttle so the artifact read happens again. */
export function resetInventoryThrottleForTests(): void {
  lastArtifactScanMs = 0;
}
