import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { Logger } from "../logging.js";
import type { Config } from "../config.js";
import type { CoreApiClient } from "./coreApi.js";

export interface WorkerCredentials {
  workerId: string;
  workerToken: string;
  /** Populated on enrollment; informational only. */
  trust?: string;
  enrolledAt?: string;
}

export function credentialsPath(statePath: string): string {
  return join(statePath, "credentials.json");
}

/**
 * On-disk worker identity. This file is the only long-lived secret a worker
 * host holds, so it is written 0600 inside a 0700 directory and replaced
 * atomically — a crash mid-rotation must never leave a truncated token.
 */
export class CredentialStore {
  private readonly path: string;

  constructor(statePath: string) {
    this.path = credentialsPath(statePath);
  }

  async load(): Promise<WorkerCredentials | null> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const parsed = JSON.parse(raw) as Partial<WorkerCredentials>;
    if (!parsed.workerId || !parsed.workerToken) return null;
    return parsed as WorkerCredentials;
  }

  async save(creds: WorkerCredentials): Promise<void> {
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
  }
}

/**
 * Resolve this worker's identity, enrolling on first boot if needed.
 *
 * Precedence: saved credentials, then an explicitly configured WORKER_TOKEN
 * (for operators who mint tokens out of band), then a one-shot ENROLL_TOKEN
 * exchange. Saved credentials win so that a stale ENROLL_TOKEN left in the
 * environment can never mint a second identity for the same host.
 */
export async function ensureCredentials(opts: {
  config: Config;
  api: CoreApiClient;
  store: CredentialStore;
  log: Logger;
  extensions?: string[];
}): Promise<WorkerCredentials> {
  const { config, api, store, log } = opts;

  const existing = await store.load();
  if (existing) {
    api.setToken(existing.workerToken);
    log.info({ workerId: existing.workerId }, "loaded saved worker credentials");
    return existing;
  }

  if (config.workerToken) {
    // No workerId is knowable without enrolling; the token alone identifies us
    // to the core, so record a placeholder and persist for restarts.
    const creds: WorkerCredentials = {
      workerId: "preprovisioned",
      workerToken: config.workerToken,
      enrolledAt: new Date().toISOString(),
    };
    api.setToken(creds.workerToken);
    await store.save(creds);
    log.info("using preprovisioned WORKER_TOKEN");
    return creds;
  }

  if (!config.enrollToken) {
    throw new Error(
      "no worker credentials: set ENROLL_TOKEN for first boot, or WORKER_TOKEN for a preprovisioned worker",
    );
  }

  const name = config.workerName ?? hostname();
  log.info({ name }, "enrolling with core");
  const result = await api.enroll({
    enrollToken: config.enrollToken,
    name,
    ...(opts.extensions ? { extensions: opts.extensions } : {}),
  });
  const creds: WorkerCredentials = {
    workerId: result.workerId,
    workerToken: result.workerToken,
    trust: result.trust,
    enrolledAt: new Date().toISOString(),
  };
  api.setToken(creds.workerToken);
  await store.save(creds);
  log.info({ workerId: creds.workerId, trust: creds.trust }, "enrolled");
  return creds;
}

/**
 * Swap this worker's credential for a fresh one. The new token is persisted
 * before it is adopted in memory, so a crash between the two leaves the file
 * authoritative and a restart picks up the token the core already honours.
 */
export async function rotateCredentials(opts: {
  api: CoreApiClient;
  store: CredentialStore;
  current: WorkerCredentials;
  log: Logger;
}): Promise<WorkerCredentials> {
  const workerToken = await opts.api.rotateToken();
  const next: WorkerCredentials = { ...opts.current, workerToken };
  await opts.store.save(next);
  opts.api.setToken(workerToken);
  opts.log.info({ workerId: next.workerId }, "rotated worker token");
  return next;
}
