/**
 * Restarting a service without the Docker socket.
 *
 * The dashboard needs a "restart the service" button, and the obvious
 * implementation — mount /var/run/docker.sock and call the daemon — is
 * root-equivalent access to the host handed to an internet-facing process. It is
 * deliberately absent from every compose file and must stay that way.
 *
 * What we use instead is the container runtime's own restart policy. Every core
 * service runs `restart: unless-stopped`, so a process that exits is started
 * again by Docker with the same image, the same env and the same volumes. A
 * "restart" is therefore just a graceful self-exit, and the API already has the
 * shutdown path for it (SIGTERM: close the server, disconnect prisma, exit 0).
 *
 * That covers the API, which can exit itself. The scheduler, processor and
 * uploader are separate processes with no listening socket, so they cannot be
 * asked directly — they poll for the request in this module's `Setting` row and
 * exit their own loop when they see one. Two properties make that safe:
 *
 *  - it is TIME-BOUNDED. A request older than RESTART_REQUEST_TTL_MS is ignored,
 *    so a row left behind by a crash cannot restart a service days later;
 *  - it is ACKNOWLEDGED per service. Without that, a service which restarts in
 *    five seconds would come back, still see a fresh request, and exit again —
 *    a crash loop lasting as long as the TTL. The ack row records which request
 *    each service has already honoured.
 *
 * Nothing here is a schema change: `Setting` is an existing key/value table.
 */

/** The single row holding the pending request. */
export const RESTART_REQUEST_KEY = "restart_request";

/**
 * How long a request stays actionable. Long enough for a 30s scheduler tick to
 * come around and notice, short enough that a stale row is never obeyed. A
 * service that was down for longer restarts when it boots anyway, which is the
 * outcome the operator wanted.
 */
export const RESTART_REQUEST_TTL_MS = 120_000;

export const RESTART_TARGETS = ["api", "scheduler", "processor", "uploader", "all"] as const;
export type RestartTarget = (typeof RESTART_TARGETS)[number];

/** A single process that can honour a request. "all" is a fan-out, not a service. */
export type RestartService = Exclude<RestartTarget, "all">;

export function isRestartTarget(value: unknown): value is RestartTarget {
  return typeof value === "string" && (RESTART_TARGETS as readonly string[]).includes(value);
}

export interface RestartRequest {
  target: RestartTarget;
  /** ISO-8601. Stored as a string so the row stays readable in psql. */
  requestedAt: string;
  /** Audit actor that asked, e.g. `user:iam@ardax.dev`. */
  requestedBy: string;
}

/**
 * Just the two methods this module needs from SettingsStore. Structural on
 * purpose: the store is owned elsewhere, and a narrow interface means the
 * services can pass their existing instance and tests can pass a Map.
 */
export interface RestartSettingsStore {
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
}

/** Which request a given service has already acted on. */
export function restartAckKey(service: RestartService): string {
  return `restart_ack_${service}`;
}

export function parseRestartRequest(raw: string | null): RestartRequest | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { target, requestedAt, requestedBy } = parsed as Record<string, unknown>;
  if (!isRestartTarget(target)) return null;
  if (typeof requestedAt !== "string" || Number.isNaN(Date.parse(requestedAt))) return null;
  return {
    target,
    requestedAt,
    requestedBy: typeof requestedBy === "string" ? requestedBy : "unknown",
  };
}

/** Does `request` ask `service` to exit right now? */
export function restartApplies(
  request: RestartRequest,
  service: RestartService,
  now = Date.now(),
): boolean {
  if (request.target !== service && request.target !== "all") return false;
  const age = now - Date.parse(request.requestedAt);
  // A negative age means the row was written by a clock ahead of ours. Honour
  // it: rejecting a request because of skew would look like the button silently
  // doing nothing, and the TTL still bounds it in the other direction.
  return age <= RESTART_REQUEST_TTL_MS;
}

/**
 * Record a restart request for the services that cannot be signalled directly.
 * The API does not need this for itself — it exits in-process — but a request
 * for `all` writes the row so the other three follow.
 */
export async function writeRestartRequest(
  settings: RestartSettingsStore,
  request: RestartRequest,
): Promise<void> {
  await settings.setSetting(RESTART_REQUEST_KEY, JSON.stringify(request));
}

/**
 * The poll a service loop runs: returns the request it should exit for, or null.
 *
 * Calling this marks the request as honoured by `service` BEFORE the caller
 * exits, which is what makes it idempotent — the same request is never obeyed
 * twice by the same service, however fast it comes back. The window between the
 * ack and the exit is not a problem: an ack for a restart that then failed to
 * happen leaves the service running, which is the state the operator can see
 * and retry, whereas the opposite order risks a loop.
 */
export async function honourRestartRequest(
  settings: RestartSettingsStore,
  service: RestartService,
  now = Date.now(),
): Promise<RestartRequest | null> {
  const request = parseRestartRequest(await settings.getSetting(RESTART_REQUEST_KEY));
  if (!request || !restartApplies(request, service, now)) return null;
  const acked = await settings.getSetting(restartAckKey(service));
  if (acked === request.requestedAt) return null;
  await settings.setSetting(restartAckKey(service), request.requestedAt);
  return request;
}
