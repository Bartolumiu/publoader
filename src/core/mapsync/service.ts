/**
 * The weekly write-back of the tracked series map to GitHub.
 *
 * `tracked_manga` is the authority for publisher-id → MangaDex-title-id, and it
 * moves constantly: the title pipeline auto-creates titles, operators repoint
 * and untrack series from the dashboard. The `manga_id_map.json` files in the
 * extensions repos only ever SEED that table (see
 * `BundleStore.seedConfigFromBundle`), so nothing has been putting those changes
 * back; the files in git go stale, and a contributor reading one cannot tell
 * what is actually tracked. Worse, a mapping an operator deliberately removed
 * from the database is still in the file, so the next publish re-seeds it.
 *
 * This job closes that loop once a week. Every step is designed around the fact
 * that it commits to someone's repository unattended:
 *
 *   - it never creates a file, only updates one that exists;
 *   - it never empties a file, and refuses a large shrink without `force`;
 *   - it preserves each file's existing shape and renders deterministically, so
 *     a run with nothing to say produces no commit at all;
 *   - it writes one commit per extension, marked so the push webhook does not
 *     turn our own commit into a bundle republish;
 *   - a failure is always scoped to one extension.
 */
import type { PrismaClient } from "@prisma/client";
import type { Config } from "../../config.js";
import type { Logger } from "../../logging.js";
import { Manifest } from "../../contracts/manifest.js";
import type { AuditLog, SettingsStore } from "../store/settings.js";
import type { ParsedIdMapRow } from "../store/bundles.js";
import { BundleStore } from "../store/bundles.js";
import { MAP_SYNC_COMMIT_MARKER } from "../webhooks/github.js";
import { GithubApiError, type GithubApiConfig } from "../webhooks/repoMeta.js";
import {
  githubContents,
  isSafeRepoPath,
  type GithubContentsClient,
} from "../webhooks/repoContents.js";
import { parseRepoList } from "../webhooks/repoList.js";
import {
  DEFAULT_MAP_FILENAME,
  DEFAULT_SHAPE,
  parseMapText,
  planWrite,
  renderMapFile,
  type WriteAction,
} from "./mapFile.js";

/** Timestamp of the last completed (or claimed) run, ISO-8601, in `settings`. */
export const MAP_SYNC_LAST_RUN_KEY = "map_sync_last_run";

/** Where extension directories live in both extensions repos. */
const EXTENSIONS_DIR = "src";

/**
 * Total wall clock for one run. Well under the weekly interval by three orders
 * of magnitude; the cap is not about scheduling, it is so a GitHub that has
 * started timing out cannot leave the run half-done for hours.
 */
export const MAP_SYNC_BUDGET_MS = 120_000;

export interface MapSyncOutcome {
  extension: string;
  status: WriteAction | "failed";
  repo?: string;
  path?: string;
  /** Commit sha, when one was made. */
  commit?: string;
  detail?: string;
  /** Mappings the database has that the file did not. */
  added: number;
  /** Mappings the file had that the database does not. */
  removed: number;
  /** Total mappings the database holds for this extension. */
  mappings: number;
}

export interface MapSyncReport {
  ranAt: string;
  dryRun: boolean;
  written: number;
  failed: number;
  outcomes: MapSyncOutcome[];
  /** Set when the run did nothing at all, e.g. the feature is not configured. */
  skippedReason?: string;
}

export interface MapSyncOptions {
  dryRun?: boolean;
  /** Bypass the shrink guard. Operator-only; never set by the timer. */
  force?: boolean;
  /** Limit the run to these extensions. Empty/absent means all of them. */
  extensions?: string[];
  /** Audit actor. Defaults to the scheduler's own name. */
  actor?: string;
}

export interface MapSyncDeps {
  prisma: PrismaClient;
  log: Logger;
  audit: AuditLog;
  settings: SettingsStore;
  /** Overridden in tests; the default is the real GitHub Contents API. */
  contents?: GithubContentsClient;
  now?: () => number;
}

export interface MapSyncConfig {
  enabled: boolean;
  intervalHours: number;
  owner: string;
  apiUrl: string;
  token?: string;
  repos: string[];
}

export class MapSyncService {
  private readonly contents: GithubContentsClient;
  private readonly now: () => number;
  private readonly bundles: BundleStore;

  constructor(
    private readonly cfg: MapSyncConfig,
    private readonly deps: MapSyncDeps,
  ) {
    this.contents = deps.contents ?? githubContents;
    this.now = deps.now ?? Date.now;
    this.bundles = new BundleStore(deps.prisma);
  }

