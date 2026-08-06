import { loadConfig } from "../config.js";
import { createLogger } from "../logging.js";
import { touchHeartbeat } from "../core/observability/heartbeat.js";
import { FatalAuthError, WorkerAgent } from "../worker/agent.js";

const config = loadConfig();
const log = createLogger("worker-agent", config.logLevel);

/** Optional narrowing: WORKER_EXTENSIONS=mangaplus,viz */
const extensions = (process.env["WORKER_EXTENSIONS"] ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Liveness heartbeat for the container HEALTHCHECK.
 *
 * The worker accepts no inbound connections, so there is nothing to probe over
 * HTTP; the file's freshness is the probe. What it must catch is an agent that
 * is *running but no longer working*; restart-on-exit already handles a crash,
 * and that is the only thing it handles.
 *
 * Progress is observed where it is observable from this entry point: the
 * agent's HTTP traffic to the core about work. Lease polls happen every
 * LEASE_POLL_WAIT_SECONDS while idle, and lease renewals every lease TTL/3
 * while a job runs, so between them the loop is covered in both states. If the
 * loop stops turning, both stop and the file goes stale.
 *
 * /api/v1/worker/heartbeat is deliberately EXCLUDED. It is a setInterval that
 * keeps firing regardless of what the lease loop is doing, so counting it would
 * make this probe unable to fail; which is exactly the defect this replaces
 * (the old HEALTHCHECK stat'd a file nothing ever wrote and treated missing as
 * healthy, so a wedged worker reported healthy forever).
 */
const upstreamFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const response = await upstreamFetch(input, init);
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("/api/v1/worker/") && !url.includes("/api/v1/worker/heartbeat")) {
    touchHeartbeat(config.workerStatePath);
  }
  return response;
};

// Written before enrollment so that a MISSING file always means "this process
// never got off the ground", never "it is still starting up".
touchHeartbeat(config.workerStatePath);

const agent = new WorkerAgent({
  config,
  log,
  ...(extensions.length > 0 ? { extensions } : {}),
});

process.on("SIGTERM", () => agent.requestShutdown("SIGTERM"));
process.on("SIGINT", () => agent.requestShutdown("SIGINT"));

agent
  .run()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    if (err instanceof FatalAuthError) {
      log.fatal(
        { err },
        "worker credentials are not accepted by the core; an operator must revoke this worker and re-enroll it with a fresh ENROLL_TOKEN",
      );
      process.exit(78); // EX_CONFIG: restarting will not help
    }
    log.fatal({ err }, "worker agent crashed");
    process.exit(1);
  });
