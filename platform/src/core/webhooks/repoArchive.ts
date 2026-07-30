/**
 * Fetching a repository snapshot at an exact commit and extracting extension
 * directories out of it.
 *
 * The archive is a zipball rather than a tarball: node has no tar reader in its
 * standard library, and adm-zip is already a dependency used for every bundle
 * in the system. Both endpoints serve the same tree for the same sha, so this
 * is purely a "use the parser we already trust" choice.
 */
import { mkdirSync, readdirSync, writeFileSync, type Dirent } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import AdmZip from "adm-zip";

/**
 * Hard ceiling on a downloaded archive. A webhook body cannot be trusted to
 * name a small repo, so the download is aborted the moment it exceeds this
 * rather than after the fact — the process runs with a 256 MiB tmpfs and a
 * 768 MiB memory limit, so an unbounded read is an availability bug.
 */
export const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;

/** Wall-clock budget for the download, including following the redirect. */
export const ARCHIVE_FETCH_TIMEOUT_MS = 30_000;

export class RepoArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoArchiveError";
  }
}

export interface ArchiveRequest {
  owner: string;
  repo: string;
  /** Commit sha. Not a branch name: a webhook publishes exactly what was pushed. */
  ref: string;
  /** Required for a private repo; harmless for a public one. */
  token?: string;
  apiUrl: string;
}

/** Injected in tests so nothing here reaches the network. */
export type RepoArchiveFetcher = (req: ArchiveRequest) => Promise<Buffer>;

/**
 * Download `owner/repo` at `ref` as a zip.
 *
 * The redirect is followed by hand with `redirect: "manual"` for one specific
 * reason: GitHub answers the zipball endpoint with a 302 to codeload.github.com
 * carrying its own short-lived credential in the URL. Letting fetch follow it
 * automatically would either drop our Authorization header (per the fetch spec,
 * cross-origin) and 404 on the private repo, or — worse, on an implementation
 * that does not drop it — hand our GitHub token to a different host. Following
 * it explicitly and *without* the header is both correct and the narrower
 * disclosure.
 */
export const fetchRepoArchive: RepoArchiveFetcher = async (req) => {
  const url = `${req.apiUrl.replace(/\/+$/, "")}/repos/${encodeURIComponent(req.owner)}/${encodeURIComponent(req.repo)}/zipball/${encodeURIComponent(req.ref)}`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "publoader-core",
    "x-github-api-version": "2022-11-28",
  };
  if (req.token) headers["authorization"] = `Bearer ${req.token}`;

  const signal = AbortSignal.timeout(ARCHIVE_FETCH_TIMEOUT_MS);
  let res = await fetch(url, { headers, redirect: "manual", signal });
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    if (!location) throw new RepoArchiveError(`archive redirect ${res.status} had no location`);
    res = await fetch(location, {
      headers: { "user-agent": "publoader-core" },
      redirect: "follow",
      signal,
    });
  }
  if (!res.ok) {
    // The status is the useful part; a GitHub error body can echo request
    // details and is not worth propagating toward a response.
    throw new RepoArchiveError(`archive download failed with HTTP ${res.status}`);
  }
  return await readCapped(res, MAX_ARCHIVE_BYTES);
};

/** Buffer a response body, aborting as soon as it exceeds `limit`. */
async function readCapped(res: Response, limit: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) {
    throw new RepoArchiveError(`archive is ${declared} bytes, over the ${limit} byte cap`);
  }
  if (!res.body) throw new RepoArchiveError("archive response had no body");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > limit) {
      throw new RepoArchiveError(`archive exceeded the ${limit} byte cap mid-download`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Write the files under `subPath` out of a GitHub archive into `destDir`.
 *
 * GitHub wraps the tree in a single top-level directory named after the repo
 * and sha (`owner-repo-1a2b3c4/`), which is stripped: callers want repo-relative
 * paths. Returns the number of files written; zero means the path was not in
 * the archive.
 */
export function extractSubtree(zipData: Buffer, subPath: string, destDir: string): number {
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipData);
  } catch {
    throw new RepoArchiveError("repository archive is not a readable zip");
  }
  const prefix = subPath.replace(/\/+$/, "") + "/";
  const destRoot = resolve(destDir);
  let written = 0;

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const repoPath = stripArchiveRoot(entry.entryName);
    if (repoPath === null || !repoPath.startsWith(prefix)) continue;
    const relative = repoPath.slice(prefix.length);

    const target = safeTarget(destRoot, relative, entry.entryName);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.getData());
    written += 1;
  }
  return written;
}

/**
 * Zip-slip: an entry name is attacker-influenced data (anyone who can push to
 * the repo picks it, and for an uploaded zip the caller does), so the resolved
 * destination is checked to be inside destDir rather than trusting the name to
 * be well-formed.
 */
function safeTarget(destRoot: string, relative: string, entryName: string): string {
  const target = resolve(destRoot, relative);
  if (target !== destRoot && !target.startsWith(destRoot + sep)) {
    throw new RepoArchiveError(`archive entry escapes the extraction root: ${entryName}`);
  }
  return target;
}

