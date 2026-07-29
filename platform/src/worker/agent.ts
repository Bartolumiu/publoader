import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "../logging.js";
import type { Config } from "../config.js";
import type { ResultEnvelope } from "../contracts/envelope.js";
import { resultIdempotencyKey } from "../contracts/envelope.js";
import {
  CoreApiClient,
  CoreApiError,
  isLeaseIdle,
  type LeaseGrant,
  type LeasedJob,
} from "./coreApi.js";
import { BundleCache } from "./bundleCache.js";
import { CredentialStore, ensureCredentials, type WorkerCredentials } from "./credentials.js";
import { JobCancelledError, JobExecutor } from "./executor.js";

const HEARTBEAT_INTERVAL_MS = 60_000;
/** How long to idle after the core says we're drained or paused. */
const DRAINED_SLEEP_MS = 60_000;
const LEASE_ERROR_BASE_MS = 2_000;
const LEASE_ERROR_MAX_MS = 60_000;
/** Never renew less often than this, however short the TTL. */
const MIN_RENEW_INTERVAL_MS = 5_000;

/**
 * Credentials were rejected. Nothing the agent can do about it — the operator
 * must revoke and re-enroll — so this always ends the process.
 */
export class FatalAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalAuthError";
  }
}

export interface WorkerAgentOptions {
  config: Config;
  log: Logger;
  /** Narrows what this worker will lease; must be a subset of what it enrolled with. */
  extensions?: string[];
}

/**
 * The worker-side main loop.
 *
 * Exactly one job runs at a time, by design: extension scrapers hammer a
 * single upstream site each and are rate-limit sensitive, so parallelism on
 * one host buys throughput the sites will not tolerate. Scale out by running
 * more worker hosts, not more slots per host.
 */
export class WorkerAgent {
  private readonly config: Config;
  private readonly log: Logger;
  private readonly extensions: string[] | undefined;
  private readonly api: CoreApiClient;
  private readonly store: CredentialStore;
  private readonly bundles: BundleCache;
  private readonly executor: JobExecutor;

  private credentials: WorkerCredentials | null = null;
  private stopping = false;
  private leaseAbort: AbortController | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private fatal: Error | null = null;

  constructor(opts: WorkerAgentOptions) {
    this.config = opts.config;
    this.log = opts.log;
    this.extensions = opts.extensions;
    this.api = new CoreApiClient({
      ...(this.config.coreUrl ? { baseUrl: this.config.coreUrl } : {}),
      ...(this.config.workerToken ? { token: this.config.workerToken } : {}),
    });
    this.store = new CredentialStore(this.config.workerStatePath);
    this.bundles = new BundleCache(this.config.workerStatePath, this.api, this.log);
    this.executor = new JobExecutor(this.api, this.bundles, this.config, this.log);
  }

  /** Stop leasing new work; the job in flight is allowed to finish. */
  requestShutdown(signal: string): void {
    if (this.stopping) return;
    this.stopping = true;
    this.log.info({ signal }, "shutdown requested; finishing current job then exiting");
    this.leaseAbort?.abort("shutdown");
  }

  async run(): Promise<void> {
    this.credentials = await ensureCredentials({
      config: this.config,
      api: this.api,
      store: this.store,
      log: this.log,
      ...(this.extensions ? { extensions: this.extensions } : {}),
    });
    this.startHeartbeat();

    let consecutiveLeaseErrors = 0;
    try {
      while (!this.stopping && this.fatal === null) {
        let outcome;
        try {
          this.leaseAbort = new AbortController();
          outcome = await this.api.lease({
            ...(this.extensions ? { extensions: this.extensions } : {}),
            waitSeconds: this.config.leasePollWaitSeconds,
            signal: this.leaseAbort.signal,
          });
          consecutiveLeaseErrors = 0;
        } catch (err) {
          if (this.stopping) break;
          if (err instanceof CoreApiError && err.isAuth) {
            throw new FatalAuthError(`core rejected our credentials on lease: ${err.message}`);
          }
          consecutiveLeaseErrors += 1;
          const delay = Math.min(
            LEASE_ERROR_MAX_MS,
            LEASE_ERROR_BASE_MS * 2 ** Math.min(consecutiveLeaseErrors - 1, 6),
          );
          this.log.error({ err, consecutiveLeaseErrors, delay }, "lease poll failed; backing off");
          await sleep(delay);
          continue;
        } finally {
          this.leaseAbort = null;
        }

        if (isLeaseIdle(outcome)) {
          if (outcome.drained) {
            this.log.info("worker is drained or paused; idling");
            await sleep(DRAINED_SLEEP_MS);
          }
          continue;
        }

        await this.handleJob(outcome);
      }
    } finally {
      this.stopHeartbeat();
    }

    if (this.fatal) throw this.fatal;
    this.log.info("worker agent stopped");
  }

