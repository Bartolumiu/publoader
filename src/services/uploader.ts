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
 * credentials. It drains the UploadTask queues and leaves task bookkeeping to
 * UploadTaskStore.
 *
 * Title creation for untracked series lives here for the same reason: this is
 * the only process holding MangaDex write credentials.
 *
 * ONE LOOP PER QUEUE, plus a housekeeping loop. Every kind is drained
 * concurrently rather than taking its turn in a fixed order, because a queue's
 * wait used to be everything ahead of it: UPLOAD is the slowest verb at roughly
 * six seconds a chapter, and a hundred of them is ten minutes during which a
 * RESTORE -- the corrective verb, the one a reader is waiting on -- was not
 * looked at once.
 *
 * WHAT REPLACED THE ORDER. The kinds used to run removals-first, so no two of
 * them could ever be working on one chapter at the same time. Three things do
 * that job now, none of them an ordering:
 *
 *  - The interlock in `UploadTaskStore.claim`: a row is passed over while any
 *    other row about the same chapter is LEASED. That is the direct replacement
 *    -- a DELETE and an UNAVAILABLE for one chapter still cannot run at once --
 *    and it is scoped per publisher chapter rather than per queue, so unrelated
 *    work never waits.
 *  - `UploadSessionLock` (in UploadTaskWorkers) serialises every stretch that
 *    holds MangaDex's one upload session, so UPLOAD, UNAVAILABLE and RESTORE
 *    take turns to put images up. DELETE and EDIT open no session at all.
 *  - The workers re-check ownership immediately before each write, and
 *    `runDelete` and `runUnavailable` both treat a chapter that has gone from
 *    MangaDex as already handled rather than as a failure.
 *
 * What is genuinely given up is ordering between DIFFERENT chapters: a chapter
 * removed upstream and the re-upload of its replacement are two chapters with
 * two identities, so nothing sequences them any more. The window that leaves is
 * both of them existing briefly, which reconcile already finds and the
 * duplicate scan already reports.
 */

/** Long enough for a full page set at the MangaDex ratelimit. */
const LEASE_TTL_SECONDS = 600;
const IDLE_SLEEP_MS = 5_000;
/**
 * Every queue this process drains, one loop each.
 *
 * A kind missing from here is never claimed at all: `claim` takes one kind, so
 * a task of a kind nobody asks for waits forever in PENDING with nothing to say
 * it is stuck. RESTORE was added as a task kind and a worker without being
 * added to the old ordered list, and 39 restore tasks sat untouched because of
 * it. The list is no longer an order, but it is still the enrolment.
 */
const DRAINED_KINDS: UploadTaskKind[] = ["RESTORE", "DELETE", "EDIT", "UPLOAD", "UNAVAILABLE"];

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
 * How many tasks a single pass may take before yielding.
 *
 * This used to be the thing that stopped one kind owning the shared loop, and
 * that job is gone: nothing queues behind anything now, so a kind emptying
 * itself costs no other kind a thing. UNAVAILABLE's slice of ten -- which
 * existed only because every card it drained was a chapter that did not go up
 * -- goes with it.
 *
 * What is left is a reporting bound. `report` publishes a pass's counts, and
 * `publishDepths` scrapes the queue, so an unbounded pass would leave both
 * silent for as long as the backfill ran. A hundred is close enough to
 * continuous for a metric sampled every few seconds.
 */
const DEFAULT_DRAIN_BUDGET = 100;
const DRAIN_BUDGET: Partial<Record<UploadTaskKind, number>> = {};

/**
 * The pause gates, read once by the housekeeping loop and shared by all five
 * drains.
 *
 * Read per loop instead, these would be ten settings queries every five seconds
 * for a platform that is usually idle. Cached, they are also FRESHER than they
 * were: the gate used to be read at the top of a pass and not looked at again,
 * so a pause landing during a hundred-chapter drain took ten minutes to bite.
 * `drain` now re-reads these between tasks, and they are never more than one
 * housekeeping tick stale.
 */
let paused = false;
let pausedExtensions: readonly string[] = [];

async function refreshGates(): Promise<void> {
  paused = await settings.isPaused();
  pausedExtensions = paused ? [] : await settings.getUploadPausedExtensions();
}

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

