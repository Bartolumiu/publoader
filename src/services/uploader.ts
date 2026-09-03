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
 *
 * TWO loops, not one. UNAVAILABLE is drained alongside the rest rather than
 * after them, because it is the only queue whose work is mostly NOT the write:
 * a card is rendered, committed, and then confirmed minutes later, and only the
 * commit needs MangaDex's one upload session. Sharing a loop with UPLOAD meant
 * all of that waiting happened with the queue stopped behind it.
 *
 * What still takes turns is the session itself, held by `UploadSessionLock`
 * inside UploadTaskWorkers: one MangaDex account may have one open upload
 * session, so a card's image goes up between two chapters' page sets rather
 * than beside them. Everything either side of that runs in parallel.
 */

/** Long enough for a full page set at the MangaDex ratelimit. */
const LEASE_TTL_SECONDS = 600;
const IDLE_SLEEP_MS = 5_000;
/**
 * Which queues the main loop drains, and in what order.
 *
 * A kind missing from here AND from the unavailable loop is never claimed at
 * all: `claim` takes one kind, so a task of a kind nobody asks for waits
 * forever in PENDING with nothing to say it is stuck. RESTORE was added as a
 * task kind and a worker without being added here, and 39 restore tasks sat
 * untouched because of it.
 *
 * RESTORE goes first because it is the corrective verb: it takes a card off a
 * chapter that should not have one, and until it runs a reader is looking at
 * "no longer available" over a chapter they can actually read.
 */
const KIND_ORDER: UploadTaskKind[] = ["RESTORE", "DELETE", "EDIT", "UPLOAD"];

/** The queue with a loop to itself; see the note above. */
const UNAVAILABLE_KIND: UploadTaskKind = "UNAVAILABLE";

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
/**
 * How many tasks of one kind a single pass may take before yielding.
 *
 * Without a bound, `drain` empties its kind completely before returning, and
 * the main loop's kinds are visited in a fixed order. A bulk backfill would
 * therefore own that loop for as long as it takes: 2,425 items at roughly
 * twenty seconds each is thirteen hours during which UPLOAD is never looked at
 * again, so a chapter published in the meantime simply waits. That is the queue
 * "not doing anything" while plainly being busy.
 *
 * The budget is also what makes a pause take effect: `isPaused` and the paused
 * extension list are read once per pass, so a long pass is a long time before
 * either is noticed.
 *
 * UNAVAILABLE used to take the small slice, because sharing a loop with UPLOAD
 * meant every card it drained was a chapter that did not go up. It has its own
 * loop now and nothing waits behind it, so it takes the ordinary budget.
 */
const DEFAULT_DRAIN_BUDGET = 100;
const DRAIN_BUDGET: Partial<Record<UploadTaskKind, number>> = {};

/** What one pass of `drain` did, split by what the task's outcome was. */
interface Drained {
  processed: number;
  failed: number;
  /**
   * Tasks that wrote successfully and went back on the queue to be confirmed
   * later. Counted apart from `processed` because they are not finished: the
   * same task will come back and end as one of the other two, and counting it
   * here as well would double it in the end-of-drain summary.
   */
  deferred: number;
}