  static fromConfig(config: Config, deps: MapSyncDeps): MapSyncService {
    return new MapSyncService(
      {
        enabled: config.mapSyncEnabled,
        intervalHours: config.mapSyncIntervalHours,
        owner: config.githubRepoOwner,
        apiUrl: config.githubApiUrl,
        ...(config.githubToken ? { token: config.githubToken } : {}),
        repos: parseRepoList(config.githubExtensionsRepos),
      },
      deps,
    );
  }

  /**
   * Why the job cannot run, or null when it can.
   *
   * A write needs a token: without one every PUT is a 401, so the honest answer
   * is "not configured" rather than a weekly failure report.
   */
  unavailableReason(): string | null {
    if (!this.cfg.enabled) return "MAP_SYNC_ENABLED is false";
    if (this.cfg.repos.length === 0) return "GITHUB_EXTENSIONS_REPOS is unset";
    if (!this.cfg.token) return "GITHUB_TOKEN is unset; writing to a repo needs Contents: write";
    return null;
  }

  /** When the next automatic run is due, given the recorded last run. */
  nextDueAt(lastRun: Date): Date {
    return new Date(lastRun.getTime() + this.cfg.intervalHours * 3_600_000);
  }

  /**
   * Run if a week has passed since the last run, otherwise do nothing.
   *
   * On the very first call nothing is synced: the timestamp is seeded and the
   * first automatic write happens one interval later. Deploying a release must
   * not push commits to the extensions repos within thirty seconds of starting;
 * an operator who wants it now has `publoader-admin maps sync`, which is a
   * deliberate act with a `--dry-run` in front of it.
   *
   * Claiming the slot is a compare-and-set on the stored timestamp, so two
   * core-api replicas cannot both sync: the loser sees zero rows updated and
   * returns. Claiming happens BEFORE the work, so a crash mid-run costs one
   * interval rather than looping on restart.
   */
  async runIfDue(): Promise<MapSyncReport | null> {
    const unavailable = this.unavailableReason();
    if (unavailable) return null;
    if (await this.deps.settings.isPaused()) {
      this.deps.log.debug("map sync skipped: the platform is paused");
      return null;
    }

    const now = new Date(this.now());
    const raw = await this.deps.settings.getSetting(MAP_SYNC_LAST_RUN_KEY);
    if (raw === null) {
      const armed = await this.seedFirstRun(now);
      if (armed) {
        this.deps.log.info(
          { nextSyncAt: this.nextDueAt(now).toISOString() },
          "series-map sync armed; the first automatic sync is one interval from now " +
            "(preview it with `publoader-admin maps sync --dry-run`)",
        );
      }
      return null;
    }

    const lastRun = new Date(raw);
    if (Number.isNaN(lastRun.getTime())) {
      // Unparseable timestamp: reset it rather than syncing on every tick.
      await this.deps.settings.setSetting(MAP_SYNC_LAST_RUN_KEY, now.toISOString());
      this.deps.log.warn({ value: raw }, `${MAP_SYNC_LAST_RUN_KEY} is not a timestamp; reset`);
      return null;
    }
    if (now < this.nextDueAt(lastRun)) return null;
    if (!(await this.claim(raw, now))) {
      this.deps.log.debug("another replica claimed this series-map sync");
      return null;
    }

    this.deps.log.info({ since: raw }, "series-map sync starting");
    const report = await this.sync({ actor: "scheduler" });
    this.deps.log.info(
      { written: report.written, failed: report.failed, extensions: report.outcomes.length },
      "series-map sync finished",
    );
    return report;
  }