async function drain(kind: UploadTaskKind): Promise<Drained> {
  let processed = 0;
  let failed = 0;
  let deferred = 0;
  const budget = DRAIN_BUDGET[kind] ?? DEFAULT_DRAIN_BUDGET;
  // `paused` is re-read every task rather than once at the top: a pause is an
  // operator asking the platform to stop, and waiting out a hundred-chapter
  // drain first is not stopping.
  while (running && !paused && processed + failed + deferred < budget) {
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
 * Work the drain loops have done that has not been reported yet.
 *
 * Five loops run at once and exactly one of them reports: `flushQueueSummary`
 * accumulates per kind and decides when a queue is finished, and calling it
 * from five places would race over those totals. So each drain leaves its
 * counts here and the housekeeping loop picks them all up together.
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

log.info({ kinds: DRAINED_KINDS, discord: notifier.enabled }, "core-uploader started");

/**
 * One queue, drained until it is empty or the budget runs out, then a sleep.
 *
 * Deliberately thin, and the same code for all five kinds: it claims, drains
 * and sleeps. It does not sweep leases, tick the title service, read settings
 * or flush anything, because those are once-per-process concerns and doing them
 * five times over is five times the queries for the same answer. `houseLoop`
 * owns them.
 */
async function drainLoop(kind: UploadTaskKind): Promise<void> {
  while (running) {
    try {
      // The gate is a cached flag, so this costs nothing to check often.
      if (paused) {
        await sleep(IDLE_SLEEP_MS);
        continue;
      }

      const done = await drain(kind);
      report(kind, done);

      // Only this kind's own work decides whether it sleeps. Another queue
      // having been busy says nothing about there being work of this kind.
      const claimed = done.processed + done.failed + done.deferred;
      if (claimed === 0 && running) await sleep(IDLE_SLEEP_MS);
    } catch (err) {
      log.error({ err, kind }, "queue loop iteration failed");
      await sleep(IDLE_SLEEP_MS);
    }
  }
}

/**
 * Everything that is once-per-process rather than once-per-queue: the restart
 * signal, the lease sweep, the pause gates, the reporting settings, the title
 * service, and all of the notification and metric flushing.
 *
 * It is also the loop that decides when the process stops, so it is the only
 * one that consults the restart signal.
 */
async function houseLoop(): Promise<void> {
  while (running) {
    // Between iterations, so we are never holding a task lease, and ahead of the
    // pause gate: a paused uploader must still be restartable.
    if (await shouldRestart(settings, "uploader", log)) break;

    try {
      await tasks.sweepExpired();
      await refreshGates();

      if (paused) {
        log.debug("uploads paused, not claiming tasks");
      } else {
        if (pausedExtensions.length > 0) {
          log.debug({ pausedExtensions }, "holding queued work for paused extensions");
        }
        // Once per tick, not per task: a setting changed mid-drain should not
        // split one batch into two reporting styles.
        await workers.refreshReporting();

        // Title creation is its own MangaDex-facing pass; a failure there must
        // not cost us the bookkeeping below, so it gets its own guard.
        try {
          await titles.tick();
        } catch (err) {
          log.error({ err }, "title service tick failed");
        }
      }

      await workers.flushNotifications();
      // Depths first: the summary only announces a queue as finished once
      // nothing is left in it, so it needs the current remainder to decide.
      const remaining = await publishDepths();
      // Every loop's counts, taken together and handed over in one call. The
      // swap is synchronous, so no drain can slip a count in between the copy
      // and the clear.
      const drained = new Map(unreported);
      unreported.clear();
      await workers.flushQueueSummary(drained, remaining);
    } catch (err) {
      log.error({ err }, "uploader housekeeping iteration failed");
    }

    if (running) await sleep(IDLE_SLEEP_MS);
  }
  // The drain loops only ever stop on this flag, so a restart signal or a
  // failure that breaks out of here has to take them down too.
  running = false;
}

// The gates start closed until the first read says otherwise: a drain loop that
// began before `houseLoop` had answered would claim tasks on a paused platform.
// A failure here leaves them closed and lets `houseLoop` retry, rather than
// taking the process down over a database that is momentarily unreachable --
// the loops below are built to wait, and this is the one read that happens
// before any of them can.
paused = true;
try {
  await refreshGates();
} catch (err) {
  log.error({ err }, "could not read the pause settings at startup, holding until they are");
}

// All awaited, so shutdown waits for whichever loops are mid-task; none of them
// reject, so `all` is safe here and a crash in one still stops the rest through
// the `running` flag.
await Promise.all([houseLoop(), ...DRAINED_KINDS.map((kind) => drainLoop(kind))]);

await workers.flushNotifications();
await metricsServer.close();
await prisma.$disconnect();
log.info("core-uploader stopped");
