import { loadConfig } from "../config.js";
import { createLogger } from "../logging.js";
import { getPrisma } from "../db.js";
import { buildContext } from "../core/api/context.js";
import { buildServer } from "../core/api/server.js";

const config = loadConfig();
const log = createLogger("core-api", config.logLevel);
const prisma = getPrisma(config.databaseUrl);
const ctx = buildContext(prisma, config, log);
const server = buildServer(ctx);

const shutdown = async (signal: string) => {
  log.info({ signal }, "shutting down");
  await server.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

server
  .listen({ port: config.port, host: config.host })
  .then(() => log.info({ port: config.port }, "core-api listening"))
  .catch((err) => {
    log.error({ err }, "failed to start");
    process.exit(1);
  });