  /**
   * Write every extension's map file. Safe to call by hand at any time; it is
   * idempotent, and a run with nothing to say makes no commits.
   */
  async sync(opts: MapSyncOptions = {}): Promise<MapSyncReport> {
    const ranAt = new Date(this.now()).toISOString();
    const dryRun = opts.dryRun === true;
    const unavailable = this.unavailableReason();
    if (unavailable && !dryRun) {
      return { ranAt, dryRun, written: 0, failed: 0, outcomes: [], skippedReason: unavailable };
    }

    const wanted = new Set((opts.extensions ?? []).filter((name) => name.length > 0));
    const byExtension = await this.trackedByExtension(wanted);
    if (byExtension.size === 0) {
      return {
        ranAt,
        dryRun,
        written: 0,
        failed: 0,
        outcomes: [],
        skippedReason:
          wanted.size > 0 ? "no tracked mappings for the named extensions" : "no tracked mappings",
      };
    }

    const paths = await this.mapFilePaths();
    const index = await this.repoIndex();
    const deadline = this.now() + MAP_SYNC_BUDGET_MS;
    const outcomes: MapSyncOutcome[] = [];

    for (const [extension, rows] of [...byExtension].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (this.now() >= deadline) {
        outcomes.push({
          extension,
          status: "skipped",
          detail: "the run reached its time budget before this extension",
          added: 0,
          removed: 0,
          mappings: rows.length,
        });
        continue;
      }
      outcomes.push(
        await this.syncOne(extension, rows, paths.get(extension) ?? DEFAULT_MAP_FILENAME, index, {
          dryRun,
          ...(opts.force === true ? { force: true } : {}),
          actor: opts.actor ?? "scheduler",
        }),
      );
    }

    // The repos that could not be listed are reported once, not once per
    // extension: "GitHub is unreachable" is one fact.
    for (const [repo, reason] of index.unreadable) {
      outcomes.push({
        extension: `(repo ${repo})`,
        status: "failed",
        repo,
        detail: reason,
        added: 0,
        removed: 0,
        mappings: 0,
      });
    }

    return {
      ranAt,
      dryRun,
      written: outcomes.filter((o) => o.status === "write").length,
      failed: outcomes.filter((o) => o.status === "failed").length,
      outcomes,
      ...(unavailable ? { skippedReason: `${unavailable} (dry run only)` } : {}),
    };
  }

  private async syncOne(
    extension: string,
    rows: ParsedIdMapRow[],
    filename: string,
    index: RepoIndex,
    opts: { dryRun: boolean; force?: boolean; actor: string },
  ): Promise<MapSyncOutcome> {
    const base: Pick<MapSyncOutcome, "extension" | "added" | "removed" | "mappings"> = {
      extension,
      added: 0,
      removed: 0,
      mappings: rows.length,
    };

    const repos = index.byExtension.get(extension) ?? [];
    if (repos.length === 0) {
      return {
        ...base,
        status: "skipped",
        detail:
          index.unreadable.size > 0
            ? "not found in any readable extensions repo"
            : `no ${EXTENSIONS_DIR}/${extension} directory in ${this.cfg.repos.join(" or ")}`,
      };
    }
    if (repos.length > 1) {
      // Two repos both claiming the extension is a real configuration problem
      // (a fork left in GITHUB_EXTENSIONS_REPOS, or a half-finished move).
      // Writing to the wrong one would look like it worked.
      return {
        ...base,
        status: "skipped",
        detail: `${EXTENSIONS_DIR}/${extension} exists in more than one repo (${repos.join(", ")}); refusing to guess`,
      };
    }
    const repo = repos[0]!;
    const path = `${EXTENSIONS_DIR}/${extension}/${filename}`;
    if (!isSafeRepoPath(path)) {
      return { ...base, status: "failed", repo, detail: `${filename} is not a usable repo path` };
    }

    try {
      const existing = await this.contents.getFile(this.githubConfig(), repo, path);
      const parsed = existing ? parseMapText(existing.text) : null;
      const text = renderMapFile(rows, parsed?.shape ?? DEFAULT_SHAPE);
      const plan = planWrite(
        existing && parsed ? { text: existing.text, rows: parsed.rows } : null,
        { text, rows },
        opts.force === true ? { force: true } : {},
      );
      const outcome: MapSyncOutcome = {
        ...base,
        status: plan.action,
        repo,
        path,
        added: plan.added,
        removed: plan.removed,
        ...(plan.reason ? { detail: plan.reason } : {}),
      };

      if (plan.action !== "write") {
        if (plan.action === "refused") {
          this.deps.log.warn({ extension, repo, path, detail: plan.reason }, "series-map write refused");
        }
        return outcome;
      }
      if (opts.dryRun) return { ...outcome, detail: "would write" };

      const put = await this.contents.putFile(this.githubConfig(), repo, {
        path,
        text,
        message: commitMessage(extension, filename, plan.added, plan.removed),
        sha: existing!.sha,
      });
      await this.deps.audit.record(opts.actor, "map_sync.write", `${extension}@${repo}`, {
        path,
        commit: put.commit,
        added: plan.added,
        removed: plan.removed,
        mappings: rows.length,
      });
      this.deps.log.info(
        { extension, repo, path, commit: put.commit, added: plan.added, removed: plan.removed },
        "wrote the series map to GitHub",
      );
      return { ...outcome, commit: put.commit };
    } catch (err) {
      // Scoped to this extension: one unreachable file must not stop the rest.
      const detail = err instanceof GithubApiError ? err.message : "GitHub request failed";
      this.deps.log.error({ err, extension, repo, path }, "series-map sync failed for an extension");
      return { ...base, status: "failed", repo, path, detail };
    }
  }

