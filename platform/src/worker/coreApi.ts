import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { Manifest } from "../contracts/manifest.js";
import type { ResultEnvelope } from "../contracts/envelope.js";

export const DEFAULT_CORE_URL = "https://publoader.ardax.dev";

/** A job as handed out by POST /api/v1/worker/lease. */
export interface LeasedJob {
  jobId: string;
  runId: string;
  extension: string;
  extensionVersion: string;
  bundleSha256: string;
  kind: string;
  attempt: number;
  segmentIndex: number | null;
  segmentTotal: number | null;
  segmentKey: string | null;
  segmentMangaIds: string[];
  timeoutSeconds: number;
  manifest: Manifest | null;
  postedChapterIds: string[];
}

export interface LeaseGrant {
  job: LeasedJob;
  leaseId: string;
  leaseExpiresAt: string;
  leaseTtlSeconds: number;
}

/** 204 from the lease endpoint: nothing to do, possibly because we're drained. */
export interface LeaseIdle {
  idle: true;
  drained: boolean;
}

export type LeaseOutcome = LeaseGrant | LeaseIdle;

export function isLeaseIdle(outcome: LeaseOutcome): outcome is LeaseIdle {
  return "idle" in outcome;
}

export interface EnrollResult {
  workerId: string;
  workerToken: string;
  trust: string;
}

export interface RenewResult {
  ok: boolean;
  cancelRequested: boolean;
  leaseExpiresAt: string;
}

export interface SubmitResult {
  outcome: string;
  submissionId?: string;
  reason?: string;
}

/** Any non-2xx answer from the control plane. */
export class CoreApiError extends Error {
  readonly status: number;
  readonly bodyText: string;

  constructor(status: number, bodyText: string, url: string) {
    super(`${status} from ${url}: ${bodyText.slice(0, 500)}`);
    this.name = "CoreApiError";
    this.status = status;
    this.bodyText = bodyText;
  }

  /** 429 and 5xx are worth another go; 4xx means we asked wrongly. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }

  /** Credentials rejected — the operator has to re-enroll this worker. */
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/** Transport-level failure: DNS, connection reset, timeout, TLS. Always retryable. */
export class CoreNetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CoreNetworkError";
  }
}

export class BundleIntegrityError extends Error {
  constructor(expected: string, actual: string) {
    super(`bundle sha256 mismatch: expected ${expected}, got ${actual}`);
    this.name = "BundleIntegrityError";
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof CoreNetworkError) return true;
  if (err instanceof CoreApiError) return err.retryable;
  // A corrupt bundle body is worth one more fetch — the object is immutable
  // and content-addressed, so a second read can only be right or wrong the
  // same way, and a truncated response is the common cause.
  return err instanceof BundleIntegrityError;
}

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

/**
 * Exponential backoff with jitter around a transient failure.
 *
 * Safe to wrap around EVERY worker endpoint because all of them are idempotent
 * server-side: enroll consumes a single-use token under a uniqueness guard,
 * lease is a compare-and-set claim, start/renew are lease-CAS operations,
 * artifact upload is content-addressed, and result submission is keyed by
 * `res:<jobId>:<attempt>` with a commit marker that turns replays into
 * SUPERSEDED no-ops. A retry can therefore never double-apply an effect — the
 * worst case is a wasted round trip.
 */
export async function withRetry<T>(op: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const baseMs = opts.baseMs ?? 500;
  const maxMs = opts.maxMs ?? 30_000;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === attempts) throw err;
      const backoff = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const delayMs = Math.round(backoff * (0.5 + Math.random() * 0.5));
      opts.onRetry?.(err, attempt, delayMs);
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

interface RequestInitLite {
  method: "GET" | "POST";
  body?: string | Uint8Array;
  headers?: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Enrollment is the one call made before we hold a worker token. */
  anonymous?: boolean;
}

/**
 * Typed client for the worker-audience half of the core API
 * (src/core/api/routes/worker.ts). Holds the worker's bearer token and nothing
 * else — no MangaDex, Postgres, or Discord credentials ever reach this side.
 */
export class CoreApiClient {
  private token: string | undefined;
  readonly baseUrl: string;

