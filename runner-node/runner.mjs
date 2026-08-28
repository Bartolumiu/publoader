#!/usr/bin/env node
/**
 * Execute one extension job under the v2 (TypeScript/ESM) extension API and
 * print a JSON result envelope as the last line of stdout.
 *
 * This file is deliberately SELF-CONTAINED: no imports from the platform tree,
 * no third-party packages, Node built-ins only. It is copied into the worker
 * image on its own and executed with Node's permission model switched on
 * (`--permission`, scoped `--allow-fs-read`/`--allow-fs-write`, code
 * generation from strings disabled), so anything it needed from `src/` would
 * either be outside the read allowlist or drag the whole dependency tree into
 * the sandbox. The guarded-fetch implementation below is therefore a hand-kept
 * duplicate of `platform/src/extsdk/guardedFetch.ts`: the two must stay
 * behaviourally identical; change one, change the other.
 *
 * Protocol (worker agent -> runner), `--job <file>`:
 *
 *   {"jobId": str, "extension": str, "kind": "SCHEDULED"|"CLEAN"|"MANUAL"|...,
 *    "segmentMangaIds": [str], "postedChapterIds": [str], "manifest": {...},
 *    "mangaIdMap": {mdMangaId: [externalId]}, "overrideOptions": {...},
 *    "timeoutSeconds": int}
 *
 * Protocol (runner -> worker agent), last line of stdout:
 *
 *   {"runnerVersion": 2, "status": "ok"|"error",
 *    "error": {"class": "TRANSIENT"|"PERMANENT", "message": str}|null,
 *    "updatedChapters": [ChapterRecord], "allChapters": [ChapterRecord]|null,
 *    "untrackedManga": [MangaRecord], "trackedMangadexIds": [str],
 *    "mangadexGroupId": str|null, "overrideOptions": {},
 *    "extensionLanguages": [str],
 *    "images": [{"listName": ..., "chapterIndex": int, "files": [abs path]}],
 *    "stats": {"durationS": float, "httpRequests": int}}
 *
 * Page images travel as files under `--output`, not inside the JSON; the agent
 * uploads each as a checksummed artifact and fills in `imageArtifacts` before
 * submitting. Exit status is 0 whenever an envelope was printed; a failed run
 * is a result, not a crash.
 */


