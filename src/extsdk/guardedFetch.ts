import { withBrowserHeaders } from "./browserHeaders.js";
import { hostAllowed } from "../contracts/manifest.js";

/**
 * The guarded fetch handed to extensions as `ctx.fetch` (extension API v2).
 *
 * This is the ONLY network primitive an extension is given, and it is the point
 * where the manifest's `allowed_hosts` stops being documentation and becomes
 * enforced policy. Everything here exists because an extension is untrusted,
 * buggy, or both:
 *
 *  - the host allowlist is checked before the first packet AND again on every
 *    redirect hop, because a 302 to an unlisted host is the obvious way to turn
 *    an allowlisted request into an arbitrary one;
 *  - a per-host minimum interval keeps a scraper from hammering the publisher
 *    (the monolith relied on extensions being polite; this does not);
 *  - every request carries a wall-clock timeout, so one hung socket cannot
 *    consume the job's entire budget;
 *  - 5xx/network failures are retried a bounded number of times, and 429 is
 *    obeyed rather than retried blindly.
 *
 * NOTE: `platform/runner-node/runner.mjs` duplicates this logic inline. The
 * runner executes inside the worker sandbox and must not import from the
 * platform tree, so the two are kept behaviourally identical by hand. Any
 * change here needs the same change there.
 */

/** Rejected before connecting: the manifest does not list this host. */
export class HostNotAllowedError extends Error {
  constructor(
    readonly url: string,
    readonly host: string,
  ) {
    super(`host ${host} is not in the extension's allowed_hosts (${url})`);
    this.name = "HostNotAllowedError";
  }
}

export interface GuardedFetchOptions {
  /** The manifest's allowed_hosts. An empty list blocks everything. */
  allowedHosts: readonly string[];
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Minimum gap between two requests to the same host. */
  minIntervalMs?: number;
  /**
   * Extra random delay, as a fraction of `minIntervalMs`, added to every gap.
   *
   * A fixed interval is a fingerprint. Requests landing exactly 500ms apart for
   * an hour look like nothing else, whatever the volume, and several workers
   * starting one run together march in step from the first request.
   *
   * Only ever ADDS: the floor stays `minIntervalMs`, so the politeness this
   * throttle exists to guarantee is unchanged. 0 restores the metronome.
   */
  jitterRatio?: number;
  /** Per-attempt wall-clock timeout. */
  timeoutMs?: number;
  /** Retries AFTER the first attempt, for 5xx and transport errors. */
  maxRetries?: number;
  /** Redirect hops followed before giving up. */
  maxRedirects?: number;
  /** Ceiling applied to a server-supplied Retry-After. */
  maxRetryAfterMs?: number;
  /** Injected for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests; defaults to Math.random. */
  random?: () => number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface GuardedFetch {
  (input: string | URL, init?: RequestInit): Promise<Response>;
  /** Requests actually issued, redirect hops and retries included. */
  readonly requestCount: number;
}

const DEFAULTS = {
  minIntervalMs: 500,
  /** 500ms becomes 500-750ms, and a run's first request lands somewhere inside that. */
  jitterRatio: 0.5,
  timeoutMs: 30_000,
  maxRetries: 3,
  maxRedirects: 5,
  maxRetryAfterMs: 120_000,
} as const;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Parse Retry-After, which is either delta-seconds or an HTTP date. Returns
 * null when absent or unparseable so the caller falls back to its own backoff.
 */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

/** A body we can safely send again on a retry. Streams are one-shot. */
function isReplayableBody(body: RequestInit["body"]): boolean {
  if (body === null || body === undefined) return true;
  return (
    typeof body === "string" ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof URLSearchParams
  );
}

/** Discard a response we are about to throw away, so the socket is released. */
async function drain(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Already closed or errored; nothing to release.
  }
}

/**
 * Is this URL an API call rather than a page a browser would navigate to?
 *
 * Only decides which `Accept` and `Sec-Fetch-*` set to send. Getting it wrong is
 * cosmetic, but asking for HTML on a JSON endpoint is the kind of mismatch a
 * fingerprinter notices, so it is worth a cheap guess.
 */
function isApiLike(url: URL): boolean {
  const path = url.pathname.toLowerCase();
  if (/\.(json|xml|proto|pb)$/.test(path)) return true;
  return /(^|\/)(api|v\d+|graphql|rpc)(\/|$)/.test(path);
}

