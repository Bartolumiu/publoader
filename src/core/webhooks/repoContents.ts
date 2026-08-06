/**
 * The GitHub Contents API: read a directory listing, read one file, write one
 * file back.
 *
 * This is the only place in the platform that WRITES to GitHub. Everything else
 * here reads (archives, commit metadata), so the asymmetry is deliberate and
 * worth stating: `putFile` creates a commit on the repo's default branch, which
 * is an outward-facing side effect. It is used by the weekly series-map sync
 * (core/mapsync) and by nothing else.
 *
 * It shares repoMeta.ts's headers, body cap and error vocabulary rather than
 * growing a second one; an operator reading "GITHUB_TOKEN may lack access to
 * this repo" should get the same sentence whichever call produced it.
 */
import {
  GithubApiError,
  GITHUB_API_TIMEOUT_MS,
  describeGithubFailure,
  githubHeaders,
  readGithubJson,
  repoApiUrl,
  type GithubApiConfig,
} from "./repoMeta.js";

/**
 * The contents API embeds file bytes as base64 in the JSON response and stops
 * doing so past 1 MB, answering with an empty `content` and a download URL
 * instead. A series map that big is not something to rewrite blindly, so the
 * limit is treated as a hard refusal rather than worked around.
 */
export const MAX_CONTENTS_FILE_BYTES = 1024 * 1024;

export interface RepoFile {
  path: string;
  /** Blob sha. Required to update the file; it is GitHub's optimistic lock. */
  sha: string;
  text: string;
}

export interface PutFileRequest {
  path: string;
  text: string;
  message: string;
  /** Omit to create a new file; supply the blob sha to update an existing one. */
  sha?: string;
  /** Defaults to the repo's default branch. */
  branch?: string;
}

export interface PutFileResult {
  commit: string;
  path: string;
}

/** Injected in tests so nothing here reaches the network. */
export interface GithubContentsClient {
  /** Names of the sub-directories of `dir`. Empty for a path that is not there. */
  listDirs(cfg: GithubApiConfig, repo: string, dir: string): Promise<string[]>;
  /** Null when the file does not exist. Throws for every other failure. */
  getFile(cfg: GithubApiConfig, repo: string, path: string): Promise<RepoFile | null>;
  putFile(cfg: GithubApiConfig, repo: string, req: PutFileRequest): Promise<PutFileResult>;
}

/**
 * Percent-encode a repo-relative path for a URL without destroying its slashes.
 *
 * `encodeURIComponent` on the whole path would turn `src/viz/manga_id_map.json`
 * into one literal filename; encoding per segment keeps the hierarchy and still
 * escapes anything odd in a single name.
 */
export function encodeRepoPath(path: string): string {
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

/**
 * Reject a path that is not a plain repo-relative file path.
 *
 * The map file's location comes from the extension's own manifest
 * (`data_files.manga_id_map`), which is repo-controlled text. It is interpolated
 * into a contents-API URL and then WRITTEN to, so `../../.github/workflows/x.yml`
 * has to be impossible rather than unlikely.
 */
export function isSafeRepoPath(path: string): boolean {
  if (path.length === 0 || path.length > 512) return false;
  if (path.startsWith("/") || path.includes("\\")) return false;
  if (path.includes("//")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

const contentsUrl = (cfg: GithubApiConfig, repo: string, path: string): string =>
  repoApiUrl(cfg, repo, `/contents/${encodeRepoPath(path)}`);

export const githubContents: GithubContentsClient = {
  async listDirs(cfg, repo, dir) {
    const res = await fetch(contentsUrl(cfg, repo, dir), {
      headers: githubHeaders(cfg),
      signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
    });
    // A repo with no `src/` is a configuration mistake, not an outage: report
    // it as "no extensions here" and let the caller say so per extension.
    if (res.status === 404) return [];
    if (!res.ok) throw describeGithubFailure(res, cfg, `listing ${dir} in ${repo}`);
    const body = await readGithubJson(res);
    if (!Array.isArray(body)) {
      throw new GithubApiError(`${dir} in ${repo} is a file, not a directory`);
    }
    return body
      .filter(
        (entry): entry is { name: string; type: string } =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as { name?: unknown }).name === "string" &&
          (entry as { type?: unknown }).type === "dir",
      )
      .map((entry) => entry.name);
  },

  async getFile(cfg, repo, path) {
    const res = await fetch(contentsUrl(cfg, repo, path), {
      headers: githubHeaders(cfg),
      signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw describeGithubFailure(res, cfg, `reading ${path} in ${repo}`);
    const body = await readGithubJson(res);
    if (Array.isArray(body)) {
      throw new GithubApiError(`${path} in ${repo} is a directory, not a file`);
    }
    const file = body as { sha?: unknown; size?: unknown; content?: unknown; encoding?: unknown };
    if (typeof file.sha !== "string") {
      throw new GithubApiError(`GitHub returned no blob sha for ${path} in ${repo}`);
    }
    if (typeof file.size === "number" && file.size > MAX_CONTENTS_FILE_BYTES) {
      throw new GithubApiError(
        `${path} in ${repo} is ${file.size} bytes, over the ${MAX_CONTENTS_FILE_BYTES} byte contents-API limit`,
      );
    }
    if (file.encoding !== "base64" || typeof file.content !== "string") {
      throw new GithubApiError(`GitHub did not return readable content for ${path} in ${repo}`);
    }
    return { path, sha: file.sha, text: Buffer.from(file.content, "base64").toString("utf8") };
  },

  async putFile(cfg, repo, req) {
    const body = JSON.stringify({
      message: req.message,
      content: Buffer.from(req.text, "utf8").toString("base64"),
      ...(req.sha ? { sha: req.sha } : {}),
      ...(req.branch ? { branch: req.branch } : {}),
    });
    const res = await fetch(contentsUrl(cfg, repo, req.path), {
      method: "PUT",
      headers: { ...githubHeaders(cfg), "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
    });
    if (res.status === 409 || res.status === 422) {
      // The blob sha we read is stale: someone pushed between the read and the
      // write. Nothing is retried here; the next run reads the new file and
      // decides again, which is the whole point of making this idempotent.
      throw new GithubApiError(
        `${req.path} in ${repo} changed while it was being written (HTTP ${res.status}); it will be retried on the next sync`,
        res.status,
      );
    }
    if (!res.ok) throw describeGithubFailure(res, cfg, `writing ${req.path} in ${repo}`);
    const parsed = (await readGithubJson(res)) as { commit?: { sha?: unknown } };
    const sha = parsed.commit?.sha;
    return {
      path: req.path,
      commit: typeof sha === "string" ? sha : "",
    };
  },
};