// --- browser headers -------------------------------------------------------
// A verbatim copy of src/extsdk/browserHeaders.ts, for the same reason the rest
// of this file duplicates guardedFetch: the runner is self-contained and imports
// nothing from dist/. The two must stay in step; browserHeaders.test.ts asserts
// the profiles here match.
const BROWSER_PROFILES = [
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
    // Firefox on Windows; no Sec-CH-UA at all, which is itself correct:
    // Firefox does not send client hints, and sending them with a Firefox UA
    // is a contradiction a fingerprinter checks for.
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  },
  {
    // Safari on macOS; likewise no client hints.
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

function browserHeaders({ document: isDoc = false, pick } = {}) {
  const choose = pick ?? ((n) => Math.floor(Math.random() * n));
  const profile = BROWSER_PROFILES[choose(BROWSER_PROFILES.length)] ?? BROWSER_PROFILES[0];
  const headers = {
    Accept: isDoc
      ? "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
      : "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate",
    ...profile,
  };
  if (isDoc) {
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

function isApiLike(url) {
  const path = url.pathname.toLowerCase();
  if (/\.(json|xml|proto|pb)$/.test(path)) return true;
  return /(^|\/)(api|v\d+|graphql|rpc)(\/|$)/.test(path);
}

function withBrowserHeaders(caller, options) {
  const out = {};
  const seen = new Map();
  const set = (name, value) => {
    const lower = name.toLowerCase();
    const existing = seen.get(lower);
    if (existing !== undefined) delete out[existing];
    seen.set(lower, name);
    out[name] = value;
  };
  for (const [k, v] of Object.entries(browserHeaders(options))) set(k, v);
  if (caller) {
    const entries = Array.isArray(caller)
      ? caller
      : typeof caller.entries === "function"
        ? [...caller.entries()]
        : Object.entries(caller);
    for (const [k, v] of entries) set(k, String(v));
  }
  return out;
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const RUNNER_VERSION = 2;

/** The bundle does not satisfy the contract. Never retryable. */
class ContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "ContractError";
  }
}

// ---------------------------------------------------------------------------
// stdout protection
// ---------------------------------------------------------------------------
// stdout is the envelope channel. Extensions log freely and libraries write to
// fd 1 without asking, so the real write is captured here, before any bundle
// code can run, and everything else is pushed to stderr.

const emitLine = process.stdout.write.bind(process.stdout);

function captureStdout() {
  process.stdout.write = (chunk, encoding, callback) =>
    process.stderr.write(chunk, encoding, callback);
  // console.log() already routes through the patched write, but a bundle that
  // captured `console` methods at import time, or replaced them, should still
  // land on stderr.
  const toStderr =
    (level) =>
    (...args) =>
      log(level, args.map(render).join(" "));
  for (const method of ["log", "info", "debug", "dir", "trace"]) {
    console[method] = toStderr("info");
  }
  console.warn = toStderr("warn");
  console.error = toStderr("error");
}

function render(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Structured logging, JSON lines on stderr; never stdout. */
function log(level, message, fields) {
  const line = {
    time: new Date().toISOString(),
    level,
    source: "runner",
    message,
    ...(fields ?? {}),
  };
  let text;
  try {
    text = JSON.stringify(line);
  } catch {
    text = JSON.stringify({ time: line.time, level, source: "runner", message: String(message) });
  }
  process.stderr.write(text + "\n");
}

// ---------------------------------------------------------------------------
// guarded fetch  (hand-kept duplicate of src/extsdk/guardedFetch.ts)
// ---------------------------------------------------------------------------

const FETCH_DEFAULTS = {
  minIntervalMs: 500,
  /**
   * Extra random delay, as a fraction of minIntervalMs, added to every gap.
   *
   * A fixed interval is a fingerprint independent of volume: requests landing
   * exactly 500ms apart for an hour look like nothing else. Worse, workers
   * handed segments of the same run start within milliseconds of each other,
   * so without this they march in step across several addresses at once.
   *
   * Only ever ADDS delay, so the politeness floor is untouched.
   */
  jitterRatio: 0.5,
  timeoutMs: 30_000,
  maxRetries: 3,
  maxRedirects: 5,
  maxRetryAfterMs: 120_000,
};
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Exact-or-subdomain membership, mirroring hostAllowed() in contracts/manifest.ts. */
function hostAllowed(url, allowedHosts) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowedHosts.some((allowed) => {
    const a = String(allowed).toLowerCase();
    return host === a || host.endsWith(`.${a}`);
  });
}

function parseRetryAfter(value, nowMs) {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

function isReplayableBody(body) {
  if (body === null || body === undefined) return true;
  return (
    typeof body === "string" ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof URLSearchParams
  );
}

function backoffMs(attempt) {
  return Math.round(Math.min(30_000, 1_000 * 2 ** attempt) * (0.5 + Math.random() * 0.5));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function drain(res) {
  try {
    await res.body?.cancel();
  } catch {
    // already closed
  }
}

function createGuardedFetch(allowedHosts, throttle = {}) {
  const nextAllowedAt = new Map();
  const state = { requestCount: 0 };
  const minIntervalMs = throttle.minIntervalMs ?? FETCH_DEFAULTS.minIntervalMs;
  const jitterRatio = throttle.jitterRatio ?? FETCH_DEFAULTS.jitterRatio;

  const requireAllowed = (url) => {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`protocol ${url.protocol} is not permitted (${url})`);
    }
    if (!hostAllowed(url.toString(), allowedHosts)) {
      throw new Error(`host ${url.hostname} is not in the extension's allowed_hosts (${url})`);
    }
  };

  /** minIntervalMs plus a random fraction of it; never less. */
  const spacing = () =>
    jitterRatio > 0
      ? minIntervalMs + Math.floor(Math.random() * minIntervalMs * jitterRatio)
      : minIntervalMs;

  const awaitTurn = async (host) => {
    const at = Date.now();
    // The first request to a host waits a random slice of one interval rather
    // than firing immediately, so workers given segments of the same run do
    // not start in lockstep and then stay that way for the whole run.
    if (!nextAllowedAt.has(host)) {
      nextAllowedAt.set(host, at + Math.floor(Math.random() * minIntervalMs * jitterRatio));
    }
    const readyAt = Math.max(at, nextAllowedAt.get(host) ?? 0);
    nextAllowedAt.set(host, readyAt + spacing());
    if (readyAt > at) await sleep(readyAt - at);
  };

  const guarded = async (input, init = {}) => {
    let url;
    try {
      url = input instanceof URL ? new URL(input.toString()) : new URL(input);
    } catch {
      throw new Error(`ctx.fetch: ${String(input)} is not a valid absolute URL`);
    }
    requireAllowed(url);

    let method = (init.method ?? "GET").toUpperCase();
    let body = init.body ?? null;
    const replayable = isReplayableBody(body);
    let redirects = 0;

    for (let attempt = 0; ; attempt += 1) {
      await awaitTurn(url.hostname);
      const timeout = AbortSignal.timeout(FETCH_DEFAULTS.timeoutMs);
      const signal = init.signal ? AbortSignal.any([timeout, init.signal]) : timeout;

      let res;
      state.requestCount += 1;
      try {
        res = await fetch(url, {
            ...init,
            // Fresh headers on every request, redirect hop and retry included.
            headers: withBrowserHeaders(init.headers, { document: !isApiLike(url) }),
            method,
            body,
            redirect: "manual",
            signal,
          });
      } catch (err) {
        if (init.signal?.aborted) throw err;
        if (attempt >= FETCH_DEFAULTS.maxRetries || !replayable) throw err;
        const delay = backoffMs(attempt);
        log("warn", "guardedFetch: transport error, retrying", {
          url: url.toString(),
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
        if (redirects >= FETCH_DEFAULTS.maxRedirects) {
          throw new Error(`too many redirects (${FETCH_DEFAULTS.maxRedirects}) from ${url}`);
        }
        const target = new URL(location, url);
        requireAllowed(target); // a 302 must not escape the allowlist
        redirects += 1;
        url = target;
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
          method = "GET";
          body = null;
        }
        attempt = -1; // a hop is not a failed attempt
        continue;
      }

      if (res.status === 429 && attempt < FETCH_DEFAULTS.maxRetries) {
        const advised = parseRetryAfter(res.headers.get("retry-after"), Date.now());
        const delay = Math.min(FETCH_DEFAULTS.maxRetryAfterMs, advised ?? backoffMs(attempt));
        await drain(res);
        log("warn", "guardedFetch: rate limited, backing off", {
          url: url.toString(),
          delayMs: delay,
          honoredRetryAfter: advised !== null,
        });
        await sleep(delay);
        continue;
      }

      if (res.status >= 500 && attempt < FETCH_DEFAULTS.maxRetries && replayable) {
        const delay = backoffMs(attempt);
        await drain(res);
        log("warn", "guardedFetch: server error, retrying", {
          url: url.toString(),
          status: res.status,
          delayMs: delay,
        });
        await sleep(delay);
        continue;
      }

      return res;
    }
  };

  return { guarded, state };
}

// ---------------------------------------------------------------------------
// context
// ---------------------------------------------------------------------------

/** `{mdMangaId: [externalId]}` -> `Map<externalId, mdMangaId>`. */
function invertMangaIdMap(idMap) {
  const inverted = new Map();
  for (const [mdMangaId, externals] of Object.entries(idMap ?? {})) {
    if (!Array.isArray(externals)) continue;
    for (const external of externals) {
      if (typeof external === "string" || typeof external === "number") {
        inverted.set(String(external), mdMangaId);
      }
    }
  }
  return inverted;
}

/** Resolve a data-file name inside the bundle, refusing to escape it. */
function resolveDataFilePath(bundleDir, dataFiles, name) {
  const relative = dataFiles[name] ?? name;
  if (typeof relative !== "string" || relative.length === 0) {
    throw new Error(`dataFile(${JSON.stringify(name)}): no such data file`);
  }
  if (isAbsolute(relative)) {
    throw new Error(`dataFile(${JSON.stringify(name)}): absolute paths are not allowed`);
  }
  const root = resolve(bundleDir);
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`dataFile(${JSON.stringify(name)}) resolves outside the bundle directory`);
  }
  return target;
}

/**
 * Throttle settings from the extension's DATABASE configuration, so pacing can
 * be changed from the dashboard without publishing a bundle.
 *
 *   fetch_jitter           false turns the randomness off entirely
 *   fetch_jitter_ratio     size of the random extra, as a fraction of the gap
 *   fetch_min_interval_ms  the gap itself
 *
 * Every value is clamped, and a nonsense one falls back to the default rather
 * than being obeyed. The floor on the interval matters most: this is the only
 * thing pacing our requests at a publisher, and a stray 0 in a config field
 * should not be able to turn it into a flood.
 */
function readThrottle(overrideOptions) {
  const options = overrideOptions && typeof overrideOptions === "object" ? overrideOptions : {};
  const num = (value, fallback, min, max) => {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  };

  const enabled = options.fetch_jitter !== false;
  return {
    minIntervalMs: num(options.fetch_min_interval_ms, FETCH_DEFAULTS.minIntervalMs, 100, 60_000),
    jitterRatio: enabled
      ? num(options.fetch_jitter_ratio, FETCH_DEFAULTS.jitterRatio, 0, 5)
      : 0,
  };
}

function buildContext(bundleDir, manifest, mangaIdMap, overrideOptions) {
  const allowedHosts = Array.isArray(manifest.allowed_hosts) ? manifest.allowed_hosts : [];
  const dataFiles =
    manifest.data_files && typeof manifest.data_files === "object" ? manifest.data_files : {};
  const { guarded, state } = createGuardedFetch(allowedHosts, readThrottle(overrideOptions));

  const ctx = {
    manifest: Object.freeze({ ...manifest }),
    mangaIdMap: invertMangaIdMap(mangaIdMap),
    fetch: (input, init) => guarded(input, init),
    dataFile: (name) => readFile(resolveDataFilePath(bundleDir, dataFiles, name), "utf8"),
    /**
     * The extension's configuration as the DATABASE holds it.
     *
     * The lease has always carried this and the context never exposed it, so an
     * extension's only source of configuration was the copy baked into its own
     * bundle — which meant changing one setting required publishing a new
     * bundle, and the operator-editable config the dashboard writes reached the
     * runner and stopped there.
     *
     * Frozen, and never merged into `dataFile` output on the extension's
     * behalf: which of the two wins is the extension's decision to state
     * explicitly, not something to have happen to it silently.
     */
    overrideOptions: Object.freeze({ ...(overrideOptions ?? {}) }),
    log: (message, fields) => log("info", String(message), { source: "extension", ...(fields ?? {}) }),
  };
  return { ctx, fetchState: state };
}

// ---------------------------------------------------------------------------
// result normalisation
// ---------------------------------------------------------------------------

const CHAPTER_STRING_FIELDS = [
  "chapterLanguage",
  "chapterNumber",
  "chapterTitle",
  "chapterVolume",
  "chapterId",
  "chapterUrl",
  "mangaId",
  "mangaName",
  "mangaUrl",
];

function asString(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return null;
}

/**
 * Datetimes on the wire are ISO-8601 with an offset. Extensions naturally
 * produce `Date`, so both that and an already-formatted string are accepted;
 * anything else becomes null rather than failing the whole run.
 */
function asIso(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === "string") {
    const at = Date.parse(value);
    return Number.isNaN(at) ? null : new Date(at).toISOString();
  }
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One ChapterInput -> the 16-field ChapterRecord wire shape (records.ts).
 * Returns null when the chapter is unusable, so the caller can drop it the way
 * v1's validate_list dropped wrong-typed elements.
 */
function chapterToRecord(input, extensionName) {
  if (!input || typeof input !== "object") return null;
  const record = {
    chapterLookup: null,
    chapterTimestamp: asIso(input.chapterTimestamp),
    chapterExpire: asIso(input.chapterExpire),
    chapterLanguage: null,
    chapterNumber: null,
    chapterTitle: null,
    chapterVolume: null,
    chapterId: null,
    chapterUrl: null,
    mdChapterId: null,
    mangaId: null,
    mdMangaId: null,
    // The core stamps the real group id during processing (processor.ts), so a
    // worker-supplied one would only be overwritten. Left null on purpose.
    mdGroupId: null,
    mangaName: null,
    mangaUrl: null,
    extensionName,
    imageArtifacts: [],
  };
  for (const field of CHAPTER_STRING_FIELDS) {
    record[field] = asString(input[field]);
  }
  if (record.chapterId === null || record.mangaId === null) return null;
  const md = asString(input.mdMangaId);
  record.mdMangaId = md !== null && UUID_RE.test(md) ? md : null;
  return record;
}

function mangaToRecord(input) {
  if (!input || typeof input !== "object") return null;
  const record = {
    mangaId: asString(input.mangaId),
    mangaName: asString(input.mangaName),
    mangaLanguage: asString(input.mangaLanguage),
    mangaUrl: asString(input.mangaUrl),
  };
  if (Object.values(record).some((v) => v === null)) return null;
  return record;
}

/**
 * Structural check of what collect() returned. zod is not available inside the
 * sandbox, so this is deliberately shallow: the shape has to be right (a
 * violation is the bundle being wrong, hence PERMANENT), while individual bad
 * elements are dropped further down rather than failing the run.
 */
function validateCollectResult(result) {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new ContractError("collect() must resolve to an object");
  }
  const { updatedChapters, allChapters, untrackedManga, failedManga } = result;
  if (updatedChapters !== undefined && !Array.isArray(updatedChapters)) {
    throw new ContractError("collect(): updatedChapters must be an array");
  }
  if (allChapters !== undefined && allChapters !== null && !Array.isArray(allChapters)) {
    throw new ContractError("collect(): allChapters must be an array or null");
  }
  if (untrackedManga !== undefined && !Array.isArray(untrackedManga)) {
    throw new ContractError("collect(): untrackedManga must be an array");
  }
  if (failedManga !== undefined && !Array.isArray(failedManga)) {
    throw new ContractError("collect(): failedManga must be an array");
  }
  const unknown = Object.keys(result).filter(
    (k) => !["updatedChapters", "allChapters", "untrackedManga", "failedManga"].includes(k),
  );
  if (unknown.length > 0) {
    log("warn", "collect() returned unknown keys; ignoring", { keys: unknown });
  }
  return {
    updatedChapters: updatedChapters ?? [],
    allChapters: allChapters ?? null,
    untrackedManga: untrackedManga ?? [],
    // Ids only, de-duplicated and stringified: an extension reporting a failure
    // is already having a bad run, so this must not itself throw on a number or
    // a repeat.
    failedManga: [
      ...new Set((failedManga ?? []).map((id) => String(id)).filter((id) => id.length > 0)),
    ],
  };
}

