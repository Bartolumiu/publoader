import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "../config.js";
import { createLogger } from "../logging.js";
import { getPrisma } from "../db.js";
import { SchedulerService } from "../core/scheduler/service.js";

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

log.info("core-scheduler started");
while (running) {
  try {
    await scheduler.tick();
  } catch (err) {
    log.error({ err }, "scheduler tick failed");
  }
  await sleep(config.schedulerIntervalSeconds * 1000);
}
await prisma.$disconnect();
log.info("core-scheduler stopped");
