/**
 * Fetching a repository snapshot at an exact commit and extracting extension
 * directories out of it.
 *
 * The archive is a zipball rather than a tarball: node has no tar reader in its
 * standard library, and adm-zip is already a dependency used for every bundle
 * in the system. Both endpoints serve the same tree for the same sha, so this
 * is purely a "use the parser we already trust" choice.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import AdmZip from "adm-zip";

/**
 * Hard ceiling on a downloaded archive. A webhook body cannot be trusted to
 * name a small repo, so the download is aborted the moment it exceeds this
 * rather than after the fact; the process runs with a 256 MiB tmpfs and a
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
 * cross-origin) and 404 on the private repo, or; worse, on an implementation
 * that does not drop it; hand our GitHub token to a different host. Following
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
 * SUPERSEDED for publishing: every archive that becomes a bundle now goes
 * through core/sysops/bundleIntake.ts, which adds the bomb, link, file-type and
 * permission checks this function never had and counts bytes as it
 * decompresses. This remains as the plain extraction primitive (and its
 * zip-slip guard) that test/unit/webhookArchive.test.ts covers; do not reach for
 * it in a new publish path.
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

/** Drop the `owner-repo-sha/` wrapper, or null for an entry that has none. */
function stripArchiveRoot(entryName: string): string | null {
  const slash = entryName.indexOf("/");
  if (slash < 0) return null;
  return entryName.slice(slash + 1);
}

/** Where an extension lives inside either extensions repo. Always zip-style. */
export function extensionRepoPath(extension: string): string {
  return `src/${extension}`;
}
