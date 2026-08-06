import { describe, expect, it, vi } from "vitest";
import {
  RESTART_REQUEST_KEY,
  RESTART_REQUEST_TTL_MS,
  type RestartSettingsStore,
  restartAckKey,
  shouldRestart,
  writeRestartRequest,
} from "../../src/core/sysops/restartSignal.js";

/**
 * `shouldRestart` is the call each service loop makes once per iteration.
 *
 * These exist because the original bug in this area was not a wrong answer, it
 * was no call at all: `restartSignal.ts` was complete and correct, and
 * scheduler.ts, processor.ts and uploader.ts contained zero references to it -
 * so the dashboard's restart button wrote its row and nothing ever exited. The
 * signal's own semantics (ack-once, TTL, wrong target) are covered in
 * test/integration/sysops.test.ts; what is covered here is the wrapper the
 * services actually call, and specifically its failure behaviour, because that
 * is what decides whether a database hiccup takes a service down.
 */

/** The store is two methods, so a Map is a complete implementation of it. */
function memoryStore(initial: Record<string, string> = {}) {
  const rows = new Map<string, string>(Object.entries(initial));
  const store: RestartSettingsStore = {
    getSetting: async (key) => rows.get(key) ?? null,
    setSetting: async (key, value) => void rows.set(key, value),
  };
  return { store, rows };
}

const logger = () => ({ info: vi.fn(), warn: vi.fn() });

const request = (target: string, at = new Date().toISOString()) =>
  JSON.stringify({ target, requestedAt: at, requestedBy: "user:iam@ardax.dev" });

describe("shouldRestart", () => {
  it("is false when nothing has been requested", async () => {
    const { store } = memoryStore();
    const log = logger();
    expect(await shouldRestart(store, "scheduler", log)).toBe(false);
    expect(log.info).not.toHaveBeenCalled();
  });

  it("is true for a request aimed at this service, and says who asked", async () => {
    const { store } = memoryStore({ [RESTART_REQUEST_KEY]: request("scheduler") });
    const log = logger();

    expect(await shouldRestart(store, "scheduler", log)).toBe(true);
    // The operator who pressed the button belongs in the service's own log, not
    // only in the audit table; this line is what someone reads when asking why
    // the scheduler bounced.
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ target: "scheduler", requestedBy: "user:iam@ardax.dev" }),
      expect.stringContaining("restart"),
    );
    // Not `service`: each logger is already bound to one, and repeating it here
    // emitted a duplicate JSON key in the real output.
    expect(log.info.mock.calls[0]![0]).not.toHaveProperty("service");
  });

  it("is true for every service when the target is all", async () => {
    const { store } = memoryStore({ [RESTART_REQUEST_KEY]: request("all") });
    for (const service of ["scheduler", "processor", "uploader"] as const) {
      expect(await shouldRestart(store, service, logger())).toBe(true);
    }
  });

  it("is false for a request aimed at a different service", async () => {
    const { store } = memoryStore({ [RESTART_REQUEST_KEY]: request("uploader") });
    expect(await shouldRestart(store, "scheduler", logger())).toBe(false);
  });

  it("is true once and then false, so a fast restart cannot loop", async () => {
    // A service that comes back in five seconds would otherwise see the same
    // fresh request, exit again, and keep doing so until the TTL expired.
    const { store, rows } = memoryStore({ [RESTART_REQUEST_KEY]: request("processor") });

    expect(await shouldRestart(store, "processor", logger())).toBe(true);
    expect(rows.get(restartAckKey("processor"))).toBeTruthy();
    expect(await shouldRestart(store, "processor", logger())).toBe(false);
    expect(await shouldRestart(store, "processor", logger())).toBe(false);
  });

  it("acknowledges per service, so one service's exit does not consume another's", async () => {
    const { store } = memoryStore({ [RESTART_REQUEST_KEY]: request("all") });

    expect(await shouldRestart(store, "scheduler", logger())).toBe(true);
    // The uploader has not seen this request yet, whatever the scheduler did.
    expect(await shouldRestart(store, "uploader", logger())).toBe(true);
    expect(await shouldRestart(store, "scheduler", logger())).toBe(false);
  });

  it("ignores a request older than its TTL, so a stale row cannot restart anything", async () => {
    // A row left behind by a crash must not bounce a service days later.
    const stale = new Date(Date.now() - RESTART_REQUEST_TTL_MS - 60_000).toISOString();
    const { store } = memoryStore({ [RESTART_REQUEST_KEY]: request("scheduler", stale) });
    expect(await shouldRestart(store, "scheduler", logger())).toBe(false);
  });

  it("ignores an unparseable row instead of throwing inside a service loop", async () => {
    const { store } = memoryStore({ [RESTART_REQUEST_KEY]: "{ not json" });
    const log = logger();
    expect(await shouldRestart(store, "scheduler", log)).toBe(false);
    expect(log.warn).not.toHaveBeenCalled(); // Parsed as absent, not as an error.
  });

  it("keeps the service running when the settings read fails, and warns", async () => {
    // The service's real work is unaffected by a failed read of a *setting*.
    // Exiting here would turn a transient database blip into a restart of every
    // core service at once; the request stays in the row for the next iteration.
    const store: RestartSettingsStore = {
      getSetting: async () => {
        throw new Error("connection terminated unexpectedly");
      },
      setSetting: async () => {},
    };
    const log = logger();

    expect(await shouldRestart(store, "uploader", log)).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ restartTarget: "uploader" }),
      expect.stringContaining("restart request"),
    );
  });

  it("does not exit when the ack write fails, so the exit is never unrecorded", async () => {
    // Acking before exiting is what makes this idempotent. If the ack cannot be
    // written, exiting anyway would mean coming back to the same live request -
    // the crash loop the ack exists to prevent.
    const { rows } = memoryStore({ [RESTART_REQUEST_KEY]: request("scheduler") });
    const store: RestartSettingsStore = {
      getSetting: async (key) => rows.get(key) ?? null,
      setSetting: async () => {
        throw new Error("read-only transaction");
      },
    };
    const log = logger();

    expect(await shouldRestart(store, "scheduler", log)).toBe(false);
    expect(log.warn).toHaveBeenCalled();
  });

  it("round-trips a request written by the API", async () => {
    // Same module both sides, so a change to the row's shape breaks here rather
    // than silently making the button do nothing.
    const { store } = memoryStore();
    await writeRestartRequest(store, {
      target: "all",
      requestedAt: new Date().toISOString(),
      requestedBy: "user:iam@ardax.dev",
    });
    expect(await shouldRestart(store, "processor", logger())).toBe(true);
  });
});