  private startHeartbeat(): void {
    const beat = () => {
      this.api.heartbeat().catch((err: unknown) => {
        if (err instanceof CoreApiError && err.isAuth) {
          this.recordFatal(new FatalAuthError(`core rejected our credentials: ${err.message}`));
          return;
        }
        this.log.warn({ err }, "heartbeat failed");
      });
    };
    this.heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
    beat();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private recordFatal(err: Error): void {
    if (this.fatal) return;
    this.fatal = err;
    this.log.fatal({ err }, "unrecoverable worker error; stopping");
    this.leaseAbort?.abort("fatal");
  }

  private async handleJob(grant: LeaseGrant): Promise<void> {
    const job = grant.job;
    const log = this.log.child({
      jobId: job.jobId,
      runId: job.runId,
      extension: job.extension,
      attempt: job.attempt,
      segmentKey: job.segmentKey,
    });
    log.info({ kind: job.kind, bundleSha256: job.bundleSha256 }, "job leased");

    try {
      await this.api.startJob(job.jobId, grant.leaseId);
    } catch (err) {
      if (err instanceof CoreApiError && err.status === 409) {
        log.warn("lease was not current at start; dropping job");
        return;
      }
      if (err instanceof CoreApiError && err.isAuth) {
        this.recordFatal(new FatalAuthError(`core rejected our credentials: ${err.message}`));
        return;
      }
      log.error({ err }, "could not start job; dropping so the sweeper can requeue it");
      return;
    }

    const abort = new AbortController();
    const renewer = this.startRenewals(job, grant, abort, log);

    let envelope: ResultEnvelope;
    try {
      envelope = await this.executor.execute(job, grant.leaseId, abort.signal);
    } catch (err) {
      renewer.stop();
      if (err instanceof JobCancelledError) {
        if (err.reason === "lease-lost") {
          // Someone else owns this job now; submitting would be noise at best.
          log.warn("lease lost mid-execution; abandoning without submitting");
          return;
        }
        log.warn({ reason: err.reason }, "job cancelled; reporting as transient failure");
        envelope = cancellationEnvelope(job, grant.leaseId, err.reason);
      } else {
        log.error({ err }, "executor threw; dropping job for the sweeper");
        return;
      }
    }
    renewer.stop();

    try {
      const result = await this.api.submitResult(envelope);
      log.info(
        { outcome: result.outcome, reason: result.reason, status: envelope.status },
        "result submitted",
      );
    } catch (err) {
      if (err instanceof CoreApiError && err.isAuth) {
        this.recordFatal(new FatalAuthError(`core rejected our credentials: ${err.message}`));
        return;
      }
      // The sweeper will expire the lease and requeue; the idempotency key
      // makes a later duplicate harmless if the core did receive this.
      log.error({ err }, "result submission failed after retries; job left to the sweeper");
    }
  }

  /**
   * Keep the lease alive while the runner works, and translate the core's
   * answers into execution control: a cancel request or a lost lease both
   * abort the runner, with different reasons so the caller can tell them apart.
   */
  private startRenewals(
    job: LeasedJob,
    grant: LeaseGrant,
    abort: AbortController,
    log: Logger,
  ): { stop: () => void } {
    const intervalMs = Math.max(
      MIN_RENEW_INTERVAL_MS,
      Math.floor((grant.leaseTtlSeconds * 1000) / 3),
    );
    const timer = setInterval(() => {
      this.api
        .renewLease(job.jobId, grant.leaseId)
        .then((res) => {
          if (res.cancelRequested && !abort.signal.aborted) {
            log.warn("core requested cancellation");
            abort.abort("cancelled");
          }
        })
        .catch((err: unknown) => {
          if (err instanceof CoreApiError && err.status === 409 && !abort.signal.aborted) {
            log.error("lease no longer current; stopping runner");
            abort.abort("lease-lost");
            return;
          }
          if (err instanceof CoreApiError && err.isAuth) {
            this.recordFatal(new FatalAuthError(`core rejected our credentials: ${err.message}`));
            abort.abort("lease-lost");
            return;
          }
          log.warn({ err }, "lease renewal failed; will retry on next tick");
        });
    }, intervalMs);
    timer.unref();
    return { stop: () => clearInterval(timer) };
  }
}

function cancellationEnvelope(job: LeasedJob, leaseId: string, reason: string): ResultEnvelope {
  return {
    envelopeVersion: 1,
    jobId: job.jobId,
    leaseId,
    segmentKey: job.segmentKey ?? null,
    extension: job.extension,
    bundleSha256: job.bundleSha256,
    idempotencyKey: resultIdempotencyKey(job.jobId, job.attempt),
    status: "error",
    error: { class: "TRANSIENT", message: `cancelled: ${reason}` },
    updatedChapters: [],
    allChapters: null,
    untrackedManga: [],
    trackedMangadexIds: [],
    mangadexGroupId: null,
    overrideOptions: {},
    extensionLanguages: [],
    stats: {},
  };
}
