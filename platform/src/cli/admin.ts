#!/usr/bin/env node
/**
 * `publoader-admin` — operator CLI for the platform control plane.
 *
 * Every subcommand is a thin wrapper over an admin API endpoint (see
 * docs/ipc-to-api-mapping.md for the legacy IPC equivalences). The CLI holds no
 * database credentials and never talks to Postgres directly: the core API is
 * the only writer, so the CLI is safe to run from a laptop.
 *
 * Configuration (env):
 *   PUBLOADER_API_URL     default https://publoader.ardax.dev
 *   PUBLOADER_ADMIN_TOKEN required for every command
 *   USER                  sent as X-Actor so the audit trail names a human
 */
import { Command } from "commander";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import AdmZip from "adm-zip";

const DEFAULT_API_URL = "https://publoader.ardax.dev";

function apiBase(): string {
  return (process.env["PUBLOADER_API_URL"] ?? DEFAULT_API_URL).replace(/\/+$/, "");
}

function adminToken(): string {
  const token = process.env["PUBLOADER_ADMIN_TOKEN"];
  if (!token) {
    fail("PUBLOADER_ADMIN_TOKEN is not set");
  }
  return token;
}

function actor(): string {
  return process.env["USER"] ?? process.env["USERNAME"] ?? "unknown";
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  json?: unknown;
  raw?: { body: Buffer; contentType: string; headers?: Record<string, string> };
  query?: Record<string, string | number | undefined>;
};

/**
 * One request against the admin API. Non-2xx responses abort the process with
 * the server's error message — an operator running a script wants a non-zero
 * exit, not a partially-applied change reported as success.
 */
