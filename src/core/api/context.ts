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
import type { RepoArchiveFetcher } from "../webhooks/repoArchive.js";
import type { GithubContentsClient } from "../webhooks/repoContents.js";
import { ApiTokenStore } from "../store/apiTokens.js";
import { TrackedMangaStore } from "../store/trackedManga.js";
import { ExtensionConfigStore } from "../store/extensionConfig.js";
import { RateLimiter } from "./ratelimit.js";
import { deriveSigningKey } from "./session.js";
import { AdminUserStore } from "../store/adminUsers.js";
import { LoginTokenStore } from "../store/loginTokens.js";
import { createMailer, type Mailer } from "../email/mailer.js";
import { MagicLinkService } from "./magicLink.js";

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
   * Test seam for the GitHub webhook's archive download. Injected here rather
   * than as a route option so `buildServer` can register the webhook routes
   * unconditionally while tests still avoid the network.
   */
  webhookFetchArchive?: RepoArchiveFetcher;
  /**
   * Test seam for the series-map sync's GitHub Contents calls, for the same
   * reason as `webhookFetchArchive`: the admin route builds the service on
   * demand, and a test must be able to hand it a client that never leaves the
   * process.
   */
  mapSyncContents?: GithubContentsClient;
  enrollLimiter: RateLimiter;
  workerLimiter: RateLimiter;
  adminLimiter: RateLimiter;
  sessionLimiter: RateLimiter;
  /** Per-IP budget for requesting and redeeming email sign-in links. */
  magicLinkLimiter: RateLimiter;
  /** Per-address budget, so a distributed caller cannot mailbomb one inbox. */
  magicLinkEmailLimiter: RateLimiter;
  /** Dashboard accounts and their revocable sessions. */
  adminUsers: AdminUserStore;
  /** Single-use emailed sign-in links. */
  loginTokens: LoginTokenStore;
  /** Transactional email; a refusing stub when no provider is configured. */
  mailer: Mailer;
  /** Issues and mails sign-in links; used by the login page and by invites. */
  magicLinks: MagicLinkService;
  /** HMAC key for short-lived signed cookies (OAuth state); null when unset. */
  signingKey: Buffer | null;
}

export function buildContext(prisma: PrismaClient, config: Config, log: Logger): AppContext {
  const retry = { baseSeconds: config.retryBaseSeconds, maxSeconds: config.retryMaxSeconds };
  const jobs = new JobStore(prisma, retry);
  const loginTokens = new LoginTokenStore(prisma);
  const mailer = createMailer(config, log);
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
    // Each request sends real mail to a real inbox, so the budget is tighter
    // than the password login's: 5 in a burst, then one every two minutes.
    magicLinkLimiter: new RateLimiter(5, 1 / 120),
    // Per-address: 3 links in a burst, then one every five minutes. Enough for
    // "it went to spam, send another", far short of a mailbomb.
    magicLinkEmailLimiter: new RateLimiter(3, 1 / 300),
    adminUsers: new AdminUserStore(prisma),
    loginTokens,
    mailer,
    magicLinks: new MagicLinkService({ loginTokens, mailer, config, log }),
    signingKey: deriveSigningKey(config, log),
  };
}
