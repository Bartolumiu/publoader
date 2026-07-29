import { setTimeout as sleep } from "node:timers/promises";
import type { UploadTaskKind } from "@prisma/client";
import { loadConfig } from "../config.js";
import { createLogger } from "../logging.js";
import { getPrisma } from "../db.js";
import { metrics } from "../metrics.js";
import { UploadTaskStore } from "../core/store/uploadTasks.js";
import { SettingsStore } from "../core/store/settings.js";
import { MdClient } from "../core/md/client.js";
import { DiscordNotifier } from "../core/md/webhook.js";
import { UploadTaskWorkers } from "../core/md/taskWorkers.js";

/**
 * core-uploader: the only process that talks to MangaDex with write
 * credentials. It drains the UploadTask queues in a fixed order — removals
 * first, so a chapter that was deleted upstream never races the re-upload of
 * its replacement — and leaves task bookkeeping to UploadTaskStore.
 */

/** Long enough for a full page set at the MangaDex ratelimit. */
const LEASE_TTL_SECONDS = 600;
const IDLE_SLEEP_MS = 5_000;
const KIND_ORDER: UploadTaskKind[] = ["DELETE", "EDIT", "UPLOAD", "UNAVAILABLE"];

const config = loadConfig();
const log = createLogger("core-uploader", config.logLevel);
const prisma = getPrisma(config.databaseUrl);

const tasks = new UploadTaskStore(prisma);
const settings = new SettingsStore(prisma);
const md = new MdClient(config, prisma, log);
const notifier = DiscordNotifier.fromConfig(config, log);
const workers = new UploadTaskWorkers({ prisma, md, notifier, config, log });

let running = true;
const stop = (signal: string) => {
  log.info({ signal }, "shutdown requested, finishing the current task");
  running = false;
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

function retryDelaySeconds(attempt: number): number {
  return Math.min(config.retryMaxSeconds, config.retryBaseSeconds * 2 ** Math.max(0, attempt - 1));
}

/** Drain every due task of one kind. Returns how many were executed. */
async function drain(kind: UploadTaskKind): Promise<number> {
  let processed = 0;
  while (running) {
    const task = await tasks.claim(kind, LEASE_TTL_SECONDS);
    if (!task) break;
    processed += 1;
    const leaseId = task.leaseId ?? "";

    try {
      await workers.execute(task);
      await tasks.completeDone(task.id, leaseId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const disposition = await tasks.fail(task.id, leaseId, message, retryDelaySeconds(task.attempt));
      log.error(
        { taskId: task.id, kind, dedupeKey: task.dedupeKey, attempt: task.attempt, disposition, err },
        "upload task failed",
      );
    }
  }
  return processed;
}

async function publishDepths(): Promise<void> {
  const depths = await tasks.depths();
  metrics.uploadTasks.reset();
  for (const row of depths) {
    metrics.uploadTasks.set({ kind: row.kind, state: row.state }, row.count);
  }
}

log.info({ kinds: KIND_ORDER, discord: notifier.enabled }, "core-uploader started");

while (running) {
  try {
    await tasks.sweepExpired();

    if (await settings.isPaused()) {
      log.debug("uploads paused, not claiming tasks");
      await sleep(IDLE_SLEEP_MS);
      continue;
    }

    let processed = 0;
    for (const kind of KIND_ORDER) {
      if (!running) break;
      processed += await drain(kind);
    }

    await workers.flushNotifications();
    await publishDepths();

    if (processed === 0 && running) await sleep(IDLE_SLEEP_MS);
  } catch (err) {
    log.error({ err }, "uploader loop iteration failed");
    await sleep(IDLE_SLEEP_MS);
  }
}

await workers.flushNotifications();
await prisma.$disconnect();
log.info("core-uploader stopped");