async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = new URL(apiBase() + path);
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${adminToken()}`,
    "x-actor": actor(),
    accept: "application/json",
  };
  let body: string | Uint8Array | undefined;
  if (opts.raw) {
    headers["content-type"] = opts.raw.contentType;
    Object.assign(headers, opts.raw.headers ?? {});
    body = new Uint8Array(opts.raw.body);
  } else if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.json);
  }

  let res: Response;
  try {
    res = await fetch(url, { method: opts.method ?? "GET", headers, body });
  } catch (err) {
    return fail(`cannot reach ${url.origin}: ${(err as Error).message}`);
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }

  if (!res.ok) {
    const detail =
      (parsed as { error?: string; message?: string }).error ??
      (parsed as { message?: string }).message ??
      text.slice(0, 500);
    return fail(`${res.status} ${res.statusText} from ${url.pathname}: ${detail}`);
  }
  return parsed as T;
}

// ---------------------------------------------------------------- formatting

type Column<T> = { header: string; get: (row: T) => unknown };

function cell(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Left-aligned fixed-width table. CLI output is the one place console.log is correct. */
function table<T>(rows: T[], columns: Column<T>[], emptyNote = "(none)"): void {
  if (rows.length === 0) {
    console.log(emptyNote);
    return;
  }
  const cells = rows.map((row) => columns.map((col) => cell(col.get(row))));
  const widths = columns.map((col, i) =>
    Math.max(col.header.length, ...cells.map((r) => (r[i] ?? "").length)),
  );
  const line = (values: string[]) =>
    values.map((v, i) => v.padEnd(widths[i] ?? 0)).join("  ").trimEnd();

  console.log(line(columns.map((c) => c.header)));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const row of cells) console.log(line(row));
}

function kv(obj: Record<string, unknown>): void {
  const width = Math.max(0, ...Object.keys(obj).map((k) => k.length));
  for (const [key, value] of Object.entries(obj)) {
    console.log(`${key.padEnd(width)}  ${cell(value)}`);
  }
}

function ok(message: string): void {
  console.log(message);
}

function ago(iso: unknown): string {
  if (typeof iso !== "string") return "-";
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return "-";
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

// ------------------------------------------------------------------ commands

const program = new Command();
program
  .name("publoader-admin")
  .description("Operator CLI for the Publoader distributed platform")
  .version("1.0.0")
  .showHelpAfterError();

// ---- enroll tokens ----
const enroll = program.command("enroll-token").description("worker enrollment tokens");

enroll
  .command("create")
  .description("mint a single-use enrollment token for a new worker host")
  .option("--trust", "issue a TRUSTED-tier token (default COMMUNITY)", false)
  .option("--note <text>", "free-text note recorded with the token")
  .option("--ttl-hours <n>", "validity window in hours", "24")
  .action(async (opts: { trust: boolean; note?: string; ttlHours: string }) => {
    const ttlHours = Number(opts.ttlHours);
    if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > 720) {
      fail("--ttl-hours must be an integer between 1 and 720");
    }
    const res = await api<{ token: string; expiresAt: string }>(
      "/api/v1/admin/enroll-tokens",
      {
        method: "POST",
        json: {
          trust: opts.trust ? "TRUSTED" : "COMMUNITY",
          ...(opts.note ? { note: opts.note } : {}),
          ttlHours,
        },
      },
    );
    kv({
      token: res.token,
      trust: opts.trust ? "TRUSTED" : "COMMUNITY",
      expiresAt: res.expiresAt,
    });
    console.log("");
    console.log("This token is shown once. Hand it to the worker host as ENROLL_TOKEN.");
  });

// ---- workers ----
const workers = program.command("workers").description("worker fleet");

workers
  .command("list")
  .description("list enrolled workers")
  .action(async () => {
    const res = await api<{ workers: Record<string, unknown>[] }>("/api/v1/admin/workers");
    table(res.workers, [
      { header: "ID", get: (w) => w["id"] },
      { header: "NAME", get: (w) => w["name"] },
      { header: "STATUS", get: (w) => w["status"] },
      { header: "TRUST", get: (w) => w["trust"] },
      { header: "AGENT", get: (w) => w["agentVersion"] },
      { header: "HEARTBEAT", get: (w) => ago(w["lastHeartbeatAt"]) },
    ], "no workers enrolled");
  });

for (const action of ["drain", "activate", "revoke"] as const) {
  const help = {
    drain: "stop leasing new jobs to a worker (in-flight job finishes)",
    activate: "return a drained worker to service",
    revoke: "permanently invalidate a worker's credential",
  }[action];
  workers
    .command(`${action} <id>`)
    .description(help)
    .action(async (id: string) => {
      const res = await api<{ status: string }>(`/api/v1/admin/workers/${id}/${action}`, {
        method: "POST",
      });
      ok(`worker ${id} -> ${res.status}`);
    });
}

// ---- runs ----
const runs = program.command("runs").description("scrape runs");

runs
  .command("list")
  .description("recent runs, newest first")
  .option("--limit <n>", "how many runs", "25")
  .option("--extension <name>", "filter to one extension")
  .action(async (opts: { limit: string; extension?: string }) => {
    const res = await api<{ runs: Record<string, unknown>[] }>("/api/v1/admin/runs", {
      query: { limit: opts.limit, extension: opts.extension },
    });
    table(res.runs, [
      { header: "ID", get: (r) => r["id"] },
      { header: "EXTENSION", get: (r) => r["extension"] },
      { header: "KIND", get: (r) => r["kind"] },
      { header: "STATE", get: (r) => r["state"] },
      { header: "SEGMENTS", get: (r) => r["segmentsTotal"] },
      { header: "TRIGGERED BY", get: (r) => r["triggeredBy"] },
      { header: "CREATED", get: (r) => ago(r["createdAt"]) },
    ], "no runs");
  });

runs
  .command("show <id>")
  .description("one run and all of its jobs")
  .action(async (id: string) => {
    const res = await api<{ run: Record<string, unknown> & { jobs: Record<string, unknown>[] } }>(
      `/api/v1/admin/runs/${id}`,
    );
    const { jobs, ...run } = res.run;
    kv(run);
    console.log("");
    console.log(`jobs (${jobs.length}):`);
    table(jobs, [
      { header: "ID", get: (j) => j["id"] },
      { header: "SEG", get: (j) => `${Number(j["segmentIndex"]) + 1}/${j["segmentTotal"]}` },
      { header: "STATE", get: (j) => j["state"] },
      { header: "ATTEMPT", get: (j) => `${j["attempt"]}/${j["maxAttempts"]}` },
      { header: "WORKER", get: (j) => j["leaseWorkerId"] },
      { header: "LEASE EXPIRES", get: (j) => j["leaseExpiresAt"] },
      { header: "ERROR", get: (j) => String(j["lastError"] ?? "").slice(0, 60) || "-" },
    ]);
  });

runs
  .command("trigger <extension>")
  .description("create a run now (bypasses the schedule)")
  .option("--kind <kind>", "UPDATE | CLEAN | FORCE", "FORCE")
  .option("--idempotency-key <key>", "reuse a key to make the trigger retry-safe")
  .action(async (extension: string, opts: { kind: string; idempotencyKey?: string }) => {
    const kind = opts.kind.toUpperCase();
    if (!["UPDATE", "CLEAN", "FORCE"].includes(kind)) {
      fail("--kind must be one of UPDATE, CLEAN, FORCE");
    }
    const res = await api<{ runId: string; created: boolean; jobs?: number }>(
      "/api/v1/admin/runs",
      {
        method: "POST",
        json: {
          extension,
          kind,
          ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
        },
      },
    );
    kv({
      runId: res.runId,
      created: res.created,
      jobs: res.jobs ?? "-",
      note: res.created ? "queued" : "idempotency key already existed; no new run",
    });
  });

// ---- jobs ----
const jobs = program.command("jobs").description("individual scrape jobs");

jobs
  .command("cancel <id>")
  .description("request cancellation of a pending or running job")
  .action(async (id: string) => {
    const res = await api<{ result: string }>(`/api/v1/admin/jobs/${id}/cancel`, {
      method: "POST",
    });
    ok(`job ${id} cancel: ${res.result}`);
  });

jobs
  .command("retry <id>")
  .description("replay a dead-lettered job")
  .action(async (id: string) => {
    await api(`/api/v1/admin/jobs/${id}/retry`, { method: "POST" });
    ok(`job ${id} requeued`);
  });

// ---- dead letter / quarantine ----
program
  .command("dead-letter")
  .description("jobs that exhausted retries or hit a permanent error")
  .action(async () => {
    const res = await api<{ jobs: Record<string, unknown>[] }>("/api/v1/admin/dead-letter");
    table(res.jobs, [
      { header: "ID", get: (j) => j["id"] },
      { header: "EXTENSION", get: (j) => j["extension"] },
      { header: "KIND", get: (j) => j["kind"] },
      { header: "ATTEMPTS", get: (j) => `${j["attempt"]}/${j["maxAttempts"]}` },
      { header: "CLASS", get: (j) => j["errorClass"] },
      { header: "WHEN", get: (j) => ago(j["updatedAt"]) },
      { header: "ERROR", get: (j) => String(j["lastError"] ?? "").slice(0, 80) || "-" },
    ], "dead-letter queue is empty");
  });

program
  .command("quarantine")
  .description("result envelopes rejected by schema or policy validation")
  .action(async () => {
    const res = await api<{ quarantined: Record<string, unknown>[] }>(
      "/api/v1/admin/quarantine",
    );
    table(res.quarantined, [
      { header: "ID", get: (q) => q["id"] },
      { header: "JOB", get: (q) => q["jobId"] },
      { header: "WORKER", get: (q) => q["workerId"] },
      { header: "WHEN", get: (q) => ago(q["createdAt"]) },
      { header: "REASON", get: (q) => String(q["rejectReason"] ?? "").slice(0, 90) || "-" },
    ], "nothing quarantined");
  });

// ---- pause / resume ----
program
  .command("pause")
  .description("suspend scheduling and upload task processing")
  .option("--minutes <n>", "auto-resume after N minutes (omit for indefinite)")
  .action(async (opts: { minutes?: string }) => {
    const json: Record<string, unknown> = {};
    if (opts.minutes !== undefined) {
      const minutes = Number(opts.minutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
        fail("--minutes must be an integer between 1 and 1440");
      }
      json["minutes"] = minutes;
    }
    const res = await api<{ indefinite: boolean }>("/api/v1/admin/pause", {
      method: "POST",
      json,
    });
    ok(res.indefinite ? "paused indefinitely" : `paused for ${opts.minutes} minutes`);
  });

program
  .command("resume")
  .description("lift a pause")
  .action(async () => {
    await api("/api/v1/admin/resume", { method: "POST" });
    ok("resumed");
  });

// ---- extensions ----
const extensions = program.command("extensions").description("published extensions");

extensions
  .command("list")
  .description("latest published bundle per extension")
  .action(async () => {
    const res = await api<{ extensions: Record<string, unknown>[] }>(
      "/api/v1/admin/extensions",
    );
    table(res.extensions, [
      { header: "NAME", get: (e) => e["name"] },
      { header: "VERSION", get: (e) => e["version"] },
      { header: "SHA256", get: (e) => String(e["sha256"] ?? "").slice(0, 12) },
      { header: "DISABLED", get: (e) => (e["disabled"] ? "yes" : "no") },
      { header: "PUBLISHED", get: (e) => ago(e["publishedAt"]) },
    ], "no bundles published");
  });

for (const action of ["enable", "disable"] as const) {
  extensions
    .command(`${action} <name>`)
    .description(`${action} scheduling for an extension`)
    .action(async (name: string) => {
      await api(`/api/v1/admin/extensions/${name}/${action}`, { method: "POST" });
      ok(`extension ${name} ${action}d`);
    });
}

// ---- tracked manga (the database replacement for manga_id_map.json) ----
const tracked = program
  .command("tracked")
  .description("external manga id -> MangaDex id mapping");

tracked
  .command("list <extension>")
  .description("every tracked manga for an extension")
  .action(async (extension: string) => {
    const res = await api<{ tracked: Record<string, unknown>[] }>(
      `/api/v1/admin/extensions/${extension}/tracked`,
    );
    table(res.tracked, [
      { header: "MANGA ID", get: (t) => t["mangaId"] },
      { header: "MANGADEX ID", get: (t) => t["mdMangaId"] },
      { header: "SOURCE", get: (t) => t["source"] },
      { header: "ADDED", get: (t) => ago(t["createdAt"]) },
    ], `nothing tracked for ${extension}`);
    if (res.tracked.length > 0) console.log(`\n${res.tracked.length} tracked`);
  });

tracked
  .command("set <extension> <mangaId> <mdMangaId>")
  .description("add or repoint a mapping")
  .action(async (extension: string, mangaId: string, mdMangaId: string) => {
    await api(`/api/v1/admin/extensions/${extension}/tracked`, {
      method: "PUT",
      json: { mangaId, mdMangaId },
    });
    ok(`${extension}: ${mangaId} -> ${mdMangaId}`);
  });

tracked
  .command("remove <extension> <mangaId>")
  .description("stop tracking a manga (does not touch MangaDex)")
  .action(async (extension: string, mangaId: string) => {
    const res = await api<{ removed: boolean }>(
      `/api/v1/admin/extensions/${extension}/tracked/${encodeURIComponent(mangaId)}`,
      { method: "DELETE" },
    );
    ok(res.removed ? `removed ${extension}:${mangaId}` : `no mapping for ${extension}:${mangaId}`);
  });

// ---- extension config (the database replacement for override_options.json) ----
const extConfig = program
  .command("ext-config")
  .description("per-extension override options");

extConfig
  .command("get <extension>")
  .description("print the current override options as JSON")
  .action(async (extension: string) => {
    const res = await api<{ overrideOptions: unknown }>(
      `/api/v1/admin/extensions/${extension}/config`,
    );
    console.log(JSON.stringify(res.overrideOptions, null, 2));
  });

extConfig
  .command("set <extension> [file]")
  .description("replace the override options from a JSON file, or from stdin when omitted")
  .action(async (extension: string, file?: string) => {
    // Reading a whole document from argv would be unusable; a file or a pipe is
    // how an operator actually has this content to hand.
    const raw =
      file && file !== "-"
        ? readFileSync(resolve(file), "utf8")
        : readFileSync(0, "utf8");
    let overrideOptions: unknown;
    try {
      overrideOptions = JSON.parse(raw);
    } catch (err) {
      return fail(`input is not valid JSON: ${(err as Error).message}`);
    }
    if (typeof overrideOptions !== "object" || overrideOptions === null || Array.isArray(overrideOptions)) {
      fail("override options must be a JSON object");
    }
    await api(`/api/v1/admin/extensions/${extension}/config`, {
      method: "PUT",
      json: { overrideOptions },
    });
    ok(`override options replaced for ${extension}`);
  });

// ---- untracked series pipeline ----
const untracked = program
  .command("untracked")
  .description("series an extension reported that have no MangaDex title yet");

untracked
  .command("list")
  .description("untracked candidates, newest first")
  .option("--state <state>", "NEW | CREATING | CREATED | TRACKED | FAILED | SKIPPED")
  .option("--limit <n>", "how many rows", "100")
  .action(async (opts: { state?: string; limit: string }) => {
    const state = opts.state?.toUpperCase();
    const valid = ["NEW", "CREATING", "CREATED", "TRACKED", "FAILED", "SKIPPED"];
    if (state && !valid.includes(state)) fail(`--state must be one of ${valid.join(", ")}`);
    const res = await api<{ untracked: Record<string, unknown>[] }>("/api/v1/admin/untracked", {
      query: { state, limit: opts.limit },
    });
    table(res.untracked, [
      { header: "ID", get: (u) => u["id"] },
      { header: "EXTENSION", get: (u) => u["extension"] },
      { header: "MANGA", get: (u) => String(u["mangaName"] ?? "").slice(0, 40) },
      { header: "LANG", get: (u) => u["mangaLanguage"] },
      { header: "STATE", get: (u) => u["state"] },
      { header: "MANGADEX ID", get: (u) => u["mdMangaId"] },
      { header: "TRIES", get: (u) => u["attempts"] },
      { header: "ERROR", get: (u) => String(u["lastError"] ?? "").slice(0, 50) || "-" },
    ], "no untracked series");
  });

untracked
  .command("approve <id>")
  .description("create the MangaDex title now and start tracking it")
  .action(async (id: string) => {
    const res = await api<{ mdMangaId: string }>(`/api/v1/admin/untracked/${id}/approve`, {
      method: "POST",
    });
    kv({ mdMangaId: res.mdMangaId, url: `https://mangadex.org/title/${res.mdMangaId}` });
  });

