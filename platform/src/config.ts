import { z } from "zod";

/**
 * All configuration is environment-driven (12-factor). Secrets support the
 * Docker-secrets convention: any VAR may instead be provided as VAR_FILE
 * pointing at a file whose contents are the value.
 */
import { readFileSync } from "node:fs";

function env(name: string): string | undefined {
  const fileVar = process.env[`${name}_FILE`];
  if (fileVar) {
    return readFileSync(fileVar, "utf8").trim();
  }
  return process.env[name];
}

const ConfigSchema = z.object({
  databaseUrl: z.string().min(1),
  port: z.coerce.number().int().default(8100),
  host: z.string().default("0.0.0.0"),
  /** Admin bearer token for operator endpoints (bot/dash/CLI). */
  adminToken: z.string().min(16).optional(),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),

  // Lease/queue tuning
  leaseTtlSeconds: z.coerce.number().int().min(30).default(300),
  sweepIntervalSeconds: z.coerce.number().int().min(5).default(30),
  schedulerIntervalSeconds: z.coerce.number().int().min(5).default(30),
  retryBaseSeconds: z.coerce.number().int().min(1).default(60),
  retryMaxSeconds: z.coerce.number().int().min(60).default(3600),
  leasePollWaitSeconds: z.coerce.number().int().min(1).max(60).default(25),

  // MangaDex (core only; NEVER passed to workers)
  mdApiUrl: z.string().default("https://api.mangadex.org"),
  mdAuthUrl: z
    .string()
    .default("https://auth.mangadex.org/realms/mangadex/protocol/openid-connect"),
  mdUsername: z.string().optional(),
  mdPassword: z.string().optional(),
  mdClientId: z.string().optional(),
  mdClientSecret: z.string().optional(),
  mdRatelimitMs: z.coerce.number().int().default(2000),
  uploadRetry: z.coerce.number().int().min(1).default(3),

  // Discord notifications (core only)
  discordWebhookUrls: z.string().default(""),

  // Worker agent settings (worker process only)
  coreUrl: z.string().optional(),
  workerToken: z.string().optional(),
  enrollToken: z.string().optional(),
  workerName: z.string().optional(),
  workerStatePath: z.string().default("/var/lib/publoader-worker"),
  runnerPython: z.string().default("python3"),
  runnerExtraArgs: z.string().default(""),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(overrides: Partial<Record<string, string>> = {}): Config {
  const get = (n: string) => overrides[n] ?? env(n);
  return ConfigSchema.parse({
    databaseUrl: get("DATABASE_URL") ?? "",
    port: get("PORT"),
    host: get("HOST"),
    adminToken: get("ADMIN_TOKEN"),
    logLevel: get("LOG_LEVEL"),
    leaseTtlSeconds: get("LEASE_TTL_SECONDS"),
    sweepIntervalSeconds: get("SWEEP_INTERVAL_SECONDS"),
    schedulerIntervalSeconds: get("SCHEDULER_INTERVAL_SECONDS"),
    retryBaseSeconds: get("RETRY_BASE_SECONDS"),
    retryMaxSeconds: get("RETRY_MAX_SECONDS"),
    leasePollWaitSeconds: get("LEASE_POLL_WAIT_SECONDS"),
    mdApiUrl: get("MANGADEX_API_URL"),
    mdAuthUrl: get("MANGADEX_AUTH_URL"),
    mdUsername: get("MANGADEX_USERNAME"),
    mdPassword: get("MANGADEX_PASSWORD"),
    mdClientId: get("MANGADEX_CLIENT_ID"),
    mdClientSecret: get("MANGADEX_CLIENT_SECRET"),
    mdRatelimitMs: get("MANGADEX_RATELIMIT_MS"),
    uploadRetry: get("UPLOAD_RETRY"),
    discordWebhookUrls: get("DISCORD_WEBHOOK_URLS"),
    coreUrl: get("CORE_URL"),
    workerToken: get("WORKER_TOKEN"),
    enrollToken: get("ENROLL_TOKEN"),
    workerName: get("WORKER_NAME"),
    workerStatePath: get("WORKER_STATE_PATH"),
    runnerPython: get("RUNNER_PYTHON"),
    runnerExtraArgs: get("RUNNER_EXTRA_ARGS"),
  });
}