// ---------------------------------------------------------------------------
// images
// ---------------------------------------------------------------------------

const IMAGE_SIGNATURES = [
  [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], ".png"],
  [[0xff, 0xd8, 0xff], ".jpg"],
  [[0x47, 0x49, 0x46, 0x38, 0x37, 0x61], ".gif"],
  [[0x47, 0x49, 0x46, 0x38, 0x39, 0x61], ".gif"],
];

/**
 * Name page files by what they actually are. The agent maps the suffix to a
 * content type and the core only accepts png/jpeg/gif/webp, so a mislabelled
 * page would be rejected at upload.
 */
function imageSuffix(bytes) {
  for (const [signature, suffix] of IMAGE_SIGNATURES) {
    if (signature.every((byte, i) => bytes[i] === byte)) return suffix;
  }
  const riff = [0x52, 0x49, 0x46, 0x46];
  const webp = [0x57, 0x45, 0x42, 0x50];
  if (riff.every((b, i) => bytes[i] === b) && webp.every((b, i) => bytes[8 + i] === b)) {
    return ".webp";
  }
  return ".bin";
}

async function writeImages(outputDir, listName, index, images) {
  const target = join(outputDir, "images", listName, String(index));
  await mkdir(target, { recursive: true });
  const written = [];
  for (let page = 0; page < images.length; page += 1) {
    const data = images[page];
    if (!ArrayBuffer.isView(data) && !(data instanceof ArrayBuffer)) {
      log("warn", "page image is not binary; skipping", { listName, index, page });
      continue;
    }
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const path = join(target, `${String(page).padStart(4, "0")}${imageSuffix(bytes)}`);
    await writeFile(path, bytes);
    written.push(path);
  }
  return written;
}