untracked
  .command("skip <id>")
  .description("never create a title for this series")
  .action(async (id: string) => {
    await api(`/api/v1/admin/untracked/${id}/skip`, { method: "POST" });
    ok(`untracked ${id} skipped`);
  });

// ---- schedules ----
const schedules = program.command("schedules").description("run schedules");

schedules
  .command("list")
  .description("manifest defaults and database overrides")
  .action(async () => {
    const res = await api<{
      defaults: Record<string, unknown>;
      overrides: Record<string, unknown>;
    }>("/api/v1/admin/schedules");
    const names = [...new Set([...Object.keys(res.defaults), ...Object.keys(res.overrides)])].sort();
    table(
      names,
      [
        { header: "EXTENSION", get: (n) => n },
        { header: "MANIFEST DEFAULT", get: (n) => res.defaults[n] ?? "-" },
        { header: "OVERRIDE", get: (n) => res.overrides[n] ?? "-" },
        {
          header: "EFFECTIVE",
          get: (n) => res.overrides[n] ?? res.defaults[n] ?? "-",
        },
      ],
      "no schedules configured",
    );
  });

schedules
  .command("set <extension> <hour> <minute>")
  .description("override an extension's schedule (UTC)")
  .option("--day <n>", "restrict to a weekday, 0=Monday .. 6=Sunday")
  .action(async (extension: string, hourRaw: string, minuteRaw: string, opts: { day?: string }) => {
    const hour = Number(hourRaw);
    const minute = Number(minuteRaw);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) fail("hour must be 0-23");
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) fail("minute must be 0-59");
    const json: Record<string, unknown> = { hour, minute };
    if (opts.day !== undefined) {
      const day = Number(opts.day);
      if (!Number.isInteger(day) || day < 0 || day > 6) fail("--day must be 0-6");
      json["day"] = day;
    }
    await api(`/api/v1/admin/schedules/${extension}`, { method: "PUT", json });
    ok(`schedule set for ${extension}: ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} UTC${opts.day !== undefined ? ` on day ${opts.day}` : ""}`);
  });

