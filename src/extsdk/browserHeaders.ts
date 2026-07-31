/**
 * Realistic browser headers, applied to every request an extension makes.
 *
 * This used to live inside individual extensions — alpha_manga and viz each
 * carried their own copy — which meant every new extension either reimplemented
 * it or went out with a bare `undici` fingerprint. Publishers block on exactly
 * that, so the default belongs in the platform: an extension gets plausible
 * headers without asking, and anything it sets explicitly still wins.
 *
 * A profile is chosen **per request**, not per process. A worker that pins one
 * User-Agent for its whole lifetime is as fingerprintable as one that sends
 * none, just more slowly — and the header set has to stay internally consistent
 * (the `Sec-CH-UA` client hints must agree with the `User-Agent`), which is why
 * these are whole profiles rather than a UA string picked from a list.
 */

/** One coherent browser identity. Client hints must match the User-Agent. */
export type BrowserProfile = Readonly<Record<string, string>>;

export const BROWSER_PROFILES: readonly BrowserProfile[] = [
  {
    // Chrome on Windows
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Sec-CH-UA": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"Windows"',
  },
  {
    // Chrome on macOS
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Sec-CH-UA": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"macOS"',
  },
  {
    // Firefox on Windows — no Sec-CH-UA at all, which is itself correct:
    // Firefox does not send client hints, and sending them with a Firefox UA
    // is a contradiction a fingerprinter checks for.
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  },
  {
    // Safari on macOS — likewise no client hints.
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
      "(KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  },
  {
    // Chrome on Android
    "User-Agent":
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    "Sec-CH-UA": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "Sec-CH-UA-Mobile": "?1",
    "Sec-CH-UA-Platform": '"Android"',
  },
];

export interface BrowserHeaderOptions {
  /**
   * A document request rather than an API call. Changes `Accept` and adds the
   * navigation `Sec-Fetch-*` set — asking for HTML with an API `Accept` header
   * is a mismatch worth avoiding.
   */
  document?: boolean;
  /** Deterministic profile choice, for tests. */
  pick?: (count: number) => number;
}

/**
 * A complete, self-consistent header set for one request.
 *
 * Header names are returned in the casing a browser uses. HTTP header names are
 * case-insensitive and undici lowercases them on the wire, so this is for
 * readability in logs rather than for the server.
 */
export function browserHeaders(options: BrowserHeaderOptions = {}): Record<string, string> {
  const pick = options.pick ?? ((n: number) => Math.floor(Math.random() * n));
  const profile = BROWSER_PROFILES[pick(BROWSER_PROFILES.length)] ?? BROWSER_PROFILES[0]!;

  const headers: Record<string, string> = {
    Accept: options.document
      ? "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
      : "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    // No `br` unless the client can actually decode it. undici handles gzip and
    // deflate transparently; advertising brotli and then failing to decode is a
    // worse tell than not advertising it.
    "Accept-Encoding": "gzip, deflate",
    ...profile,
  };

  if (options.document) {
    Object.assign(headers, {
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
    });
  }

  return headers;
}

/**
 * Merge browser defaults under whatever the caller set.
 *
 * Case-insensitive on purpose: an extension that sets `user-agent` must override
 * the profile's `User-Agent` rather than sit alongside it, because two
 * User-Agent headers is a fingerprint all of its own.
 */
export type HeaderInput =
  | Record<string, string>
  | [string, string][]
  | { entries(): Iterable<[string, string]> };

export function withBrowserHeaders(
  caller: HeaderInput | undefined,
  options: BrowserHeaderOptions = {},
): Record<string, string> {
  const defaults = browserHeaders(options);
  const out: Record<string, string> = {};
  const seen = new Map<string, string>();

  const set = (name: string, value: string): void => {
    const lower = name.toLowerCase();
    const existing = seen.get(lower);
    if (existing !== undefined) delete out[existing];
    seen.set(lower, name);
    out[name] = value;
  };

  for (const [k, v] of Object.entries(defaults)) set(k, v);

  if (caller) {
    // Structural rather than `instanceof Headers`: this file has no DOM lib, and
    // undici's Headers satisfies the same shape.
    const entries: [string, string][] = Array.isArray(caller)
      ? caller
      : typeof (caller as { entries?: unknown }).entries === "function"
        ? [...(caller as { entries(): Iterable<[string, string]> }).entries()]
        : Object.entries(caller as Record<string, string>);
    for (const [k, v] of entries) set(k, String(v));
  }

  return out;
}
