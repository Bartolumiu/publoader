import type { PrismaClient } from "@prisma/client";
import type { Config } from "../../config.js";
import type { Logger } from "../../logging.js";
import { JobStore } from "../store/jobs.js";
import { WorkerStore } from "../store/workers.js";
import { BundleStore } from "../store/bundles.js";
import { ArtifactStore } from "../store/artifacts.js";
import { SettingsStore, AuditLog } from "../store/settings.js";
import { UploadTaskStore } from "../store/uploadTasks.js";
import { ChapterStore } from "../store/chapters.js";
import { RunChapterStore } from "../store/runChapters.js";
import { IngestService } from "../ingest/ingest.js";
import { SchedulerService } from "../scheduler/service.js";
import type { TitleService } from "../md/titleService.js";
import type { MdExtendedApi } from "../md/client.js";
import type { RepoArchiveFetcher } from "../webhooks/repoArchive.js";
import { ApiTokenStore } from "../store/apiTokens.js";
import { TrackedMangaStore } from "../store/trackedManga.js";
import { ExtensionConfigStore } from "../store/extensionConfig.js";
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
  /** The four chapter history tables, read-only. */
  chapters: ChapterStore;
  /** What each run reported, read back out of the stored result envelopes. */
  runChapters: RunChapterStore;
  audit: AuditLog;
  /** Scoped per-client `pa_…` credentials. */
  apiTokens: ApiTokenStore;
  trackedManga: TrackedMangaStore;
  /** The three override-option relations plus the free-form remainder. */
  extensionConfig: ExtensionConfigStore;
  ingest: IngestService;
  scheduler: SchedulerService;
  /** Present when this instance holds MangaDex credentials (api + uploader). */
  titleService?: TitleService;
  /**
   * A MangaDex client, when this instance has credentials. READ-ONLY by
   * convention on the API side: the chapter views use it to show what MangaDex
   * currently says and to render a card preview, and every change is queued as
   * an UploadTask instead. core-uploader remains the only process that writes
   * to MangaDex, which is what keeps "exactly one writer" true — an API replica
   * behind a load balancer must not be able to open an upload session.
   */
  md?: MdExtendedApi;
  /**
   * Test seam for the GitHub webhook's archive download. Injected here rather
   * than as a route option so `buildServer` can register the webhook routes
   * unconditionally while tests still avoid the network.
   */
  webhookFetchArchive?: RepoArchiveFetcher;
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
    chapters: new ChapterStore(prisma),
    runChapters: new RunChapterStore(prisma),
    audit: new AuditLog(prisma),
    apiTokens: new ApiTokenStore(prisma),
    trackedManga: new TrackedMangaStore(prisma),
    extensionConfig: new ExtensionConfigStore(prisma),
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