schedules
  .command("remove <extension>")
  .description("drop the override and fall back to the manifest default")
  .action(async (extension: string) => {
    const res = await api<{ removed: boolean }>(`/api/v1/admin/schedules/${extension}`, {
      method: "DELETE",
    });
    ok(res.removed ? `override removed for ${extension}` : `no override existed for ${extension}`);
  });

// ---- removal mode ----
const removalMode = program
  .command("removal-mode")
  .description("what happens when a publisher drops a chapter");

removalMode
  .command("get")
  .description("show the current mode")
  .action(async () => {
    const res = await api<{ mode: string; validModes: string[] }>(
      "/api/v1/admin/removal-mode",
    );
    kv({ mode: res.mode, validModes: res.validModes.join(", ") });
  });

removalMode
  .command("set <mode>")
  .description("set the mode (unavailable | delete)")
  .action(async (mode: string) => {
    const res = await api<{ mode: string }>("/api/v1/admin/removal-mode", {
      method: "POST",
      json: { mode: mode.toLowerCase() },
    });
    ok(`removal mode is now ${res.mode}`);
  });

// ---- bundles ----
const bundle = program.command("bundle").description("extension bundle publishing");

/** Never shipped in a bundle: build inputs and caches, not the program. */
const ZIP_EXCLUDED = new Set(["__pycache__", ".git", "node_modules", "dist", ".turbo"]);