  constructor(opts: { baseUrl?: string; token?: string; agentVersion?: string }) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_CORE_URL).replace(/\/+$/, "");
    this.token = opts.token;
    this.agentVersion = opts.agentVersion ?? "1.0.0";
  }

  readonly agentVersion: string;

  setToken(token: string): void {
    this.token = token;
  }

  private async request(path: string, init: RequestInitLite): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { ...init.headers };
    if (!init.anonymous) {
      if (!this.token) throw new CoreApiError(401, "no worker token held", url);
      headers["authorization"] = `Bearer ${this.token}`;
    }
    const timeout = AbortSignal.timeout(init.timeoutMs);
    const signal = init.signal ? AbortSignal.any([timeout, init.signal]) : timeout;

    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method,
        headers,
        body: init.body,
        signal,
      });
    } catch (err) {
      // An externally requested abort (shutdown) is a decision, not a fault.
      if (init.signal?.aborted) throw err;
      throw new CoreNetworkError(`${init.method} ${url} failed`, { cause: err });
    }
    if (!res.ok && res.status !== 204) {
      const bodyText = await res.text().catch(() => "");
      throw new CoreApiError(res.status, bodyText, url);
    }
    return res;
  }

  private async json<T>(path: string, init: RequestInitLite): Promise<T> {
    const res = await this.request(path, init);
    return (await res.json()) as T;
  }

  /** One-shot exchange of an operator-minted enroll token for a worker credential. */
  async enroll(opts: {
    enrollToken: string;
    name: string;
    extensions?: string[];
  }): Promise<EnrollResult> {
    return withRetry(() =>
      this.json<EnrollResult>("/api/v1/worker/enroll", {
        method: "POST",
        anonymous: true,
        headers: { "content-type": "application/json" },
        timeoutMs: 20_000,
        body: JSON.stringify({
          enrollToken: opts.enrollToken,
          name: opts.name,
          capabilities: opts.extensions ? { extensions: opts.extensions } : {},
          agentVersion: this.agentVersion,
        }),
      }),
    );
  }

  async heartbeat(): Promise<{ ok: boolean; status: string }> {
    return withRetry(() =>
      this.json<{ ok: boolean; status: string }>("/api/v1/worker/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        timeoutMs: 15_000,
        body: JSON.stringify({ agentVersion: this.agentVersion }),
      }),
    );
  }

  /** Replaces this worker's own credential; the old token dies atomically. */
  async rotateToken(): Promise<string> {
    const res = await withRetry(() =>
      this.json<{ workerToken: string }>("/api/v1/worker/token/rotate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        timeoutMs: 15_000,
        body: "{}",
      }),
    );
    return res.workerToken;
  }

  /**
   * Long-poll for work. The HTTP timeout deliberately exceeds the server's
   * hold time so a held-open poll is never mistaken for a dead connection.
   */
  async lease(opts: {
    extensions?: string[];
    waitSeconds?: number;
    signal?: AbortSignal;
  }): Promise<LeaseOutcome> {
    const waitSeconds = opts.waitSeconds ?? 25;
    const body: Record<string, unknown> = { waitSeconds };
    if (opts.extensions && opts.extensions.length > 0) body["extensions"] = opts.extensions;

    const res = await this.request("/api/v1/worker/lease", {
      method: "POST",
      headers: { "content-type": "application/json" },
      timeoutMs: waitSeconds * 1000 + 20_000,
      ...(opts.signal ? { signal: opts.signal } : {}),
      body: JSON.stringify(body),
    });
    if (res.status === 204) {
      return { idle: true, drained: res.headers.get("x-publoader-drained") === "true" };
    }
    return (await res.json()) as LeaseGrant;
  }

  /** Move a leased job to RUNNING. 409 means our lease is no longer current. */
  async startJob(jobId: string, leaseId: string): Promise<void> {
    await withRetry(() =>
      this.json<{ ok: boolean }>(`/api/v1/worker/jobs/${jobId}/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        timeoutMs: 15_000,
        body: JSON.stringify({ leaseId }),
      }),
    );
  }

  async renewLease(jobId: string, leaseId: string): Promise<RenewResult> {
    return withRetry(
      () =>
        this.json<RenewResult>(`/api/v1/worker/jobs/${jobId}/renew`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          timeoutMs: 15_000,
          body: JSON.stringify({ leaseId }),
        }),
      // Renewals race the lease clock; fail fast rather than burn the TTL.
      { attempts: 3, baseMs: 400, maxMs: 3_000 },
    );
  }

  /**
   * Deliver the result envelope. Retried with the SAME idempotency key on
   * transport failure: the core's commit marker collapses duplicates into
   * SUPERSEDED, so at-least-once delivery yields exactly-once effect.
   */
  async submitResult(envelope: ResultEnvelope, opts: RetryOptions = {}): Promise<SubmitResult> {
    const payload = JSON.stringify(envelope);
    return withRetry(
      () =>
        this.json<SubmitResult>(`/api/v1/worker/jobs/${envelope.jobId}/results`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          timeoutMs: 120_000,
          body: payload,
        }),
      { attempts: 8, baseMs: 1_000, maxMs: 60_000, ...opts },
    );
  }

  /** Upload one page image. Content-addressed, so replays are free. */
  async uploadArtifact(opts: {
    data: Buffer;
    contentType: string;
    sha256: string;
    jobId: string;
  }): Promise<{ artifactId: string; sha256: string }> {
    return withRetry(() =>
      this.json<{ artifactId: string; sha256: string }>("/api/v1/worker/artifacts", {
        method: "POST",
        headers: {
          "content-type": opts.contentType,
          "x-artifact-sha256": opts.sha256,
          "x-artifact-job-id": opts.jobId,
          "content-length": String(opts.data.length),
        },
        timeoutMs: 120_000,
        body: opts.data,
      }),
    );
  }

  /** Fetch a pinned extension bundle and verify it against its content address. */
  async downloadBundle(sha256: string): Promise<Buffer> {
    return withRetry(async () => {
      const res = await this.request(`/api/v1/worker/bundles/${sha256}`, {
        method: "GET",
        timeoutMs: 180_000,
      });
      const data = Buffer.from(await res.arrayBuffer());
      const actual = createHash("sha256").update(data).digest("hex");
      if (actual !== sha256.toLowerCase()) throw new BundleIntegrityError(sha256, actual);
      return data;
    });
  }
}