/**
 * Total uncompressed size accepted from an OPERATOR-SUPPLIED zip.
 *
 * The request body is already capped, but compression ratios are not: a 200 KB
 * zip can expand to gigabytes. The core container runs with a 256 MiB tmpfs, so
 * an unbounded expansion is a denial of service against the whole control plane
 * rather than a failed upload.
 */
export const MAX_UNPACKED_BYTES = 96 * 1024 * 1024;

/** Entry-count cap for the same reason: many tiny files also fill a filesystem. */
export const MAX_UNPACKED_ENTRIES = 5_000;

/**
 * Extract every file of an uploaded zip into `destDir`, preserving its layout.
 *
 * Unlike extractSubtree this keeps whatever structure the operator zipped —
 * `manifest.json` at the root, a wrapping directory from a file manager, or a
 * whole `src/<name>/` tree — because which of those it is only becomes knowable
 * afterwards (see findManifestRoot). Returns how many files were written.
 */
export function extractUploadedTree(zipData: Buffer, destDir: string): number {
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipData);
  } catch {
    throw new RepoArchiveError("upload is not a readable zip");
  }
  const destRoot = resolve(destDir);
  let written = 0;
  let bytes = 0;

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    if (written >= MAX_UNPACKED_ENTRIES) {
      throw new RepoArchiveError(`zip has more than ${MAX_UNPACKED_ENTRIES} files`);
    }
    // The header's declared size is checked before the data is materialised, so
    // a bomb is refused rather than decompressed and then measured.
    bytes += entry.header.size;
    if (bytes > MAX_UNPACKED_BYTES) {
      throw new RepoArchiveError(
        `zip expands to more than ${MAX_UNPACKED_BYTES} bytes; publish a built bundle instead`,
      );
    }
    const target = safeTarget(destRoot, entry.entryName, entry.entryName);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.getData());
    written += 1;
  }
  return written;
}

/**
 * The shallowest directory under `root` holding a manifest.json, or null.
 *
 * "Zip the contents of the directory, not the directory itself" is a real
 * instruction the publish API gives, and it is also the mistake every operator
 * makes once. Finding the manifest instead of demanding it at the root turns
 * that mistake into a non-event. Shallowest wins so a repo-shaped zip resolves
 * to the extension rather than to a fixture inside its tests.
 */
export function findManifestRoot(root: string, maxDepth = 4): string | null {
  let frontier = [root];
  for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of frontier) {
      const entries = readdirSafe(dir);
      if (entries.some((entry) => entry.isFile() && entry.name === "manifest.json")) return dir;
      for (const entry of entries) {
        if (entry.isDirectory() && !ZIP_IGNORED_DIRS.has(entry.name)) next.push(join(dir, entry.name));
      }
    }
    frontier = next;
  }
  return null;
}

/** Never searched for a manifest: build inputs and caches, not the program. */
const ZIP_IGNORED_DIRS = new Set(["__MACOSX", "__pycache__", ".git", "node_modules", "dist"]);

/** An unreadable directory is not there as far as the search is concerned. */
function readdirSafe(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Drop the `owner-repo-sha/` wrapper, or null for an entry that has none. */
function stripArchiveRoot(entryName: string): string | null {
  const slash = entryName.indexOf("/");
  if (slash < 0) return null;
  return entryName.slice(slash + 1);
}

/**
 * Repo-relative directories in the archive that hold a manifest.json.
 *
 * The push webhook never needs this: a push payload names the directories that
 * changed. Installing an arbitrary repo does — the operator gives a repo and a
 * ref, and where the extension lives inside it is a question about the tree, not
 * about them. `src/<name>/` is listed first because that is the convention in
 * both extensions repos; a repo that IS a single extension (manifest.json at the
 * root) comes back as "".
 *
 * Ambiguity is returned, not resolved: a caller that finds several must ask
 * which one rather than picking.
 */
export function findExtensionDirs(zipData: Buffer): string[] {
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipData);
  } catch {
    throw new RepoArchiveError("repository archive is not a readable zip");
  }
  const dirs = new Set<string>();
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const repoPath = stripArchiveRoot(entry.entryName);
    if (repoPath === null) continue;
    const slash = repoPath.lastIndexOf("/");
    const file = slash < 0 ? repoPath : repoPath.slice(slash + 1);
    if (file !== "manifest.json") continue;
    dirs.add(slash < 0 ? "" : repoPath.slice(0, slash));
  }
  // Conventional locations first, then shallowest, then alphabetical: the order
  // a human would read them in, and the order a caller should offer them.
  return [...dirs].sort((a, b) => {
    const conventional = (p: string) => (/^src\/[a-z0-9_]+$/.test(p) ? 0 : 1);
    return (
      conventional(a) - conventional(b) ||
      a.split("/").length - b.split("/").length ||
      a.localeCompare(b)
    );
  });
}

/** Where an extension lives inside either extensions repo. Always zip-style. */
export function extensionRepoPath(extension: string): string {
  return `src/${extension}`;
}
