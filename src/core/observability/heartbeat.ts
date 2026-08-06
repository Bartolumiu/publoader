import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The worker's liveness heartbeat file, asserted by the image's HEALTHCHECK.
 *
 * The worker has no listening socket by design, so a file's mtime is the probe.
 * The contract is deliberately narrow: the file is created at process start and
 * refreshed whenever the agent completes a piece of *work-related* traffic with
 * the core. Missing therefore means "the process never got going", and stale
 * means "the agent is running but no longer working"; the one failure mode
 * `restart: unless-stopped` cannot see.
 */

/** Write coalescing: the lease loop can touch this many times per second. */
const MIN_WRITE_INTERVAL_MS = 5_000;
let lastWriteMs = 0;

export function heartbeatPath(stateDir: string): string {
  return join(stateDir, "heartbeat");
}

/**
 * Best-effort, synchronous, never throws. A heartbeat that could reject is a
 * new way for the agent to die, and an unwritable state directory is already
 * reported by the healthcheck going stale.
 */
export function touchHeartbeat(stateDir: string, now = Date.now()): void {
  if (now - lastWriteMs < MIN_WRITE_INTERVAL_MS) return;
  lastWriteMs = now;
  try {
    writeFileSync(heartbeatPath(stateDir), `${new Date(now).toISOString()}\n`);
  } catch {
    // Intentionally silent: see above.
  }
}

/** Tests only: forget the write-coalescing window. */
export function resetHeartbeatThrottleForTests(): void {
  lastWriteMs = 0;
}