  private githubConfig(): GithubApiConfig {
    return {
      apiUrl: this.cfg.apiUrl,
      owner: this.cfg.owner,
      ...(this.cfg.token ? { token: this.cfg.token } : {}),
    };
  }

  /** Tracked rows grouped by extension, in the file's own row shape. */
  private async trackedByExtension(only: Set<string>): Promise<Map<string, ParsedIdMapRow[]>> {
    const rows = await this.deps.prisma.trackedManga.findMany({
      ...(only.size > 0 ? { where: { extension: { in: [...only] } } } : {}),
      select: { extension: true, namespace: true, mangaId: true, mdMangaId: true },
      orderBy: [{ extension: "asc" }, { namespace: "asc" }, { mangaId: "asc" }],
    });
    const out = new Map<string, ParsedIdMapRow[]>();
    for (const row of rows) {
      const bucket = out.get(row.extension);
      const entry = { namespace: row.namespace, mangaId: row.mangaId, mdMangaId: row.mdMangaId };
      if (bucket) bucket.push(entry);
      else out.set(row.extension, [entry]);
    }
    return out;
  }

  /**
   * Each extension's map filename, from the manifest of its latest bundle.
   * Extensions whose manifest does not name one keep the convention.
   */
  private async mapFilePaths(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const bundle of await this.bundles.listLatest()) {
      const parsed = Manifest.safeParse(bundle.manifest);
      if (!parsed.success) continue;
      const named = parsed.data.data_files["manga_id_map"];
      if (named) out.set(bundle.extension, named);
    }
    return out;
  }

  /** Which repo holds each extension, discovered from the repos' `src/` listing. */
  private async repoIndex(): Promise<RepoIndex> {
    const byExtension = new Map<string, string[]>();
    const unreadable = new Map<string, string>();
    for (const repo of this.cfg.repos) {
      let names: string[];
      try {
        names = await this.contents.listDirs(this.githubConfig(), repo, EXTENSIONS_DIR);
      } catch (err) {
        const detail = err instanceof GithubApiError ? err.message : `could not list ${repo}`;
        this.deps.log.error({ err, repo }, "series-map sync could not list an extensions repo");
        unreadable.set(repo, detail);
        continue;
      }
      for (const name of names) {
        const bucket = byExtension.get(name);
        if (bucket) bucket.push(repo);
        else byExtension.set(name, [repo]);
      }
    }
    return { byExtension, unreadable };
  }

  /** Create the timestamp row, losing gracefully to a replica that got there first. */
  private async seedFirstRun(now: Date): Promise<boolean> {
    try {
      await this.deps.prisma.setting.create({
        data: { key: MAP_SYNC_LAST_RUN_KEY, value: now.toISOString() },
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Compare-and-set the timestamp. False means another replica claimed the slot. */
  private async claim(expected: string, now: Date): Promise<boolean> {
    const { count } = await this.deps.prisma.setting.updateMany({
      where: { key: MAP_SYNC_LAST_RUN_KEY, value: expected },
      data: { value: now.toISOString() },
    });
    return count > 0;
  }
}

interface RepoIndex {
  byExtension: Map<string, string[]>;
  /** Repos GitHub would not list, with the reason. */
  unreadable: Map<string, string>;
}

/**
 * The commit message, carrying the marker that stops the push webhook from
 * rebuilding a bundle for a data-file change we ourselves made (see
 * `isMapSyncPush`). The counts are in the subject on purpose: `git log --oneline`
 * in the extensions repo should say what a week of drift amounted to.
 */
export function commitMessage(
  extension: string,
  filename: string,
  added: number,
  removed: number,
): string {
  const delta = [added > 0 ? `+${added}` : null, removed > 0 ? `-${removed}` : null]
    .filter(Boolean)
    .join(" ");
  return (
    `chore(${extension}): sync ${filename}${delta ? ` (${delta})` : ""} ${MAP_SYNC_COMMIT_MARKER}\n` +
    "\n" +
    "Written by the publoader series-map sync. The tracked_manga table is the\n" +
    "authority for this mapping; this file is the readable copy contributors edit,\n" +
    "and new entries added here are still imported on the next publish.\n"
  );
}
