/**
 * Discord control bot process.
 *
 * Replaces publoader/bot/server.py. The difference that matters is what this
 * process is allowed to touch: the legacy bot imported the whole publoader
 * package, spoke to the scheduler over a Unix socket in the same container, and
 * held a Docker socket so it could restart things. This one is an HTTPS client
 * of the admin API and nothing else; no DATABASE_URL, no MangaDex credential,
 * no docker.sock. Compromising it gets you the scopes on BOT_API_TOKEN.
 */
import { readFileSync } from "node:fs";
import { loadConfig } from "../config.js";
import { createLogger } from "../logging.js";
import { AdminApiClient, DEFAULT_CORE_URL } from "../bot/apiClient.js";
import { loadAuthzConfig } from "../bot/authz.js";
import { EX_CONFIG, FatalBotConfigError, PubloaderBot } from "../bot/bot.js";

const config = loadConfig();
const log = createLogger("discord-bot", config.logLevel);

/**
 * Read a secret honouring the `<VAR>_FILE` Docker-secrets convention that
 * config.ts uses for everything else. The bot's two credentials are not in the
 * shared config schema; the schema is loaded by every core service, and a
 * Discord bot token has no business being in the uploader's process memory.
 */
function secret(name: string): string | undefined {
  const path = process.env[`${name}_FILE`];
  if (path) {
    // A missing secret file is a deployment error, not a "run without it"
    // signal; let the read throw and take the process down with the path in
    // the message.
    return readFileSync(path, "utf8").trim() || undefined;
  }
  // Quotes are stripped because a token pasted as DISCORD_BOT_TOKEN="MTx…"
  // into an env file arrives with them attached, and Discord's only answer to
  // that is "Improper token"; a failure the legacy bot had to document.
  return process.env[name]?.trim().replace(/^['"]|['"]$/g, "") || undefined;
}

function fatal(message: string): never {
  log.fatal(message);
  process.exit(EX_CONFIG);
}

const discordToken = secret("DISCORD_BOT_TOKEN");
if (!discordToken) {
  fatal(
    "DISCORD_BOT_TOKEN is not set. Copy the *bot* token from the Discord Developer Portal " +
      "(Bot → Reset Token): not the client secret, not the public key.",
  );
}

const apiToken = secret("BOT_API_TOKEN");
if (!apiToken) {
  fatal(
    "BOT_API_TOKEN is not set. The bot needs its own scoped control-plane token; see docs/bot.md. " +
      "Do not reuse the platform's root ADMIN_TOKEN.",
  );
}

const api = new AdminApiClient({
  baseUrl: config.coreUrl ?? DEFAULT_CORE_URL,
  token: apiToken,
  log,
});

const bot = new PubloaderBot({
  discordToken,
  api,
  authz: loadAuthzConfig(process.env),
  log,
});

// Compose sends SIGTERM on `stop`/`down`; closing the gateway connection
// cleanly stops Discord from holding the session open and re-delivering.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void bot.stop(signal).then(() => process.exit(0));
  });
}

bot.start().catch((err: unknown) => {
  if (err instanceof FatalBotConfigError) {
    log.fatal({ err }, `bot cannot start: ${err.message}`);
    process.exit(EX_CONFIG);
  }
  log.fatal({ err }, "discord bot crashed");
  process.exit(1);
});
