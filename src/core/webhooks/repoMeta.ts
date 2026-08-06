/**
 * The two GitHub API reads that answer "is there anything new to publish?".
 *
 * A push webhook is told what changed. An operator clicking "check GitHub" is
 * not: they have a published bundle carrying a `sourceCommit` and a repo whose
 * current HEAD is unknown, so the comparison has to be made by asking. That is
 * all this module does; resolve a repo's default-branch HEAD, and compare two
 * commits; leaving the archive download and the build to repoArchive.ts and
 * bundleBuilder.ts, which already do it for the webhook.
 *
 * Everything is bounded and every failure is a *reason*, never a silent "up to
 * date": an unreachable GitHub that reported "nothing to do" would be the worst
 * possible answer to give an operator.
 */

/** Wall-clock budget for one API call. */
export const GITHUB_API_TIMEOUT_MS = 15_000;

/**
 * Cap on a JSON response body. A compare between two distant commits carries a
 * `files` array with a patch per file; GitHub caps that at 300 entries, but the
 * patches themselves are unbounded in size.
 */
export const MAX_JSON_BYTES = 8 * 1024 * 1024;

/** GitHub's own cap on `files` in a compare response. */
export const COMPARE_FILE_LIMIT = 300;

export class GithubApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "GithubApiError";
  }
}

export interface GithubApiConfig {
  apiUrl: string;
  owner: string;
  /** Required for a private repo, and lifts the 60/hour anonymous rate limit. */
  token?: string;
}

export interface RepoHead {
  repo: string;
  defaultBranch: string;
  sha: string;
}

export interface CommitComparison {
  /** Commits on head that are not on base. 0 means head is an ancestor or equal. */
  aheadBy: number;
  /** Repo-relative paths that differ between the two commits. */
  paths: string[];
  /**
   * True when `paths` hit GitHub's 300-file cap and is therefore incomplete.
   * Callers must not conclude "nothing changed here" from a truncated list.
   */
  pathsTruncated: boolean;
}

/** Injected in tests so nothing here reaches the network. */
export interface GithubMetaClient {
  head(cfg: GithubApiConfig, repo: string): Promise<RepoHead>;
  /** Null when `base` is not an ancestor GitHub can resolve in this repo (404). */
  compare(
    cfg: GithubApiConfig,
    repo: string,
    base: string,
    head: string,
  ): Promise<CommitComparison | null>;
  /** The commit sha a branch, tag or sha names. Throws when it cannot be resolved. */
  resolveRef(cfg: GithubApiConfig, repo: string, ref: string): Promise<string>;
}

export function githubHeaders(cfg: GithubApiConfig): Record<string, string> {
  const out: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "publoader-core",
    "x-github-api-version": "2022-11-28",
  };
  if (cfg.token) out["authorization"] = `Bearer ${cfg.token}`;
  return out;
}

/**
 * Read a JSON body, aborting past MAX_JSON_BYTES.
 *
 * `res.json()` would buffer whatever GitHub sends; this process runs under a
 * 768 MiB limit, so a large compare must fail rather than be absorbed.
 */
export async function readGithubJson(res: Response): Promise<unknown> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
    throw new GithubApiError(`GitHub response is ${declared} bytes, over the cap`);
  }
  if (!res.body) throw new GithubApiError("GitHub response had no body");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > MAX_JSON_BYTES) {
      throw new GithubApiError(`GitHub response exceeded ${MAX_JSON_BYTES} bytes`);
    }
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new GithubApiError("GitHub response was not JSON");
  }
}

/**
 * Turn a non-2xx into a message an operator can act on.
 *
 * The status is the actionable part and the body is not propagated: a GitHub
 * error body echoes request details, and these messages travel to a dashboard.
 * 401/403 and 404 get their own wording because they mean different fixes -
 * "the token is wrong or unset" versus "this repo name is wrong or the token
 * cannot see it".
 */
