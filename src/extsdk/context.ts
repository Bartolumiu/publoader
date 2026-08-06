import { readFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type { ExtensionContext } from "../contracts/extensionApi.js";
import type { Manifest } from "../contracts/manifest.js";
import { createGuardedFetch, type GuardedFetch, type GuardedFetchOptions } from "./guardedFetch.js";

/**
 * Builds the `ExtensionContext` an extension factory is called with.
 *
 * The context is the extension's entire world: a read-only manifest, the
 * platform's tracked-manga map, its own bundled data files, a guarded fetch,
 * and a log sink. Anything an extension wants that is not on this object it
 * has to reach for through Node directly; which is what the worker's
 * permission-model flags exist to refuse.
 */

export interface ExtensionContextOptions {
  /** Validated manifest for the bundle being run. */
  manifest: Manifest | Record<string, unknown>;
  /** Extracted bundle directory; dataFile() cannot escape it. */
  bundleDir: string;
  /**
   * The lease's tracked map in its legacy `{mdMangaId: [externalIds]}` shape.
   * Inverted here; extensions want external -> MangaDex, the DB stores the
   * other direction because one title can have several external ids.
   */
  mangaIdMap?: LeaseMangaIdMap | undefined;
  /**
   * Set by the control plane when `mangaIdMap` is keyed by catalogue. Carried
   * explicitly because sniffing the shape fails silently; see
   * `UnsupportedMangaIdMapError`.
   */
  mangaIdMapNamespaced?: boolean | undefined;
  /** Overrides the manifest's allowed_hosts (tests only; normally omitted). */
  allowedHosts?: readonly string[] | undefined;
  /** Tuning/injection for the guarded fetch. */
  fetch?: Omit<GuardedFetchOptions, "allowedHosts" | "log"> | undefined;
  /** Correlation fields stamped on every log line. */
  logFields?: Record<string, unknown> | undefined;
  /** Where log lines go. stderr by design; stdout is the envelope channel. */
  logStream?: { write(chunk: string): unknown } | undefined;
}

export interface CreatedExtensionContext {
  ctx: ExtensionContext;
  /** Exposed so the runner can report httpRequests in the envelope's stats. */
  readonly fetch: GuardedFetch;
}

/**
 * `{mdMangaId: [externalId]}` -> `Map<externalId, mdMangaId>`.
 *
 * Later entries win on a duplicate external id, which can only happen if the
 * operator pointed one external series at two MangaDex titles; the map is
 * built from a unique-per-(extension, mangaId) table, so in practice it does
 * not occur.
 */
/** The lease's map: flat `{mdId: [externalIds]}`, or namespaced by catalogue. */
export type LeaseMangaIdMap =
  | Record<string, string[]>
  | Record<string, Record<string, string[]>>;

/**
 * Thrown rather than tolerated: a namespaced map inverted by flat-only code
 * produces an EMPTY lookup, and an empty lookup does not read as an error. The
 * extension would conclude that none of its series is tracked and report its
 * ENTIRE catalogue as untracked; which, with `auto_create_titles` on, is a
 * request to create a duplicate MangaDex title for every series it publishes.
 * A crashed job that retries is a far better outcome than that, so refuse.
 */
export class UnsupportedMangaIdMapError extends Error {
  constructor() {
    super(
      "the control plane sent a namespaced manga id map, which this extension " +
        "runtime cannot interpret. Upgrade the worker, or run this extension " +
        "without namespaced tracked rows.",
    );
    this.name = "UnsupportedMangaIdMapError";
  }
}

export function invertMangaIdMap(
  idMap: LeaseMangaIdMap,
  opts: { namespaced?: boolean } = {},
): Map<string, string> {
  // Trust the control plane's flag first: shape-sniffing is what makes this
  // failure silent, and the flag exists precisely so it need not be guessed.
  if (opts.namespaced) throw new UnsupportedMangaIdMapError();

  const inverted = new Map<string, string>();
  for (const [mdMangaId, externals] of Object.entries(idMap)) {
    if (Array.isArray(externals)) {
      for (const external of externals) {
        if (typeof external === "string" || typeof external === "number") {
          inverted.set(String(external), mdMangaId);
        }
      }
      continue;
    }
    // A nested value without the flag set means the two disagree. Refuse for
    // the same reason: inverting this to nothing is indistinguishable from
    // "tracked nothing".
    if (externals !== null && typeof externals === "object") {
      throw new UnsupportedMangaIdMapError();
    }
  }
  return inverted;
}

/**
 * Resolve a data-file name to a path inside the bundle.
 *
 * `name` may be a `data_files` key (the manifest indirection extensions are
 * meant to use) or a plain relative path. Either way the result has to land
 * inside the bundle directory: an extension asking for `../../etc/passwd` gets
 * an error, not a file. The worker's `--allow-fs-read` would also refuse it,
 * but a clear error beats an ERR_ACCESS_DENIED stack.
 */
export function resolveDataFilePath(
  bundleDir: string,
  dataFiles: Record<string, string>,
  name: string,
): string {
  const relative = dataFiles[name] ?? name;
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

export function createExtensionContext(opts: ExtensionContextOptions): CreatedExtensionContext {
  const manifest = opts.manifest as Record<string, unknown>;
  const dataFiles = (manifest["data_files"] as Record<string, string> | undefined) ?? {};
  const allowedHosts =
    opts.allowedHosts ?? (manifest["allowed_hosts"] as string[] | undefined) ?? [];
  const logStream = opts.logStream ?? process.stderr;
  const logFields = opts.logFields ?? {};

  const log = (message: string, fields?: Record<string, unknown>): void => {
    const line = JSON.stringify({
      time: new Date().toISOString(),
      source: "extension",
      message,
      ...logFields,
      ...(fields ?? {}),
    });
    logStream.write(line + "\n");
  };

  const guardedFetch = createGuardedFetch({
    allowedHosts,
    ...(opts.fetch ?? {}),
    log: (message, fields) => log(message, fields),
  });

  const ctx: ExtensionContext = {
    manifest: Object.freeze({ ...manifest }),
    mangaIdMap: invertMangaIdMap(opts.mangaIdMap ?? {}, {
      namespaced: opts.mangaIdMapNamespaced ?? false,
    }),
    fetch: (input, init) => guardedFetch(input, init),
    async dataFile(name: string): Promise<string> {
      return readFile(resolveDataFilePath(opts.bundleDir, dataFiles, name), "utf8");
    },
    log,
  };

  return { ctx, fetch: guardedFetch };
}