async function drain(kind: UploadTaskKind, pausedExtensions: readonly string[]): Promise<Drained> {
  let processed = 0;
  let failed = 0;
  let deferred = 0;
  const budget = DRAIN_BUDGET[kind] ?? DEFAULT_DRAIN_BUDGET;
  while (running && processed + failed + deferred < budget) {
    const task = await tasks.claim(kind, LEASE_TTL_SECONDS, pausedExtensions);
    if (!task) break;
    const leaseId = task.leaseId ?? "";

    try {
      const outcome = await workers.execute(task);
      if (outcome?.defer) {
        // Not done and not failed: the write landed and something outside this
        // process has to become true before anyone can say whether it worked.
        // The row goes back with a `not_before` and this loop moves on.
        await tasks.defer(task.id, leaseId, outcome.defer.seconds, outcome.defer.chapter);
        deferred += 1;
        log.debug(
          { taskId: task.id, kind, dedupeKey: task.dedupeKey, seconds: outcome.defer.seconds },
          "upload task deferred for confirmation",
        );
      } else {
        await tasks.completeDone(task.id, leaseId);
        processed += 1;
      }
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
  return { processed, failed, deferred };
}

/**
 * Work the unavailable loop has done that the main loop has not reported yet.
 *
 * The two loops run at once but only one of them reports: `flushQueueSummary`
 * accumulates per kind and decides when a queue is finished, and calling it
 * from both would race over those totals. So the unavailable loop leaves its
 * counts here and the main loop picks them up on its next pass.
 */
const unreported = new Map<string, { processed: number; failed: number }>();

function report(kind: string, done: Drained): void {
  if (done.processed === 0 && done.failed === 0) return;
  const total = unreported.get(kind) ?? { processed: 0, failed: 0 };
  total.processed += done.processed;
  total.failed += done.failed;
  unreported.set(kind, total);
}

/**
 * Publish queue depths, and report what is still waiting per kind.
 *
 * The second half is what tells `flushQueueSummary` whether a queue is
 * genuinely empty. Only PENDING and LEASED count: a DONE or DEAD_LETTER row is
 * settled and will not be worked again, so counting it would mean no queue is
 * ever "finished" and the summary would never be sent at all.
 */
async function publishDepths(): Promise<Map<string, number>> {
  const depths = await tasks.depths();
  metrics.uploadTasks.reset();
  const remaining = new Map<string, number>();
  for (const row of depths) {
    metrics.uploadTasks.set({ kind: row.kind, state: row.state }, row.count);
    if (row.state === "PENDING" || row.state === "LEASED") {
      remaining.set(row.kind, (remaining.get(row.kind) ?? 0) + row.count);
    }
  }
  return remaining;
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

log.info(
  { kinds: KIND_ORDER, alongside: UNAVAILABLE_KIND, discord: notifier.enabled },
  "core-uploader started",
);

/**
 * The main loop: every queue but UNAVAILABLE, plus everything that is done once
 * per pass rather than per queue -- the lease sweep, the pause gate, the title
 * service, and all of the reporting.
 */
async function mainLoop(): Promise<void> {
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

      // Read per pass for the same reason, and outside `drain` so every kind in
      // this pass agrees about who is paused.
      const pausedExtensions = await settings.getUploadPausedExtensions();
      if (pausedExtensions.length > 0) {
        log.debug({ pausedExtensions }, "holding queued work for paused extensions");
      }

      let claimed = 0;
      for (const kind of KIND_ORDER) {
        if (!running) break;
        const done = await drain(kind, pausedExtensions);
        claimed += done.processed + done.failed + done.deferred;
        report(kind, done);
      }

      // Title creation is its own MangaDex-facing pass; a failure there must not
      // cost us the queue drain we just did, so it gets its own guard.
      try {
        await titles.tick();
      } catch (err) {
        log.error({ err }, "title service tick failed");
      }

      await workers.flushNotifications();
      // Depths first: the summary only announces a queue as finished once
      // nothing is left in it, so it needs this pass's remainder to decide.
      const remaining = await publishDepths();
      // Per-kind counts, so the end-of-drain summary can name the queue that did
      // the work the way the Python worker threads did. Drained wholesale, both
      // loops' worth, and handed over in one call.
      const drained = new Map(unreported);
      unreported.clear();
      await workers.flushQueueSummary(drained, remaining);

      // Only this loop's own work decides whether it sleeps. The unavailable
      // loop having been busy says nothing about there being an upload to do.
      if (claimed === 0 && running) await sleep(IDLE_SLEEP_MS);
    } catch (err) {
      log.error({ err }, "uploader loop iteration failed");
      await sleep(IDLE_SLEEP_MS);
    }
  }
  // The other loop only ever stops on this flag, so a restart signal or a
  // failure that breaks out of here has to take it down too.
  running = false;
}

/**
 * The unavailable loop: cards, and nothing else.
 *
 * Deliberately thin. It claims, drains and sleeps; it does not sweep leases,
 * tick the title service or flush anything, because those are once-per-pass
 * concerns and the main loop already has them. What it does share is the pause
 * gate -- a paused platform must stop carding as surely as it stops uploading.
 */
async function unavailableLoop(): Promise<void> {
  while (running) {
    try {
      if (await settings.isPaused()) {
        await sleep(IDLE_SLEEP_MS);
        continue;
      }

      const pausedExtensions = await settings.getUploadPausedExtensions();
      const done = await drain(UNAVAILABLE_KIND, pausedExtensions);
      report(UNAVAILABLE_KIND, done);

      const claimed = done.processed + done.failed + done.deferred;
      if (claimed === 0 && running) await sleep(IDLE_SLEEP_MS);
    } catch (err) {
      log.error({ err }, "unavailable loop iteration failed");
      await sleep(IDLE_SLEEP_MS);
    }
  }
}

// Both are awaited so shutdown waits for whichever is mid-task; neither
// rejects, so `all` is safe here and a crash in one still stops the other
// through the `running` flag.
await Promise.all([mainLoop(), unavailableLoop()]);

await workers.flushNotifications();
await metricsServer.close();
await prisma.$disconnect();
log.info("core-uploader stopped");
