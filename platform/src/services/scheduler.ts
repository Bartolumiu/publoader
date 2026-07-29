import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "../config.js";
import { createLogger } from "../logging.js";
import { getPrisma } from "../db.js";
import { markSchedulerTick } from "../metrics.js";
import { SchedulerService } from "../core/scheduler/service.js";
import { startMetricsServer } from "../core/observability/metricsServer.js";
import { collectInventoryMetrics } from "../core/observability/inventory.js";

const config = loadConfig();
const log = createLogger("core-scheduler", config.logLevel);
const prisma = getPrisma(config.databaseUrl);
const scheduler = new SchedulerService(prisma, log, {
  baseSeconds: config.retryBaseSeconds,
  maxSeconds: config.retryMaxSeconds,
});

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
