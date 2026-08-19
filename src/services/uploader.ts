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
import { TitleService } from "../core/md/titleService.js";
import { shouldRestart } from "../core/sysops/restartSignal.js";
import { startMetricsServer } from "../core/observability/metricsServer.js";

/**
 * core-uploader: the only process that talks to MangaDex with write
 * credentials. It drains the UploadTask queues in a fixed order; removals
 * first, so a chapter that was deleted upstream never races the re-upload of
 * its replacement; and leaves task bookkeeping to UploadTaskStore.
 *
 * Title creation for untracked series lives here for the same reason: this is
 * the only process holding MangaDex write credentials.
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
const workers = new UploadTaskWorkers({ prisma, md, notifier, settings, config, log });
const titles = new TitleService(prisma, md, notifier, log);

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

/**
 * Drain every due task of one kind, counting the two outcomes apart.
 *
 * They have to be separate: a failed task is requeued with a backoff, so it is
 * work attempted rather than work completed, and the reporting distinguishes
 * the two (see UploadTaskWorkers.flushQueueSummary). `claimed` is what decides
 * whether the loop sleeps, since a pass that only failed still did I/O.
 */
async function drain(kind: UploadTaskKind): Promise<{ processed: number; failed: number }> {
  let processed = 0;
  let failed = 0;
  while (running) {
    const task = await tasks.claim(kind, LEASE_TTL_SECONDS);
    if (!task) break;
    const leaseId = task.leaseId ?? "";

    try {
      await workers.execute(task);
      await tasks.completeDone(task.id, leaseId);
      processed += 1;
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      const disposition = await tasks.fail(task.id, leaseId, message, retryDelaySeconds(task.attempt));
      log.error(
        { taskId: task.id, kind, dedupeKey: task.dedupeKey, attempt: task.attempt, disposition, err },
        "upload task failed",
      );
    }
  }
  return { processed, failed };
}

async function publishDepths(): Promise<void> {
  const depths = await tasks.depths();
  metrics.uploadTasks.reset();
  for (const row of depths) {
    metrics.uploadTasks.set({ kind: row.kind, state: row.state }, row.count);
  }
}

// Before the loop, so a port clash fails the deploy instead of leaving the
// service unmonitored. This endpoint is where `publoader_upload_tasks` becomes
// scrapeable.
const metricsServer = await startMetricsServer({
  service: "core-uploader",
  log,
  prisma,
  defaultPort: 8103,
});

log.info({ kinds: KIND_ORDER, discord: notifier.enabled }, "core-uploader started");

while (running) {
  // Between iterations, so we are never holding a task lease, and ahead of the
  // pause gate's `continue`: a paused uploader must still be restartable.
  if (await shouldRestart(settings, "uploader", log)) break;

  try {
    await tasks.sweepExpired();

    if (await settings.isPaused()) {
      log.debug("uploads paused, not claiming tasks");
      await sleep(IDLE_SLEEP_MS);
      continue;
    }

    // Once per pass, not per task: a setting changed mid-drain should not split
    // one batch into two reporting styles.
    await workers.refreshReporting();

    let claimed = 0;
    // Per-kind counts, so the end-of-drain summary can name the queue that did
    // the work the way the Python worker threads did.
    const drained = new Map<string, { processed: number; failed: number }>();
    for (const kind of KIND_ORDER) {
      if (!running) break;
      const done = await drain(kind);
      claimed += done.processed + done.failed;
      if (done.processed > 0 || done.failed > 0) drained.set(kind, done);
    }

    // Title creation is its own MangaDex-facing pass; a failure there must not
    // cost us the queue drain we just did, so it gets its own guard.
    try {
      await titles.tick();
    } catch (err) {
      log.error({ err }, "title service tick failed");
    }

    await workers.flushNotifications();
    await workers.flushQueueSummary(drained);
    await publishDepths();

    if (claimed === 0 && running) await sleep(IDLE_SLEEP_MS);
  } catch (err) {
    log.error({ err }, "uploader loop iteration failed");
    await sleep(IDLE_SLEEP_MS);
  }
}

await workers.flushNotifications();
await metricsServer.close();
await prisma.$disconnect();
log.info("core-uploader stopped");
