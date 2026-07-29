import { loadConfig } from "../config.js";
import { createLogger } from "../logging.js";
import { getPrisma } from "../db.js";
import { buildContext } from "../core/api/context.js";
import { buildServer } from "../core/api/server.js";
import { MdClient } from "../core/md/client.js";
import { DiscordNotifier } from "../core/md/webhook.js";
import { TitleService } from "../core/md/titleService.js";

const config = loadConfig();
const log = createLogger("core-api", config.logLevel);
const prisma = getPrisma(config.databaseUrl);
const ctx = buildContext(prisma, config, log);
// The API holds MD credentials in the same env as the uploader, so operator
// approvals of untracked series can create titles synchronously. Without
// credentials the endpoint reports 503 and auto-creation still runs in the
// uploader service.
if (config.mdUsername && config.mdPassword) {
  const md = new MdClient(config, prisma, log);
  const notifier = DiscordNotifier.fromConfig(config, log);
  ctx.titleService = new TitleService(prisma, md, notifier, log);
}
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
