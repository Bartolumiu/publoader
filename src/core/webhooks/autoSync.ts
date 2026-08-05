import { mkdtempSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SettingsStore } from "../store/settings.js";
import type { GithubApiConfig, GithubMetaClient } from "./repoMeta.js";
import { githubMeta } from "./repoMeta.js";
import { fetchRepoArchive, extractSubtree, type RepoArchiveFetcher } from "./repoArchive.js";
import {
  publishExtensionFromArchive,
  type PublishDeps,
  type PublishOutcome,
} from "./pushHandler.js";

/**
 * Poll the configured GitHub repositories and publish what has changed.
 *
 * The push webhook already does this, and is better when it works: it fires
 * within seconds and carries the exact commit. But it only works if GitHub can
 * reach the core, if the hook is still registered on every repo, and if no
 * delivery was dropped — none of which the platform can observe. When any of
 * them is false the failure is *silent*: extensions simply stop updating, and
 * the first symptom is a run producing stale results days later.
 *
 * So this exists as the floor, not the primary path. It answers "is what we
 * published still what the repo says?" from our side, on a timer, and needs
 * nothing inbound. Where the two overlap the work is idempotent: publishing an
 * unchanged tree returns `unchanged` because the bundle hash is identical.
 *
 * Discovery is by directory, not by what is already published, so an extension
 * ADDED to a repo is picked up. That is the difference between this and the
 * sysops sync button, which walks published bundles and therefore can only ever
 * update extensions somebody installed by hand first.
 */

/** Where the last successfully-synced commit per repo is remembered. */
const SYNCED_HEAD_PREFIX = "github_synced_head:";

/**
 * Repo-relative directory holding one directory per extension. Matches
 * `extensionRepoPath`, which the push path uses for the same layout.
 */
const EXTENSIONS_ROOT = "src";

export interface AutoSyncDeps extends PublishDeps {
  settings: SettingsStore;
  /** Injected in tests so nothing here reaches the network. */
  fetchArchive?: RepoArchiveFetcher;
  github?: GithubMetaClient;
}

export interface AutoSyncConfig extends GithubApiConfig {
  repos: readonly string[];
}

export interface RepoSyncResult {
  repo: string;
  /** Absent when the repo could not be reached. */
  commit?: string;
  status: "published" | "unchanged" | "failed";
  detail?: string;
  outcomes: PublishOutcome[];
}

/**
 * One pass over every configured repo.
 *
 * Never throws: this runs on the scheduler's tick, and a GitHub outage must not
 * take down scheduling. Every failure is reported as a result row instead.
 */
export async function autoSyncExtensions(
  deps: AutoSyncDeps,
  cfg: AutoSyncConfig,
): Promise<RepoSyncResult[]> {
  const github = deps.github ?? githubMeta;
  const fetchArchive = deps.fetchArchive ?? fetchRepoArchive;
  const results: RepoSyncResult[] = [];

  for (const repo of cfg.repos) {
    try {
      const head = await github.head(cfg, repo);
      const key = `${SYNCED_HEAD_PREFIX}${repo}`;
      const lastSynced = await deps.settings.getSetting(key);

      // The common case by far. Checked before downloading because an archive is
      // up to 32 MB and most polls find nothing new.
      if (lastSynced === head.sha) {
        results.push({ repo, commit: head.sha, status: "unchanged", outcomes: [] });
        continue;
      }

      const archive = await fetchArchive({
        owner: cfg.owner,
        repo,
        ref: head.sha,
        token: cfg.token,
        apiUrl: cfg.apiUrl,
      });

      const extensions = listExtensionDirectories(archive);
      if (extensions.length === 0) {
        // Recorded as synced regardless: a repo with no `src/<ext>/manifest.json`
        // is a repo we have nothing to do with, and re-downloading it every tick
        // to learn that again is pure waste.
        await deps.settings.setSetting(key, head.sha);
        results.push({
          repo,
          commit: head.sha,
          status: "unchanged",
          detail: `no ${EXTENSIONS_ROOT}/<extension>/manifest.json in this repository`,
          outcomes: [],
        });
        continue;
      }

      const outcomes: PublishOutcome[] = [];
      for (const extension of extensions) {
        outcomes.push(
          await publishExtensionFromArchive(
            archive,
            extension,
            head.sha,
            deps,
            {
              actor: `github-poll:${repo}@${head.sha.slice(0, 7)}`,
              via: "github-poll",
              ref: head.defaultBranch,
            },
            { requireName: true },
          ),
        );
      }

      // Only remember the commit when nothing failed. A transient build or
      // network failure must not mark this commit done — the next pass has to
      // retry it, and recording it here would skip the repo until somebody
      // pushed again, which is exactly the silent staleness this guards against.
      const failed = outcomes.filter((o) => o.status === "failed");
      if (failed.length === 0) await deps.settings.setSetting(key, head.sha);

      results.push({
        repo,
        commit: head.sha,
        status: failed.length > 0 ? "failed" : "published",
        ...(failed.length > 0
          ? { detail: `${failed.length} of ${outcomes.length} extensions failed to publish` }
          : {}),
        outcomes,
      });
    } catch (err) {
      deps.log.warn({ err, repo }, "github auto-sync could not read the repository");
      results.push({
        repo,
        status: "failed",
        detail: err instanceof Error ? err.message : "GitHub lookup failed",
        outcomes: [],
      });
    }
  }

  return results;
}

/**
 * The extension directories present in a repo archive.
 *
 * A directory counts only if it holds a `manifest.json` — repos keep `src/lib`,
 * `src/types` and similar beside the extensions, and trying to publish those
 * would produce a failure row on every pass forever.
 */
export function listExtensionDirectories(archive: Buffer): string[] {
  const workDir = mkdtempSync(join(tmpdir(), "publoader-autosync-"));
  try {
    try {
      extractSubtree(archive, EXTENSIONS_ROOT, workDir);
    } catch {
      // No `src/` at all: not an extensions repo, or laid out differently.
      return [];
    }
    return readdirSync(workDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => existsSync(join(workDir, name, "manifest.json")))
      .sort();
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
