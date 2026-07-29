/**
 * What a push to an extensions repo actually does.
 *
 * The legacy bot answered a push by `git pull`ing the extensions repo and
 * re-importing the changed modules in-process. There is no in-process extension
 * code any more: workers execute content-addressed bundles pinned by sha256, so
 * the modern equivalent of "reload" is "publish a new bundle". The next
 * scheduled run picks it up, because the scheduler pins each job to
 * `BundleStore.latest(extension)`.
 *
 * Everything is bounded. A webhook is an unauthenticated-until-verified request
 * from the internet, and even a legitimate one names a repo whose size we do not
 * control, so there are caps on the download, on how many extensions one
 * delivery may publish, and on total wall-clock time.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BundleStore } from "../store/bundles.js";
import { BundleRejectedError } from "../store/bundles.js";
import type { AuditLog } from "../store/settings.js";
import type { Logger } from "../../logging.js";
import { BundleBuildError, buildExtensionBundle } from "./bundleBuilder.js";
import {
  extensionRepoPath,
  extractSubtree,
  fetchRepoArchive,
  RepoArchiveError,
  type RepoArchiveFetcher,
} from "./repoArchive.js";
import type { PushPayload } from "./github.js";

/**
 * One delivery may publish at most this many extensions. A push that touches
 * more is almost certainly a repo-wide reformat or a merge of a long branch,
 * where republishing everything at once is both slow and not what anyone
 * wanted; the excess is reported so it can be published deliberately.
 */
export const MAX_EXTENSIONS_PER_DELIVERY = 5;

/**
 * Total budget for the handler. Note this is far above GitHub's own ~10s
 * response timeout: the work is done synchronously so the delivery body can
 * report per-extension outcomes, which means a slow delivery may be recorded
 * red by GitHub even though it succeeded. The audit log is the authority.
 * See docs/webhooks.md.
 */
export const PUSH_BUDGET_MS = 90_000;

export interface PublishOutcome {
  extension: string;
  status: "published" | "unchanged" | "failed" | "skipped";
  version?: string;
  sha256?: string;
  /** Operator-readable reason for `failed` / `skipped`. Never a stack trace. */
  detail?: string;
}

export interface PushHandlerDeps {
  bundles: BundleStore;
  audit: AuditLog;
  log: Logger;
  /** Overridden in tests; the default is the real GitHub download. */
  fetchArchive?: RepoArchiveFetcher;
  now?: () => number;
}

export interface PushHandlerConfig {
  owner: string;
  token?: string;
  apiUrl: string;
}

export interface PushResult {
  commit: string;
  outcomes: PublishOutcome[];
}

/**
 * Publish a bundle for every extension the push touched.
 *
 * One archive is downloaded per delivery and every changed extension is
 * extracted from it — two extensions in one push must not mean two downloads of
 * the same tree. A failure is always scoped to the extension that caused it:
 * one unbuildable extension must not stop the others from shipping.
 */
export async function handleExtensionsPush(
  payload: PushPayload,
  repo: string,
  commit: string,
  changed: string[],
  cfg: PushHandlerConfig,
  deps: PushHandlerDeps,
): Promise<PushResult> {
  const now = deps.now ?? Date.now;
  const deadline = now() + PUSH_BUDGET_MS;
  const outcomes: PublishOutcome[] = [];

  const selected = changed.slice(0, MAX_EXTENSIONS_PER_DELIVERY);
  for (const extension of changed.slice(MAX_EXTENSIONS_PER_DELIVERY)) {
    outcomes.push({
      extension,
      status: "skipped",
      detail: `more than ${MAX_EXTENSIONS_PER_DELIVERY} extensions changed in one push; publish this one with \`publoader-admin bundle publish\``,
    });
  }
  if (selected.length === 0) return { commit, outcomes };

  let archive: Buffer;
  try {
    archive = await (deps.fetchArchive ?? fetchRepoArchive)({
      owner: cfg.owner,
      repo,
      ref: commit,
      ...(cfg.token ? { token: cfg.token } : {}),
      apiUrl: cfg.apiUrl,
    });
  } catch (err) {
    // The whole delivery fails here: without the tree there is nothing to
    // publish for any extension.
    const detail = err instanceof RepoArchiveError ? err.message : "repository archive fetch failed";
    deps.log.error({ err, repo, commit }, "webhook could not fetch repository archive");
    return {
      commit,
      outcomes: [
        ...outcomes,
        ...selected.map((extension): PublishOutcome => ({ extension, status: "failed", detail })),
      ],
    };
  }

  for (const extension of selected) {
    if (now() >= deadline) {
      outcomes.push({
        extension,
        status: "skipped",
        detail: "delivery ran out of time budget before this extension was reached",
      });
      continue;
    }
    outcomes.push(
      await publishOne(archive, extension, repo, commit, deps, payload),
    );
  }
  return { commit, outcomes };
}

async function publishOne(
  archive: Buffer,
  extension: string,
  repo: string,
  commit: string,
  deps: PushHandlerDeps,
  payload: PushPayload,
): Promise<PublishOutcome> {
  const workDir = mkdtempSync(join(tmpdir(), `publoader-push-${extension}-`));
  try {
    const files = extractSubtree(archive, extensionRepoPath(extension), workDir);
    if (files === 0) {
      // Every path of the extension was removed by this push. Bundles are
      // never deleted by a webhook — yanking a live extension on the strength
      // of an unauthenticated-shaped trigger is not a decision to automate.
      return {
        extension,
        status: "skipped",
        detail: `src/${extension} is not present at ${commit}; if it was deleted, yank it with \`publoader-admin bundle yank\``,
      };
    }

    const built = await buildExtensionBundle(workDir);
    if (built.manifest.name !== extension) {
      // The directory name is what the push payload told us changed; the
      // manifest name is what the platform keys everything on. If they
      // disagree, publishing would silently write to a different extension.
      return {
        extension,
        status: "failed",
        detail: `src/${extension}/manifest.json declares name '${built.manifest.name}'; the directory and the manifest name must match`,
      };
    }

    const { bundle, created } = await deps.bundles.publish({
      zipData: built.zipData,
      manifest: built.manifest,
      sourceCommit: commit,
    });
    await deps.audit.record(
      `github:${repo}@${commit.slice(0, 7)}`,
      "bundle.publish",
      `${bundle.extension}@${bundle.version}`,
      {
        sha256: bundle.sha256,
        sourceCommit: commit,
        created,
        via: "github-webhook",
        ref: payload.ref,
        builtFrom: built.builtFrom,
      },
    );
    deps.log.info(
      { extension, version: bundle.version, sha256: bundle.sha256, created, commit },
      "webhook published bundle",
    );
    return {
      extension,
      status: created ? "published" : "unchanged",
      version: bundle.version,
      sha256: bundle.sha256,
    };
  } catch (err) {
    // Only reasons an operator can act on cross the boundary. Anything else is
    // logged with the error and reported generically — a webhook response is a
    // public surface once the secret leaks, and a stack trace names paths.
    const detail =
      err instanceof BundleBuildError || err instanceof BundleRejectedError
        ? err.message
        : err instanceof RepoArchiveError
          ? err.message
          : "publish failed; see core-api logs";
    deps.log.error({ err, extension, commit }, "webhook failed to publish extension");
    return { extension, status: "failed", detail };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