export function describeGithubFailure(res: Response, cfg: GithubApiConfig, what: string): GithubApiError {
  const rateLimited =
    res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0";
  if (rateLimited) {
    return new GithubApiError(
      cfg.token
        ? "GitHub API rate limit reached for this token; try again later"
        : "GitHub API rate limit reached (60/hour without a token); set GITHUB_TOKEN",
      res.status,
    );
  }
  if (res.status === 401 || res.status === 403) {
    return new GithubApiError(
      cfg.token
        ? `GitHub refused ${what} (HTTP ${res.status}); GITHUB_TOKEN may lack access to this repo`
        : `GitHub refused ${what} (HTTP ${res.status}); GITHUB_TOKEN is unset and this repo is not public`,
      res.status,
    );
  }
  return new GithubApiError(`GitHub ${what} failed with HTTP ${res.status}`, res.status);
}

export const repoApiUrl = (cfg: GithubApiConfig, repo: string, rest: string): string =>
  `${cfg.apiUrl.replace(/\/+$/, "")}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(repo)}${rest}`;

/**
 * The live GitHub client. Two calls per repo at worst: one for the default
 * branch name and one for its HEAD.
 */
export const githubMeta: GithubMetaClient = {
  async head(cfg, repo) {
    const signal = AbortSignal.timeout(GITHUB_API_TIMEOUT_MS);
    const repoRes = await fetch(repoApiUrl(cfg, repo, ""), { headers: githubHeaders(cfg), signal });
    if (!repoRes.ok) throw describeGithubFailure(repoRes, cfg, `lookup of ${repo}`);
    const meta = (await readGithubJson(repoRes)) as { default_branch?: unknown };
    const defaultBranch =
      typeof meta.default_branch === "string" && meta.default_branch.length > 0
        ? meta.default_branch
        : "main";

    // The branch endpoint rather than /commits/<branch>: it names the branch it
    // resolved, so a mistaken default_branch is visible in the response instead
    // of producing a sha with no explanation attached.
    const branchRes = await fetch(
      repoApiUrl(cfg, repo, `/branches/${encodeURIComponent(defaultBranch)}`),
      { headers: githubHeaders(cfg), signal },
    );
    if (!branchRes.ok) throw describeGithubFailure(branchRes, cfg, `lookup of ${repo}@${defaultBranch}`);
    const branch = (await readGithubJson(branchRes)) as { commit?: { sha?: unknown } };
    const sha = branch.commit?.sha;
    if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
      throw new GithubApiError(`GitHub returned no usable HEAD sha for ${repo}@${defaultBranch}`);
    }
    return { repo, defaultBranch, sha };
  },

  async resolveRef(cfg, repo, ref) {
    // /commits/<ref> accepts a sha, a branch or a tag and answers with the
    // commit it resolved to. A branch name in a bundle's `sourceCommit` would
    // make "is this behind?" unanswerable later, so the resolution happens once,
    // here, at install time.
    const res = await fetch(repoApiUrl(cfg, repo, `/commits/${encodeURIComponent(ref)}`), {
      headers: githubHeaders(cfg),
      signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
    });
    if (res.status === 404) {
      throw new GithubApiError(`${repo} has no ref '${ref}'`, 404);
    }
    if (!res.ok) throw describeGithubFailure(res, cfg, `lookup of ${repo}@${ref}`);
    const body = (await readGithubJson(res)) as { sha?: unknown };
    if (typeof body.sha !== "string" || !/^[0-9a-f]{40}$/.test(body.sha)) {
      throw new GithubApiError(`GitHub returned no usable commit sha for ${repo}@${ref}`);
    }
    return body.sha;
  },

  async compare(cfg, repo, base, head) {
    const signal = AbortSignal.timeout(GITHUB_API_TIMEOUT_MS);
    const url = repoApiUrl(
      cfg,
      repo,
      `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    );
    const res = await fetch(url, { headers: githubHeaders(cfg), signal });
    // 404 is not an error here: it is how GitHub says "one of these commits is
    // not in this repo", which is exactly the question being asked when a
    // published bundle has to be matched to one of several repos.
    if (res.status === 404) return null;
    if (!res.ok) throw describeGithubFailure(res, cfg, `compare in ${repo}`);
    const body = (await readGithubJson(res)) as {
      ahead_by?: unknown;
      files?: { filename?: unknown }[];
    };
    const files = Array.isArray(body.files) ? body.files : [];
    return {
      aheadBy: typeof body.ahead_by === "number" ? body.ahead_by : 0,
      paths: files
        .map((f) => f.filename)
        .filter((name): name is string => typeof name === "string"),
      pathsTruncated: files.length >= COMPARE_FILE_LIMIT,
    };
  },
};
