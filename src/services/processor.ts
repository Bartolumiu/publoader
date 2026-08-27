import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "../config.js";
import { createLogger } from "../logging.js";
import { getPrisma } from "../db.js";
import { metrics } from "../metrics.js";
import { MdClient } from "../core/md/client.js";
import { botUserIdFromClientId } from "../core/md/types.js";
import { RunProcessor } from "../core/processor/processor.js";
import { DiscordNotifier } from "../core/md/webhook.js";
import { SettingsStore } from "../core/store/settings.js";
import { UploadTaskStore } from "../core/store/uploadTasks.js";
import { shouldRestart } from "../core/sysops/restartSignal.js";
import { startMetricsServer } from "../core/observability/metricsServer.js";

/**
 * core-processor: drains runs that finished ingestion into MangaDex work.
 *
 * Runs as its own process so that a slow MangaDex API can never stall job
 * leasing or result ingestion. Only one instance is needed; several are safe
 * (runs are claimed with SKIP LOCKED and processing is idempotent).
 */

const INTERVAL_SECONDS = 15;

const config = loadConfig();
const log = createLogger("core-processor", config.logLevel);
const prisma = getPrisma(config.databaseUrl);
const md = new MdClient(config, prisma, log);
// The processor is where the update plan is decided, so it is where the
// per-manga report is sent from.
const notifier = DiscordNotifier.fromConfig(config, log);
// Explicit config wins; otherwise read the owner's user id out of a personal
// client id. Every removal pass is gated on this, and is disabled without it.
const botUserId = config.mdBotUserId ?? botUserIdFromClientId(config.mdClientId);
const processor = new RunProcessor(prisma, md, log, { notifier, botUserId });
const settings = new SettingsStore(prisma);
const tasks = new UploadTaskStore(prisma);

let running = true;
const stop = () => {
  running = false;
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

// Before the loop, so a port clash fails the deploy instead of leaving the
// service unmonitored. Serves this process's registry, including the
// upload-task depths published below.
const metricsServer = await startMetricsServer({
  service: "core-processor",
  log,
  prisma,
  defaultPort: 8102,
});

log.info("core-processor started");
while (running) {
  // Ahead of the pause gate below: a paused processor must still be restartable.
  if (await shouldRestart(settings, "processor", log)) break;

  try {
    // The pause gate stops new MangaDex-facing work without stopping the
    // scheduler: runs simply queue up in INGESTING until it is lifted.
    if (await settings.isPaused()) {
      log.debug("paused; skipping tick");
    } else {
      const processed = await processor.tick();
      if (processed > 0) log.info({ processed }, "runs processed");
    }

    for (const depth of await tasks.depths()) {
      metrics.uploadTasks.set({ kind: depth.kind, state: depth.state }, depth.count);
    }
  } catch (err) {
    log.error({ err }, "processor tick failed");
  }
  await sleep(INTERVAL_SECONDS * 1000);
}

await metricsServer.close();
await prisma.$disconnect();
log.info("core-processor stopped");
