import type { PrismaClient } from "@prisma/client";
import type { Logger } from "../../logging.js";
import type { AuditLog, SettingsStore } from "../store/settings.js";
import type { MdExtendedApi } from "./client.js";
import {
  DuplicateScanner,
  type DuplicateScanOptions,
  type DuplicateScanProgress,
  type DuplicateScanReport,
} from "./duplicateScan.js";

/**
 * Run a duplicate scan in the background and let callers poll it.
 *
 * Same shape, and the same reasons, as ReconcileRunner: an unscoped scan walks
 * a whole group at the MangaDex client's rate limit, which is minutes, and a
 * request held open that long dies to the tunnel in front of the API having
 * done all the work and delivered none of it. So the request starts the work
 * and returns, the state lives in a `settings` row anything can read, and the
 * dashboard, the CLI and the bot all watch the same run — including one they
 * did not start.
 *
 * One at a time, per the same expiring lock. Two scans racing would both walk
 * the same group, doubling the slowest thing here, and with `apply` they would
 * queue deletions from two separately-taken snapshots. The queue itself is safe
 * either way — a DELETE is keyed on the chapter id, so the second one lands on
 * the same row — but a report that describes neither run is not.
 *
 * Separate from the reconcile lock on purpose. The two passes read the same
 * MangaDex data and answer different questions, and an operator waiting out a
 * reconcile to ask "which chapters are duplicated?" is a queue for no reason.
 */

const STATE_KEY = "chapters_duplicates_state";

/**
 * How long a `running` state may go without moving before a new run may replace
 * it. Progress is written per MangaDex page, so a live scan refreshes this far
 * more often than the window and only a dead one falls behind.
 */
const STALE_AFTER_MS = 5 * 60 * 1000;

/** What was asked for, echoed back so a poller can describe the run it found. */
export interface DuplicateRunOptions {
  apply: boolean;
  extensions: string[];
  mangaIds: string[];
}

export type DuplicateRunState =
  | { state: "idle" }
  | {
      state: "running";
      startedAt: string;
      /** Last time progress moved; how staleness is judged. */
      beatAt: string;
      actor: string;
      options: DuplicateRunOptions;
      progress: DuplicateScanProgress;
    }
  | {
      state: "done";
      startedAt: string;
      finishedAt: string;
      actor: string;
      options: DuplicateRunOptions;
      report: DuplicateScanReport;
    }
  | {
      state: "failed";
      startedAt: string;
      finishedAt: string;
      actor: string;
      options: DuplicateRunOptions;
      error: string;
      /** The steps as they stood when it died; absent for an abandoned run. */
      progress?: DuplicateScanProgress;
    };

export interface DuplicateRunnerDeps {
  prisma: PrismaClient;
  md: MdExtendedApi;
  log: Logger;
  audit: AuditLog;
  settings: SettingsStore;
  /**
   * The MangaDex user publoader uploads as; passed to the scanner, which
   * deletes nothing it cannot show we uploaded.
   */
  botUserId?: string | null;
}

export class DuplicateRunner {
  constructor(private readonly deps: DuplicateRunnerDeps) {}

  /** The last known state, or idle when nothing has ever run. */
  async status(): Promise<DuplicateRunState> {
    const raw = await this.deps.settings.getSetting(STATE_KEY);
    if (raw === null) return { state: "idle" };
    let parsed: DuplicateRunState;
    try {
      parsed = JSON.parse(raw) as DuplicateRunState;
    } catch {
      this.deps.log.warn("duplicate scan state is not readable json; treating as idle");
      return { state: "idle" };
    }
    if (parsed.state === "running" && this.isStale(parsed)) {
      return {
        state: "failed",
        startedAt: parsed.startedAt,
        finishedAt: parsed.beatAt,
        actor: parsed.actor,
        options: parsed.options,
        error: "the scan stopped reporting progress; it was most likely interrupted by a restart",
        progress: parsed.progress,
      };
    }
    return parsed;
  }

  private isStale(run: { beatAt: string }): boolean {
    const beat = Date.parse(run.beatAt);
    return !Number.isFinite(beat) || Date.now() - beat > STALE_AFTER_MS;
  }

  /**
   * Start a scan, unless one is already going.
   *
   * Returns the state a poller should now watch: the new run, or the one
   * already in flight. `started: false` is not an error — it is the honest
   * answer to a second click on a slow button.
   */
  async start(
    options: DuplicateRunOptions,
    actor: string,
  ): Promise<{ started: boolean; status: DuplicateRunState }> {
    const current = await this.status();
    if (current.state === "running") return { started: false, status: current };

    const startedAt = new Date().toISOString();
    const running: DuplicateRunState = {
      state: "running",
      startedAt,
      beatAt: startedAt,
      actor,
      options,
      progress: { steps: [] },
    };
    await this.write(running);

    // Deliberately not awaited: the caller is an HTTP request that must answer
    // now. Errors are caught inside `execute`, so nothing here can reject.
    void this.execute(options, actor, startedAt);
    return { started: true, status: running };
  }

  private async execute(
    options: DuplicateRunOptions,
    actor: string,
    startedAt: string,
  ): Promise<void> {
    let lastWrite = 0;
    /**
     * The step states as of the last write, so a step starting or finishing can
     * skip the throttle. Counts move constantly and can wait; a row ticking
     * over is the event an operator is watching for. Per execution, never
     * module-level: two runs sharing it would each suppress the other's events.
     */
    let lastStates = "";
    const changedState = (progress: DuplicateScanProgress): boolean => {
      const signature = progress.steps.map((step) => `${step.id}:${step.state}`).join(",");
      const changed = signature !== lastStates;
      lastStates = signature;
      return changed;
    };
    const beat = (progress: DuplicateScanProgress, force = false): void => {
      const now = Date.now();
      if (!force && now - lastWrite < 500) return;
      lastWrite = now;
      void this.write({
        state: "running",
        startedAt,
        beatAt: new Date(now).toISOString(),
        actor,
        options,
        progress,
      }).catch((error: unknown) => {
        // A lost progress write is cosmetic; losing the scan over it is not.
        this.deps.log.warn({ error }, "could not write duplicate scan progress");
      });
    };

    const scanner = new DuplicateScanner({
      prisma: this.deps.prisma,
      md: this.deps.md,
      log: this.deps.log,
      audit: this.deps.audit,
      onProgress: (progress) => beat(progress, changedState(progress)),
      botUserId: this.deps.botUserId ?? null,
    });

    const scanOptions: DuplicateScanOptions = { ...options, actor };
    try {
      const report = await scanner.run(scanOptions);
      await this.write({
        state: "done",
        startedAt,
        finishedAt: new Date().toISOString(),
        actor,
        options,
        report,
      });
    } catch (error) {
      // The run is over either way; what must not happen is the state staying
      // `running` forever, because that locks out every later attempt until the
      // stale window passes.
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log.error({ error }, "duplicate scan failed");
      await this.write({
        state: "failed",
        startedAt,
        finishedAt: new Date().toISOString(),
        actor,
        options,
        error: message,
        progress: { steps: scanner.steps() },
      }).catch((writeError: unknown) => {
        this.deps.log.error({ error: writeError }, "could not record the duplicate scan failure");
      });
    }
  }

  private async write(state: DuplicateRunState): Promise<void> {
    await this.deps.settings.setSetting(STATE_KEY, JSON.stringify(state));
  }
}