export function createGuardedFetch(opts: GuardedFetchOptions): GuardedFetch {
  const allowedHosts = [...opts.allowedHosts];
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const minIntervalMs = opts.minIntervalMs ?? DEFAULTS.minIntervalMs;
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxRetries = opts.maxRetries ?? DEFAULTS.maxRetries;
  const maxRedirects = opts.maxRedirects ?? DEFAULTS.maxRedirects;
  const maxRetryAfterMs = opts.maxRetryAfterMs ?? DEFAULTS.maxRetryAfterMs;
  const jitterRatio = opts.jitterRatio ?? DEFAULTS.jitterRatio;
  const random = opts.random ?? Math.random;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? (() => {});

  /** host -> earliest timestamp at which the next request may leave. */
  const nextAllowedAt = new Map<string, number>();
  let requestCount = 0;

  /**
   * Claim this host's next politeness slot and wait for it. The slot is
   * reserved before awaiting so concurrent callers queue behind each other
   * instead of all reading the same stale timestamp.
   */
  /**
   * `minIntervalMs` plus a random fraction of it. Never less, so the politeness
   * floor is untouched; the point is only that the gaps stop being identical.
   */
  function spacing(): number {
    if (jitterRatio <= 0) return minIntervalMs;
    return minIntervalMs + Math.floor(random() * minIntervalMs * jitterRatio);
  }

  async function awaitTurn(host: string): Promise<void> {
    const at = now();
    // First request to this host starts somewhere inside one interval rather
    // than immediately. Several workers handed segments of the same run begin
    // within milliseconds of each other, and without this they stay in step
    // for the whole run -- a synchronised pattern across addresses, which is
    // exactly what looks coordinated from the far end.
    if (!nextAllowedAt.has(host)) {
      nextAllowedAt.set(host, at + Math.floor(random() * minIntervalMs * jitterRatio));
    }
    const readyAt = Math.max(at, nextAllowedAt.get(host) ?? 0);
    nextAllowedAt.set(host, readyAt + spacing());
    const wait = readyAt - at;
    if (wait > 0) await sleep(wait);
  }

  function requireAllowed(url: URL): void {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new HostNotAllowedError(url.toString(), url.protocol);
    }
    if (!hostAllowed(url.toString(), allowedHosts)) {
      throw new HostNotAllowedError(url.toString(), url.hostname);
    }
  }

  const guarded = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    let url: URL;
    try {
      url = input instanceof URL ? new URL(input.toString()) : new URL(input);
    } catch {
      throw new HostNotAllowedError(String(input), "<unparseable>");
    }
    requireAllowed(url);

    let method = (init.method ?? "GET").toUpperCase();
    let body = init.body ?? null;
    const replayable = isReplayableBody(body);
    let redirects = 0;

    // One iteration per request actually issued: a redirect hop and a retry
    // both come back here, which is what keeps the allowlist and the
    // politeness delay applied uniformly to every packet that leaves.
    for (let attempt = 0; ; attempt += 1) {
      await awaitTurn(url.hostname);

      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = init.signal ? AbortSignal.any([timeout, init.signal]) : timeout;

      let res: Response;
      requestCount += 1;
      try {
        res = await fetchImpl(url, {
          ...init,
          // Fresh browser headers on EVERY request issued, which includes each
          // redirect hop and each retry; rotating only on the first attempt
          // leaves a pattern of its own. Anything the extension set still wins.
          headers: withBrowserHeaders(init.headers as never, { document: !isApiLike(url) }),
          method,
          body,
          // Redirects are followed by hand so each hop can be re-checked.
          redirect: "manual",
          signal,
        });
      } catch (err) {
        // A caller-requested abort is a decision, not a fault.
        if (init.signal?.aborted) throw err;
        if (attempt >= maxRetries || !replayable) throw err;
        const delay = backoffMs(attempt);
        log("guardedFetch: transport error, retrying", {
          url: url.toString(),
          attempt: attempt + 1,
          delayMs: delay,
          error: err instanceof Error ? err.message : String(err),
        });
        await sleep(delay);
        continue;
      }

      if (REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers.get("location");
        await drain(res);
        if (!location) return res;
        if (redirects >= maxRedirects) {
          throw new Error(`too many redirects (${maxRedirects}) starting at ${url.toString()}`);
        }
        const target = new URL(location, url);
        // The whole point of manual redirects: an allowlisted host must not be
        // able to hand the extension an off-allowlist response.
        requireAllowed(target);
        redirects += 1;
        url = target;
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
          method = "GET";
          body = null;
        }
        attempt = -1; // a hop is not a failed attempt; reset the retry budget
        continue;
      }

      if (res.status === 429 && attempt < maxRetries) {
        const advised = parseRetryAfter(res.headers.get("retry-after"), now());
        const delay = Math.min(maxRetryAfterMs, advised ?? backoffMs(attempt));
        await drain(res);
        log("guardedFetch: rate limited, backing off", {
          url: url.toString(),
          delayMs: delay,
          honoredRetryAfter: advised !== null,
        });
        await sleep(delay);
        continue;
      }

      if (res.status >= 500 && attempt < maxRetries && replayable) {
        const delay = backoffMs(attempt);
        await drain(res);
        log("guardedFetch: server error, retrying", {
          url: url.toString(),
          status: res.status,
          attempt: attempt + 1,
          delayMs: delay,
        });
        await sleep(delay);
        continue;
      }

      return res;
    }
  };

  Object.defineProperty(guarded, "requestCount", { get: () => requestCount });
  return guarded as GuardedFetch;
}

/** Exponential backoff with jitter; attempt is 0-based. */
function backoffMs(attempt: number): number {
  const base = Math.min(30_000, 1_000 * 2 ** attempt);
  return Math.round(base * (0.5 + Math.random() * 0.5));
}
