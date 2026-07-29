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
  schedulerLagSeconds: g("publoader_scheduler_lag_seconds", "Seconds since last scheduler tick"),
  jobDuration: h(
    "publoader_job_duration_seconds",
    "Job execution duration (lease to submit)",
    ["extension"],
    [10, 30, 60, 120, 300, 600, 1800, 3600],
  ),
};

export async function renderMetrics(): Promise<string> {
  return registry.metrics();
}
