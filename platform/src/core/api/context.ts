import type { PrismaClient } from "@prisma/client";
import type { Config } from "../../config.js";
import type { Logger } from "../../logging.js";
import { JobStore } from "../store/jobs.js";
import { WorkerStore } from "../store/workers.js";
import { BundleStore } from "../store/bundles.js";
import { ArtifactStore } from "../store/artifacts.js";
import { SettingsStore, AuditLog } from "../store/settings.js";
import { UploadTaskStore } from "../store/uploadTasks.js";
import { IngestService } from "../ingest/ingest.js";
import { SchedulerService } from "../scheduler/service.js";
import type { TitleService } from "../md/titleService.js";
import { RateLimiter } from "./ratelimit.js";
import { deriveSigningKey } from "./session.js";
import { AdminUserStore } from "../store/adminUsers.js";

export interface AppContext {
  prisma: PrismaClient;
  config: Config;
  log: Logger;
  jobs: JobStore;
  workers: WorkerStore;
  bundles: BundleStore;
  artifacts: ArtifactStore;
  settings: SettingsStore;
  uploadTasks: UploadTaskStore;
  audit: AuditLog;
  ingest: IngestService;
  scheduler: SchedulerService;
  /** Present when this instance holds MangaDex credentials (api + uploader). */
  titleService?: TitleService;
  enrollLimiter: RateLimiter;
  workerLimiter: RateLimiter;
  adminLimiter: RateLimiter;
  sessionLimiter: RateLimiter;
  /** Dashboard accounts and their revocable sessions. */
  adminUsers: AdminUserStore;
  /** HMAC key for short-lived signed cookies (OAuth state); null when unset. */
  signingKey: Buffer | null;
}

export function buildContext(prisma: PrismaClient, config: Config, log: Logger): AppContext {
  const retry = { baseSeconds: config.retryBaseSeconds, maxSeconds: config.retryMaxSeconds };
  const jobs = new JobStore(prisma, retry);
  return {
    prisma,
    config,
    log,
    jobs,
    workers: new WorkerStore(prisma),
    bundles: new BundleStore(prisma),
    artifacts: new ArtifactStore(prisma),
    settings: new SettingsStore(prisma),
    uploadTasks: new UploadTaskStore(prisma),
    audit: new AuditLog(prisma),
    ingest: new IngestService(prisma, jobs, log),
    scheduler: new SchedulerService(prisma, log, retry),
    // Enrollment is rare: keep it tight (5 attempts, refill 1/min per IP).
    enrollLimiter: new RateLimiter(5, 1 / 60),
    // Worker API budget: bursts of 60, ~10 rps sustained per worker.
    workerLimiter: new RateLimiter(60, 10),
    adminLimiter: new RateLimiter(120, 20),
    // Dashboard logins are password-equivalent: 5 attempts, refill 5/min.
    sessionLimiter: new RateLimiter(5, 5 / 60),
    adminUsers: new AdminUserStore(prisma),
    signingKey: deriveSigningKey(config, log),
  };
}