/** Zip every file under `dir` with paths relative to it, so manifest.json is at the root. */
function zipDirectory(dir: string): Buffer {
  const zip = new AdmZip();
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (ZIP_EXCLUDED.has(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`);
      else if (entry.isFile()) zip.addFile(`${prefix}${entry.name}`, readFileSync(full));
    }
  };
  walk(dir, "");
  return zip.toBuffer();
}

/** What esbuild's `build` looks like to us. See buildEntrypoint for why it is typed here. */
interface EsbuildModule {
  build(options: Record<string, unknown>): Promise<{ errors: { text: string }[] }>;
}

/**
 * A bundle ships ONE self-contained ESM file. When the extension directory has
 * TypeScript sources (or a package.json build script implying a toolchain),
 * esbuild produces that file here, at publish time, on the operator's machine
 * — never on a worker. Workers receive pre-built, content-addressed code and
 * have no compiler, no package manager, and no reason to acquire either.
 *
 * `external: []` means dependencies are inlined: what the sha256 pins is the
 * complete program, so a worker's execution cannot be changed by anything
 * resolving differently later.
 */
async function buildEntrypoint(root: string, source: string, outFile: string): Promise<void> {
  let esbuild: EsbuildModule;
  try {
    // Resolved at run time so the CLI still works for plain-.mjs extensions on
    // an install without esbuild (it is a devDependency, not a runtime one).
    const specifier = "esbuild";
    esbuild = (await import(specifier)) as EsbuildModule;
  } catch {
    return fail(
      `${source} needs a build step but esbuild is not installed. ` +
        "Run `pnpm install` in platform/, or ship a prebuilt index.mjs instead.",
    );
  }
  console.log(`building ${source} -> index.mjs (esbuild)`);
  const result = await esbuild.build({
    entryPoints: [join(root, source)],
    outfile: outFile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    external: [],
    sourcemap: false,
    logLevel: "silent",
  });
  if (result.errors.length > 0) {
    fail(`esbuild failed:\n${result.errors.map((e) => `  ${e.text}`).join("\n")}`);
  }
}

/** The TS entrypoint to build, or null when the directory is already plain ESM. */
function detectSourceEntrypoint(root: string): string | null {
  for (const candidate of ["index.ts", join("src", "index.ts")]) {
    if (existsSync(join(root, candidate))) return candidate;
  }
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        scripts?: Record<string, string>;
        main?: string;
      };
      if (pkg.scripts?.["build"]) {
        const main = pkg.main ?? "index.ts";
        if (existsSync(join(root, main))) return main;
        fail(`package.json declares a build script but ${main} does not exist`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("build script")) throw err;
      // An unparseable package.json is not our problem unless it claimed a build.
    }
  }
  return null;
}

/**
 * Stage what actually gets zipped: the built index.mjs, a manifest whose
 * entrypoint points at it, and the declared data files. Source, tests,
 * node_modules and lockfiles are deliberately left behind — a bundle is the
 * program, not the project.
 */
function stageBuiltBundle(
  root: string,
  manifest: Record<string, unknown>,
  builtFile: string,
): string {
  const staging = mkdtempSync(join(tmpdir(), "publoader-bundle-"));
  copyFileSync(builtFile, join(staging, "index.mjs"));
  writeFileSync(
    join(staging, "manifest.json"),
    JSON.stringify({ ...manifest, entrypoint: "index.mjs" }, null, 2) + "\n",
  );
  const dataFiles = (manifest["data_files"] as Record<string, string> | undefined) ?? {};
  for (const relative of Object.values(dataFiles)) {
    const from = join(root, relative);
    if (!existsSync(from)) {
      fail(`manifest data_files references ${relative}, which is not in ${root}`);
    }
    const to = join(staging, relative);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
  return staging;
}

bundle
  .command("publish <dir>")
  .description("build (if needed), zip, and publish an extension as a content-addressed bundle")
  .option("--source-commit <sha>", "record the source repo commit this was built from")
  .option(
    "--allow-legacy-runtime",
    "republish a pre-v2 python bundle (audit-logged; new extensions must use API v2)",
    false,
  )
  .action(async (dir: string, opts: { sourceCommit?: string; allowLegacyRuntime: boolean }) => {
    const root = resolve(dir);
    try {
      if (!statSync(root).isDirectory()) fail(`${root} is not a directory`);
    } catch {
      fail(`${root} does not exist`);
    }
    // Validate locally so an operator gets an immediate, obvious error rather
    // than a 422 after uploading tens of megabytes.
    let manifest: Record<string, unknown> & { name?: string; version?: string };
    try {
      manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
    } catch (err) {
      return fail(`${join(root, "manifest.json")} missing or unreadable: ${(err as Error).message}`);
    }
    if (!manifest.name || !manifest.version) {
      fail("manifest.json must declare both `name` and `version`");
    }

    const source = detectSourceEntrypoint(root);
    let zipData: Buffer;
    let staging: string | null = null;
    try {
      if (source === null) {
        // Plain ESM (or a legacy python bundle): ship the directory as-is.
        zipData = zipDirectory(root);
      } else {
        staging = mkdtempSync(join(tmpdir(), "publoader-build-"));
        const builtFile = join(staging, "index.mjs");
        await buildEntrypoint(root, source, builtFile);
        const publishDir = stageBuiltBundle(root, manifest, builtFile);
        zipData = zipDirectory(publishDir);
        rmSync(publishDir, { recursive: true, force: true });
      }
    } finally {
      if (staging) rmSync(staging, { recursive: true, force: true });
    }

    console.log(
      `publishing ${manifest.name}@${manifest.version} (${(zipData.length / 1024).toFixed(1)} KiB)`,
    );
    const headers: Record<string, string> = {};
    if (opts.sourceCommit) headers["x-source-commit"] = opts.sourceCommit;
    if (opts.allowLegacyRuntime) headers["x-allow-legacy-runtime"] = "true";
    const res = await api<{ extension: string; version: string; sha256: string; created: boolean }>(
      "/api/v1/admin/bundles",
      {
        method: "POST",
        raw: { body: zipData, contentType: "application/zip", headers },
      },
    );
    kv({
      extension: res.extension,
      version: res.version,
      sha256: res.sha256,
      status: res.created ? "published" : "already published (identical content)",
    });
  });

// ---- client tokens ----
const tokens = program
  .command("tokens")
  .description("scoped per-client API credentials (pa_…)");

tokens
  .command("scopes")
  .description("the scope taxonomy and the recommended set per client")
  .action(async () => {
    const res = await api<{ scopes: string[]; presets: Record<string, string[]> }>(
      "/api/v1/admin/tokens/scopes",
    );
    console.log("scopes:");
    for (const scope of res.scopes) console.log(`  ${scope}`);
    console.log("");
    console.log("presets:");
    kv(Object.fromEntries(Object.entries(res.presets).map(([k, v]) => [k, v.join(",")])));
  });

tokens
  .command("list")
  .description("issued tokens (metadata only — secrets are unrecoverable)")
  .action(async () => {
    const res = await api<{ tokens: Record<string, unknown>[] }>("/api/v1/admin/tokens");
    table(res.tokens, [
      { header: "ID", get: (t) => t["id"] },
      { header: "NAME", get: (t) => t["name"] },
      { header: "SCOPES", get: (t) => (t["scopes"] as string[]).join(",") },
      { header: "CREATED BY", get: (t) => t["createdBy"] },
      { header: "LAST USED", get: (t) => (t["lastUsedAt"] ? ago(t["lastUsedAt"]) : "never") },
      { header: "EXPIRES", get: (t) => t["expiresAt"] ?? "never" },
      { header: "REVOKED", get: (t) => (t["revoked"] ? "yes" : "no") },
    ], "no client tokens issued");
  });

tokens
  .command("create")
  .description("mint a client token with exactly the scopes it needs")
  .requiredOption("--name <name>", "which client this is for, e.g. discord-bot")
  .requiredOption("--scopes <list>", "comma-separated scopes, or a preset name from `tokens scopes`")
  .option("--ttl-days <n>", "expire after N days (omit for no expiry)")
  .action(async (opts: { name: string; scopes: string; ttlDays?: string }) => {
    const scopes = opts.scopes
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (scopes.length === 0) fail("--scopes must list at least one scope");
    const json: Record<string, unknown> = { name: opts.name, scopes };
    if (opts.ttlDays !== undefined) {
      const days = Number(opts.ttlDays);
      if (!Number.isInteger(days) || days < 1 || days > 3650) {
        fail("--ttl-days must be an integer between 1 and 3650");
      }
      json["ttlDays"] = days;
    }
    const res = await api<{ id: string; name: string; scopes: string[]; expiresAt: string | null; token: string }>(
      "/api/v1/admin/tokens",
      { method: "POST", json },
    );
    kv({
      id: res.id,
      name: res.name,
      scopes: res.scopes.join(","),
      expiresAt: res.expiresAt ?? "never",
      token: res.token,
    });
    console.log("");
    console.log("This token is shown once and cannot be recovered. To rotate: create the");
    console.log("replacement, update the client, then `tokens revoke` the old id.");
  });

tokens
  .command("revoke <id>")
  .description("invalidate a client token immediately")
  .action(async (id: string) => {
    await api(`/api/v1/admin/tokens/${id}/revoke`, { method: "POST" });
    ok(`token ${id} revoked`);
  });

// ---- upload-task queues ----
const queues = program
  .command("queues")
  .description("MangaDex upload task queues");

queues
  .command("list")
  .description("queued upload tasks and the depth summary")
  .option("--kind <kind>", "UPLOAD | EDIT | DELETE | UNAVAILABLE")
  .option("--state <state>", "PENDING | LEASED | DONE | FAILED | DEAD_LETTER")
  .option("--limit <n>", "how many rows", "100")
  .action(async (opts: { kind?: string; state?: string; limit: string }) => {
    const kind = opts.kind?.toUpperCase();
    const taskState = opts.state?.toUpperCase();
    const kinds = ["UPLOAD", "EDIT", "DELETE", "UNAVAILABLE"];
    const states = ["PENDING", "LEASED", "DONE", "FAILED", "DEAD_LETTER"];
    if (kind && !kinds.includes(kind)) fail(`--kind must be one of ${kinds.join(", ")}`);
    if (taskState && !states.includes(taskState)) fail(`--state must be one of ${states.join(", ")}`);
    const res = await api<{
      tasks: Record<string, unknown>[];
      counts: { kind: string; state: string; count: number }[];
    }>("/api/v1/admin/upload-tasks", { query: { kind, state: taskState, limit: opts.limit } });

    console.log("depth by kind and state:");
    table(res.counts, [
      { header: "KIND", get: (c) => c.kind },
      { header: "STATE", get: (c) => c.state },
      { header: "COUNT", get: (c) => c.count },
    ], "no upload tasks have ever been queued");
    console.log("");
    table(res.tasks, [
      { header: "ID", get: (t) => t["id"] },
      { header: "KIND", get: (t) => t["kind"] },
      { header: "STATE", get: (t) => t["state"] },
      { header: "DEDUPE KEY", get: (t) => t["dedupeKey"] },
      { header: "ATTEMPTS", get: (t) => `${t["attempt"]}/${t["maxAttempts"]}` },
      { header: "NOT BEFORE", get: (t) => t["notBefore"] },
      { header: "ERROR", get: (t) => String(t["lastError"] ?? "").slice(0, 60) || "-" },
    ], "no upload tasks match that filter");
  });

queues
  .command("retry <id>")
  .description("requeue a failed or dead-lettered upload task with a fresh attempt budget")
  .action(async (id: string) => {
    await api(`/api/v1/admin/upload-tasks/${id}/retry`, { method: "POST" });
    ok(`upload task ${id} requeued`);
  });

queues
  .command("cancel <id>")
  .description("drop an upload task without sending it to MangaDex")
  .action(async (id: string) => {
    await api(`/api/v1/admin/upload-tasks/${id}/cancel`, { method: "POST" });
    ok(`upload task ${id} cancelled`);
  });

queues
  .command("requeue-stale")
  .description("reclaim upload tasks whose lease expired (crashed uploader)")
  .action(async () => {
    const res = await api<{ requeued: number }>("/api/v1/admin/upload-tasks/requeue-stale", {
      method: "POST",
    });
    ok(`${res.requeued} stale lease(s) requeued`);
  });

// ---- merged error feed ----
program
  .command("errors")
  .description("dead-lettered jobs, failed upload tasks, and quarantined submissions, newest first")
  .option("--limit <n>", "how many rows", "50")
  .action(async (opts: { limit: string }) => {
    const res = await api<{
      errors: { at: string; kind: string; subject: string; message: string; id: string }[];
    }>("/api/v1/admin/errors", { query: { limit: opts.limit } });
    table(res.errors, [
      { header: "WHEN", get: (e) => e.at },
      { header: "KIND", get: (e) => e.kind },
      { header: "ID", get: (e) => e.id },
      { header: "SUBJECT", get: (e) => e.subject.slice(0, 50) },
      { header: "MESSAGE", get: (e) => e.message.slice(0, 80) || "-" },
    ], "nothing has failed");
    console.log("");
    console.log("Container logs are not aggregated here — use `docker compose logs` on the host.");
  });

// ---- MangaDex session ----
const mangadex = program
  .command("mangadex")
  .description("the platform's saved MangaDex session");

mangadex
  .command("auth")
  .description("whether the saved session is still usable (never prints tokens)")
  .action(async () => {
    const res = await api<{
      hasAccess: boolean;
      hasRefresh: boolean;
      expiresAt: string | null;
      expired: boolean;
      expiresInSeconds: number | null;
    }>("/api/v1/admin/mangadex/auth");
    kv({
      accessToken: res.hasAccess ? "saved" : "absent",
      refreshToken: res.hasRefresh ? "saved" : "absent",
      expiresAt: res.expiresAt ?? "unknown",
      expired: res.expired,
      expiresIn:
        res.expiresInSeconds === null ? "unknown" : `${Math.round(res.expiresInSeconds / 60)}m`,
    });
  });

mangadex
  .command("clear-auth")
  .description("forget the saved session so the next upload re-authenticates")
  .action(async () => {
    await api("/api/v1/admin/mangadex/auth/clear", { method: "POST" });
    ok("saved MangaDex session cleared; the next upload authenticates from configured credentials");
  });

// ---- observability ----
program
  .command("stats")
  .description("queue depths, worker counts, pause state")
  .action(async () => {
    const res = await api<{
      jobs: Record<string, number>;
      uploadTasks: { kind: string; state: string; count: number }[];
      workers: Record<string, number>;
      quarantined: number;
      paused: boolean;
    }>("/api/v1/admin/stats");
    console.log("jobs by state:");
    kv(res.jobs);
    console.log("");
    console.log("upload tasks:");
    table(res.uploadTasks, [
      { header: "KIND", get: (t) => t.kind },
      { header: "STATE", get: (t) => t.state },
      { header: "COUNT", get: (t) => t.count },
    ], "no upload tasks queued");
    console.log("");
    console.log("workers by status:");
    kv(res.workers);
    console.log("");
    kv({ quarantined: res.quarantined, paused: res.paused });
  });

program
  .command("audit")
  .description("recent audit trail entries")
  .option("--limit <n>", "how many events", "50")
  .action(async (opts: { limit: string }) => {
    const res = await api<{ events: Record<string, unknown>[] }>("/api/v1/admin/audit", {
      query: { limit: opts.limit },
    });
    table(res.events, [
      { header: "WHEN", get: (e) => e["createdAt"] },
      { header: "ACTOR", get: (e) => e["actor"] },
      { header: "ACTION", get: (e) => e["action"] },
      { header: "SUBJECT", get: (e) => e["subject"] },
      { header: "DETAIL", get: (e) => String(cell(e["detail"])).slice(0, 70) },
    ], "no audit events");
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  fail((err as Error).message ?? String(err));
});