/**
 * `chapters` are the extension's originals, index-aligned with the records
 * already placed in the envelope; the agent splices artifact ids back by that
 * same index, so the two lists must never be filtered apart.
 */
async function collectImages(outputDir, listName, chapters) {
  const batches = [];
  for (let index = 0; index < chapters.length; index += 1) {
    const images = chapters[index]?.images;
    if (!Array.isArray(images) || images.length === 0) continue;
    const files = await writeImages(outputDir, listName, index, images);
    if (files.length > 0) batches.push({ listName, chapterIndex: index, files });
  }
  return batches;
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--bundle" || flag === "--job" || flag === "--output") {
      args[flag.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  for (const required of ["bundle", "job", "output"]) {
    if (!args[required]) throw new ContractError(`missing required argument --${required}`);
  }
  return args;
}

async function loadFactory(bundleDir, manifest) {
  const entrypoint = typeof manifest.entrypoint === "string" ? manifest.entrypoint : "index.mjs";
  if (isAbsolute(entrypoint)) {
    throw new ContractError(`entrypoint ${entrypoint} must be relative to the bundle`);
  }
  const root = resolve(bundleDir);
  const mainfile = resolve(root, entrypoint);
  if (!mainfile.startsWith(root + sep)) {
    throw new ContractError(`entrypoint ${entrypoint} resolves outside the bundle`);
  }

  let module;
  try {
    module = await import(pathToFileURL(mainfile).href);
  } catch (err) {
    throw new ContractError(
      `could not import entrypoint ${entrypoint}: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
    );
  }
  const factory = module.default;
  if (typeof factory !== "function") {
    throw new ContractError(`${entrypoint} must default-export an ExtensionFactory function`);
  }
  return factory;
}

async function runJob(job, bundleDir, outputDir) {
  const manifest = job.manifest ?? {};
  const extensionName = String(job.extension ?? manifest.name ?? "");
  const mangaIdMap = job.mangaIdMap ?? {};
  const segmentIds = new Set((job.segmentMangaIds ?? []).map(String));
  const cleanRun = String(job.kind ?? "").toUpperCase() === "CLEAN";

  const { ctx, fetchState } = buildContext(bundleDir, manifest, mangaIdMap, job.overrideOptions);

  // Import and factory construction are properties of the bundle: retrying the
  // same pinned sha256 would fail identically, so they raise ContractError
  // (PERMANENT). Only collect() itself is treated as TRANSIENT.
  const factory = await loadFactory(bundleDir, manifest);
  let runtime;
  try {
    runtime = await factory(ctx);
  } catch (err) {
    throw new ContractError(
      `extension factory threw: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
    );
  }
  if (!runtime || typeof runtime.collect !== "function") {
    throw new ContractError("extension factory must return an object with a collect() method");
  }

  const postedChapterIds = cleanRun ? [] : (job.postedChapterIds ?? []).map(String);
  const trackedSubset = segmentIds.size > 0 ? [...segmentIds].sort() : null;
  log("info", "calling collect()", {
    cleanRun,
    postedChapterIds: postedChapterIds.length,
    trackedSubset: trackedSubset?.length ?? null,
  });

  // Marked so the caller can class a throw from here as TRANSIENT.
  let raw;
  try {
    raw = await runtime.collect({ postedChapterIds, cleanRun, trackedSubset });
  } catch (err) {
    const wrapped = err instanceof Error ? err : new Error(String(err));
    wrapped.publoaderPhase = "run";
    throw wrapped;
  }

  const result = validateCollectResult(raw);

  const externalToMd = ctx.mangaIdMap;
  const resolveChapters = (chapters, listName) => {
    const kept = [];
    let dropped = 0;
    for (const chapter of chapters) {
      const record = chapterToRecord(chapter, extensionName);
      if (record === null) {
        dropped += 1;
        continue;
      }
      // v1 parity: a chapter whose series has no MangaDex mapping cannot be
      // uploaded, so it is dropped here rather than travelling as a null.
      if (record.mdMangaId === null) {
        const mapped = externalToMd.get(record.mangaId);
        if (mapped === undefined) {
          dropped += 1;
          continue;
        }
        record.mdMangaId = mapped;
      }
      kept.push({ record, source: chapter });
    }
    if (dropped > 0) {
      log("info", "dropped chapters with no usable mapping", { listName, dropped });
    }
    return kept;
  };

  let updated = resolveChapters(result.updatedChapters, "updatedChapters");
  let all = result.allChapters === null ? null : resolveChapters(result.allChapters, "allChapters");

  // Filter to the segment unconditionally, whether or not the extension
  // honoured trackedSubset. Non-overlapping segment output is then a property
  // of the runner, not of extension cooperation.
  if (segmentIds.size > 0) {
    const before = updated.length;
    updated = updated.filter((c) => segmentIds.has(c.record.mangaId));
    log("info", "segment filter applied", { kept: updated.length, before });
    if (all !== null) all = all.filter((c) => segmentIds.has(c.record.mangaId));
  }

  const updatedRecords = updated.map((c) => c.record);
  const allRecords = all === null ? null : all.map((c) => c.record);

  await mkdir(outputDir, { recursive: true });
  const images = [
    ...(await collectImages(outputDir, "updatedChapters", updated.map((c) => c.source))),
    ...(all === null
      ? []
      : await collectImages(outputDir, "allChapters", all.map((c) => c.source))),
  ];

  const untrackedManga = [];
  for (const manga of result.untrackedManga) {
    const record = mangaToRecord(manga);
    if (record === null) {
      log("warn", "dropped an untracked manga with missing fields");
      continue;
    }
    untrackedManga.push(record);
  }

  const mangadexGroupId =
    typeof manifest.mangadex_group_id === "string" ? manifest.mangadex_group_id : null;

  return {
    updatedChapters: updatedRecords,
    // Untracked manga are deliberately NOT segment-filtered: they have no
    // mapping yet, so they belong to no segment, and dropping them would hide
    // new titles from the operator. The core dedupes across a run's segments.
    allChapters: allRecords,
    untrackedManga,
    // Segment-filtered like the chapter lists: on a partitioned run a segment
    // may only speak for the titles it owns, and a failure it reports for
    // someone else's title would suppress that title's removal pass on the
    // strength of a run that never touched it.
    failedManga:
      segmentIds.size > 0
        ? result.failedManga.filter((id) => segmentIds.has(id))
        : result.failedManga,
    trackedMangadexIds: [...new Set(Object.keys(mangaIdMap))],
    mangadexGroupId,
    // Override options are database-authoritative (§12). The worker is not a
    // trusted source of configuration, so it never vouches for any.
    overrideOptions: {},
    extensionLanguages: Array.isArray(manifest.languages) ? manifest.languages.map(String) : [],
    images,
    httpRequests: fetchState.requestCount,
  };
}

function errorEnvelope(errClass, message, startedAt) {
  return {
    runnerVersion: RUNNER_VERSION,
    status: "error",
    error: { class: errClass, message: String(message).slice(0, 10_000) },
    updatedChapters: [],
    allChapters: null,
    untrackedManga: [],
    trackedMangadexIds: [],
    mangadexGroupId: null,
    overrideOptions: {},
    extensionLanguages: [],
    images: [],
    stats: { durationS: durationS(startedAt) },
  };
}

function durationS(startedAt) {
  return Math.round(performance.now() - startedAt) / 1000;
}

/**
 * Write the envelope and WAIT for it to reach the OS.
 *
 * `process.stdout.write` to a pipe is asynchronous: past the pipe buffer
 * (~64 KiB on Linux) it queues the rest and returns false, and `process.exit()`
 * discards whatever is still queued. The agent captures stdout, so it is always
 * a pipe; and a CLEAN run returns the extension's whole catalogue, which for a
 * thousand-series extension is far over that buffer.
 *
 * The result was a runner that exited 0 having printed nothing the agent could
 * find: "runner exited 0/null without an envelope", reported as TRANSIENT and
 * retried forever, with the size of the answer deciding whether it happened.
 * Small UPDATE runs fit in the buffer and always worked, which is why this hid.
 */
function emit(payload) {
  const line = JSON.stringify(payload) + "\n";
  return new Promise((resolve) => {
    // The callback fires once the chunk is flushed, not merely accepted.
    if (!emitLine(line, () => resolve())) return;
    // Fully buffered: the callback still runs, but resolving here too keeps the
    // common small-envelope path from waiting a tick.
    resolve();
  });
}

async function main() {
  captureStdout();
  const startedAt = performance.now();

  let job;
  let result;
  try {
    const args = parseArgs(process.argv.slice(2));
    const bundleDir = resolve(args.bundle);
    const outputDir = resolve(args.output);
    job = JSON.parse(await readFile(args.job, "utf8"));

    if (!job.manifest || typeof job.manifest !== "object") {
      throw new ContractError("job.json carries no manifest");
    }
    if (!Array.isArray(job.manifest.allowed_hosts) || job.manifest.allowed_hosts.length === 0) {
      throw new ContractError("manifest declares no allowed_hosts");
    }

    // A soft deadline just inside the agent's hard kill, so a hung collect()
    // produces a diagnosable envelope instead of "exited without an envelope".
    const budgetS = Number(job.timeoutSeconds);
    if (Number.isFinite(budgetS) && budgetS > 0) {
      const timer = setTimeout(
        async () => {
          await emit(
            errorEnvelope("TRANSIENT", `collect() exceeded the ${budgetS}s job budget`, startedAt),
          );
          process.exit(0);
        },
        Math.max(1_000, budgetS * 1000 * 0.95),
      );
      timer.unref();
    }

    result = await runJob(job, bundleDir, outputDir);
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && err.stack) process.stderr.write(err.stack + "\n");
    // A bundle that will not import, a factory that will not build, a result
    // of the wrong shape: all properties of the pinned bundle, so a retry
    // cannot help. A throw from inside collect() is usually the upstream site.
    const errClass = err instanceof Error && err.publoaderPhase === "run" ? "TRANSIENT" : "PERMANENT";
    await emit(errorEnvelope(errClass, `${name}: ${message}`, startedAt));
    return 0;
  }

  const { httpRequests, ...envelopeFields } = result;
  await emit({
    runnerVersion: RUNNER_VERSION,
    status: "ok",
    error: null,
    ...envelopeFields,
    stats: { durationS: durationS(startedAt), httpRequests },
  });
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    // Should be unreachable: main() converts everything into an envelope.
    process.stderr.write(`runner: unhandled ${String(err)}\n`);
    emit(errorEnvelope("PERMANENT", `unhandled: ${String(err)}`, performance.now()));
    process.exit(0);
  },
);
