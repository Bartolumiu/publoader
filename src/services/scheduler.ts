import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "../config.js";
import { createLogger } from "../logging.js";
import { getPrisma } from "../db.js";
import { markSchedulerTick } from "../metrics.js";
import { SchedulerService } from "../core/scheduler/service.js";
import { SettingsStore } from "../core/store/settings.js";
import { shouldRestart } from "../core/sysops/restartSignal.js";
import { startMetricsServer } from "../core/observability/metricsServer.js";
import { collectInventoryMetrics } from "../core/observability/inventory.js";
import { DiscordNotifier } from "../core/md/webhook.js";
import { autoSyncExtensions } from "../core/webhooks/autoSync.js";
import { parseRepoList } from "../core/api/routes/webhooks.js";
import { BundleStore } from "../core/store/bundles.js";
import { AuditLog } from "../core/store/settings.js";

const config = loadConfig();
const log = createLogger("core-scheduler", config.logLevel);
const prisma = getPrisma(config.databaseUrl);
const settings = new SettingsStore(prisma);
const notifier = DiscordNotifier.fromConfig(config, log);

// Polling the extension repos is only wired up when there are repos to poll:
// with GITHUB_EXTENSIONS_REPOS unset there is nothing to compare against, and
// an auto-sync that runs anyway would log a failure every quarter of an hour.
const extensionRepos = parseRepoList(config.githubExtensionsRepos);
const autoSync =
  extensionRepos.length > 0
    ? () =>
        autoSyncExtensions(
          { bundles: new BundleStore(prisma), audit: new AuditLog(prisma), log, settings },
          {
            repos: extensionRepos,
            owner: config.githubRepoOwner,
            apiUrl: config.githubApiUrl,
            ...(config.githubToken ? { token: config.githubToken } : {}),
          },
        )
    : undefined;

const scheduler = new SchedulerService(
  prisma,
  log,
  { baseSeconds: config.retryBaseSeconds, maxSeconds: config.retryMaxSeconds },
  { notifier, ...(autoSync ? { autoSync } : {}) },
);

let running = true;
process.on("SIGTERM", () => (running = false));
process.on("SIGINT", () => (running = false));

// Before the loop: an unbindable port must be a boot failure, not a service
// that runs unmonitored. This is the endpoint the scheduler-stall alert reads.
const metricsServer = await startMetricsServer({
  service: "core-scheduler",
  log,
  prisma,
  defaultPort: 8101,
});

log.info("core-scheduler started");
while (running) {
  // Checked at the top of the iteration so the exit goes through the teardown
  // below rather than interrupting a tick that is mid-transaction.
  if (await shouldRestart(settings, "scheduler", log)) break;

  try {
    await scheduler.tick();
    // Only after a tick returns: a loop that throws every time is not a
    // running clock, and the timestamp must not claim otherwise.
    markSchedulerTick();
  } catch (err) {
    log.error({ err }, "scheduler tick failed");
  }

  // Queue depths and backlog ages. Kept out of the tick's try block: failing to
  // publish a gauge must not be mistaken for the clock failing.
  try {
    await collectInventoryMetrics(prisma);
  } catch (err) {
    log.warn({ err }, "publishing inventory metrics failed");
  }

  await sleep(config.schedulerIntervalSeconds * 1000);
}
await metricsServer.close();
await prisma.$disconnect();
log.info("core-scheduler stopped");
