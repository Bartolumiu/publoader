/**
 * The clock behind the weekly series-map sync.
 *
 * It lives in core-api rather than core-scheduler for one concrete reason:
 * core-scheduler sits on the `data` network with no egress and no GitHub
 * credentials, while core-api already holds `GITHUB_TOKEN` and reaches GitHub
 * for every webhook publish. Moving the job would mean opening the scheduler to
 * the internet, which is a much larger change than a timer.
 *
 * The timer is deliberately dumb: it asks "is it due?" often and cheaply, and
 * the answer is a row in `settings`, not a variable in this process. That is
 * what makes a restart, a redeploy or a second replica harmless; see
 * `MapSyncService.runIfDue`.
 */
import type { Logger } from "../../logging.js";
import type { MapSyncService } from "./service.js";

/** How often to ask. An hour of slack on a weekly job is not worth a finer tick. */
export const MAP_SYNC_CHECK_INTERVAL_MS = 3_600_000;

/**
 * Delay before the first check, so a boot storm (a redeploy restarting every
 * service at once) does not put the first question to GitHub while migrations
 * are still settling.
 */
export const MAP_SYNC_FIRST_CHECK_MS = 60_000;

export interface MapSyncTimer {
  stop(): void;
}

export function startMapSyncTimer(
  service: MapSyncService,
  log: Logger,
  opts: { checkIntervalMs?: number; firstCheckMs?: number } = {},
): MapSyncTimer {
  const unavailable = service.unavailableReason();
  if (unavailable) {
    log.info({ reason: unavailable }, "series-map sync is off");
    return { stop: () => {} };
  }

  const check = (): void => {
    void service.runIfDue().catch((err) => {
      // Never fatal: this is a bookkeeping job, and core-api's actual work is
      // serving requests.
      log.error({ err }, "series-map sync failed");
    });
  };

  const first = setTimeout(check, opts.firstCheckMs ?? MAP_SYNC_FIRST_CHECK_MS);
  const repeat = setInterval(check, opts.checkIntervalMs ?? MAP_SYNC_CHECK_INTERVAL_MS);
  // Neither timer should hold the process open on its own; the HTTP server is
  // what keeps core-api alive.
  first.unref();
  repeat.unref();

  return {
    stop: () => {
      clearTimeout(first);
      clearInterval(repeat);
    },
  };
}
