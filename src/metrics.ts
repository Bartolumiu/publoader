import client from "prom-client";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

const c = (name: string, help: string, labelNames: string[] = []) => {
  const counter = new client.Counter({ name, help, labelNames, registers: [registry] });
  return counter;
};
const g = (name: string, help: string, labelNames: string[] = []) => {
  const gauge = new client.Gauge({ name, help, labelNames, registers: [registry] });
  return gauge;
};
const h = (name: string, help: string, labelNames: string[] = [], buckets?: number[]) => {
  const hist = new client.Histogram({ name, help, labelNames, registers: [registry], buckets });
  return hist;
};

/**
 * A "seconds since last tick" gauge set by the ticking process itself cannot
 * report the failure it exists to report: written as `set(0)` at the top of
 * every tick it reads 0 while the scheduler is healthy, and reads 0 forever
 * once the loop wedges, because the only code that could raise it is the code
 * that stopped running.
 *
 * Recording the tick's timestamp instead moves the subtraction to the scraper,
 * which is still running when the scheduler is not:
 *
 *   time() - publoader_scheduler_last_tick_timestamp_seconds > 120
 *
 * A frozen gauge now ages, and `absent()` covers the process being gone.
 */
export const metrics = {
  jobsCreated: c("publoader_jobs_created_total", "Jobs created", ["extension", "kind"]),
  jobsLeased: c("publoader_jobs_leased_total", "Jobs leased", ["extension"]),
  jobsSucceeded: c("publoader_jobs_succeeded_total", "Jobs succeeded", ["extension"]),
  jobsRequeued: c("publoader_jobs_requeued_total", "Jobs requeued for retry", ["extension", "reason"]),
  jobsDeadLettered: c("publoader_jobs_dead_letter_total", "Jobs dead-lettered", ["extension"]),
  leaseExpiries: c("publoader_lease_expiries_total", "Leases expired by sweeper", ["extension"]),
  envelopesReceived: c("publoader_envelopes_received_total", "Result envelopes received", ["extension"]),
  envelopesQuarantined: c("publoader_envelopes_quarantined_total", "Envelopes quarantined", ["extension", "reason"]),
  envelopesSuperseded: c("publoader_envelopes_superseded_total", "Late/duplicate envelopes superseded", ["extension"]),
  envelopesCommitted: c("publoader_envelopes_committed_total", "Envelopes committed", ["extension"]),
  uploadsTotal: c("publoader_md_uploads_total", "MangaDex upload attempts", ["outcome"]),
  uploadTasks: g("publoader_upload_tasks", "Upload task queue depth", ["kind", "state"]),
  jobQueueDepth: g("publoader_job_queue_depth", "Job queue depth", ["state"]),
  workersByStatus: g("publoader_workers", "Workers by status", ["status"]),
  schedulerLastTick: g(
    "publoader_scheduler_last_tick_timestamp_seconds",
    "Unix timestamp of the last COMPLETED scheduler tick (see markSchedulerTick)",
  ),
  /**
   * REMOVED from the registry, kept as a no-op so the one remaining call site
   * (`core/scheduler/service.ts` tick()) still compiles. Nothing is exported
   * under `publoader_scheduler_lag_seconds` any more, so it cannot mislead a
   * scrape. Delete this together with that call; see the note above.
   */
  runsByState: g("publoader_runs", "Runs by state", ["state"]),
  /**
   * Runs that reached INGESTING and stopped moving. INGESTING means "all jobs
   * reported, waiting for core-processor", so a rising age here is the
   * signature of a processor that is down, paused, or stuck on MangaDex.
   */
  oldestIngestingRunAgeSeconds: g(
    "publoader_oldest_ingesting_run_age_seconds",
    "Age of the longest-waiting run in INGESTING (0 when there are none)",
  ),
  /**
   * Depth, not the `publoader_jobs_dead_letter_total` counter. A counter says
   * "this happened"; only a depth says "this is still sitting there unfixed",
   * and unlabelled so the series is always present for alerting even at zero.
   */
  deadLetterJobs: g("publoader_dead_letter_jobs", "Jobs currently in DEAD_LETTER"),
  oldestPendingJobAgeSeconds: g(
    "publoader_oldest_pending_job_age_seconds",
    "Age of the oldest PENDING job that is already due (0 when the queue is empty)",
  ),
  resultSubmissions: g("publoader_result_submissions", "Result submissions by state", ["state"]),
  artifactRows: g("publoader_artifact_rows", "Rows in the artifacts table"),
  artifactBytes: g(
    "publoader_artifact_bytes",
    "On-disk size of the artifacts table including TOAST and indexes",
  ),
  jobDuration: h(
    "publoader_job_duration_seconds",
    "Job execution duration (lease to submit)",
    ["extension"],
    [10, 30, 60, 120, 300, 600, 1800, 3600],
  ),
};

/**
 * Record that a scheduler tick finished. Call it AFTER the tick returns, never
 * before: the value must mean "work completed at this time", otherwise a tick
 * that throws every time still looks like a healthy clock.
 */
export function markSchedulerTick(at: Date = new Date()): void {
  metrics.schedulerLastTick.set(at.getTime() / 1000);
}

export async function renderMetrics(): Promise<string> {
  return registry.metrics();
}
