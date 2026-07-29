import { loadConfig } from "../config.js";
import { createLogger } from "../logging.js";
import { FatalAuthError, WorkerAgent } from "../worker/agent.js";

const config = loadConfig();
const log = createLogger("worker-agent", config.logLevel);

/** Optional narrowing: WORKER_EXTENSIONS=mangaplus,viz */
const extensions = (process.env["WORKER_EXTENSIONS"] ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

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
        "worker credentials are not accepted by the core — an operator must revoke this worker and re-enroll it with a fresh ENROLL_TOKEN",
      );
      process.exit(78); // EX_CONFIG: restarting will not help
    }
    log.fatal({ err }, "worker agent crashed");
    process.exit(1);
  });
