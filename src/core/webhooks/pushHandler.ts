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
  fetchRepoArchive,
  RepoArchiveError,
  type RepoArchiveFetcher,
} from "./repoArchive.js";
import { BundleIntakeError, extractBundleTree } from "../sysops/bundleIntake.js";
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
  return publishExtensionFromArchive(archive, extension, commit, deps, {
    actor: `github:${repo}@${commit.slice(0, 7)}`,
    via: "github-webhook",
    ...(payload.ref ? { ref: payload.ref } : {}),
  });
}

/**
 * Who is publishing and by which route, for the audit entry.
 *
 * The webhook is not the only caller any more: the operator's "fetch latest
 * changes" and "install this extension" actions run the same extract → build →
 * publish path (see routes/sysops.ts). One publish path is the point — two
 * would be two different programs producing bundles the sha256 pin claims are
 * interchangeable — so the difference between callers is confined to this
 * struct, which lands in the audit log rather than in the logic.
 */
export interface PublishAttribution {
  /** Audit actor, e.g. `github:publoader-extensions@1a2b3c4` or `user:iam@ardax.dev`. */
  actor: string;
  /** `detail.via`: which path published this bundle. */
  via: string;
  /** Git ref, when the caller has one. */
  ref?: string;
}

/** What publishing needs from the app context; the fetcher and clock are not used. */
export type PublishDeps = Pick<PushHandlerDeps, "bundles" | "audit" | "log">;

/**
 * Extract one extension directory out of a repo archive and publish it.
 *
 * `extension` is the directory under `src/` AND the name the manifest must
 * declare: the two disagreeing means a publish would silently write to a
 * different extension than the caller named, which is refused rather than
 * guessed at.
 */
export async function publishExtensionFromArchive(
  archive: Buffer,
  extension: string,
  commit: string,
  deps: PublishDeps,
  attribution: PublishAttribution,
  options: PublishFromArchiveOptions = {},
): Promise<PublishOutcome> {
  const from = options.subPath ?? extensionRepoPath(extension);
  const workDir = mkdtempSync(join(tmpdir(), `publoader-push-${extension}-`));
  try {
    try {
      // A repository archive gets the same intake as an operator's upload: it is
      // whatever anyone who can push to that repo wrote, fetched over the
      // network. See core/sysops/bundleIntake.ts.
      extractBundleTree(archive, workDir, { stripArchiveRoot: true, subPath: from });
    } catch (err) {
      if (err instanceof BundleIntakeError && err.code === "subtree_missing") {
        // Every path of the extension was removed by this push. Nothing is taken
        // out of rotation here — retiring a live extension on the strength of a
        // push payload is not a decision to automate.
        return {
          extension,
          status: "skipped",
          detail: `${from} is not present at ${commit}; if it was deleted, take it out of rotation with \`publoader-admin extensions disable ${extension}\``,
        };
      }
      const detail =
        err instanceof BundleIntakeError
          ? err.message
          : err instanceof RepoArchiveError
            ? err.message
            : "archive could not be read";
      deps.log.error(
        { err, extension, commit, code: err instanceof BundleIntakeError ? err.code : undefined },
        "refused an extension archive",
      );
      return { extension, status: "failed", detail };
    }
    return await publishExtensionDirectory(workDir, deps, attribution, {
      expectedName: options.requireName === false ? null : extension,
      sourceCommit: commit,
      origin: from,
    });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export interface PublishFromArchiveOptions {
  /** Repo-relative directory, when it is not the conventional `src/<extension>`. */
  subPath?: string;
  /**
   * Whether the manifest must declare `extension`. The webhook needs it: the
   * push payload names the directory, and a mismatch would publish to a
   * different extension than the one that changed. An operator installing an
   * explicit path has already said which directory they mean, so there the
   * manifest is the only authority on the name.
   */
  requireName?: boolean;
}

export interface PublishDirectoryOptions {
  /**
   * Name the manifest must declare, when the caller already knows it (a repo
   * directory name). Null accepts whatever the manifest says — the upload path,
   * where the manifest is the only source of the name.
   */
  expectedName?: string | null;
  /** Commit the directory came from, recorded on the bundle. */
  sourceCommit?: string;
  /** Human-readable origin for error messages, e.g. `src/mangaplus` or `upload`. */
  origin?: string;
}

/**
 * Build a staged extension directory into a bundle and publish it.
 *
 * The build (esbuild for TypeScript sources, deterministic zip) is
 * bundleBuilder's; the acceptance rules (manifest schema, node entrypoint, no
 * python) are BundleStore's. Everything here is bookkeeping: the name check, the
 * audit entry, and turning a throw into an outcome an operator can read.
 */
export async function publishExtensionDirectory(
  dir: string,
  deps: PublishDeps,
  attribution: PublishAttribution,
  options: PublishDirectoryOptions = {},
): Promise<PublishOutcome> {
  const expected = options.expectedName ?? null;
  const origin = options.origin ?? "the uploaded directory";
  // Only used for reporting until the manifest is read.
  let extension = expected ?? "(unknown)";
  try {
    const built = await buildExtensionBundle(dir);
    if (expected !== null && built.manifest.name !== expected) {
      // The directory name is what the caller told us changed; the manifest name
      // is what the platform keys everything on. If they disagree, publishing
      // would silently write to a different extension.
      return {
        extension: expected,
        status: "failed",
        detail: `${origin}/manifest.json declares name '${built.manifest.name}'; the directory and the manifest name must match`,
      };
    }
    extension = built.manifest.name;

    const { bundle, created } = await deps.bundles.publish({
      zipData: built.zipData,
      manifest: built.manifest,
      ...(options.sourceCommit ? { sourceCommit: options.sourceCommit } : {}),
    });
    await deps.audit.record(
      attribution.actor,
      "bundle.publish",
      `${bundle.extension}@${bundle.version}`,
      {
        sha256: bundle.sha256,
        sourceCommit: options.sourceCommit,
        created,
        via: attribution.via,
        ref: attribution.ref,
        builtFrom: built.builtFrom,
      },
    );
    deps.log.info(
      {
        extension: bundle.extension,
        version: bundle.version,
        sha256: bundle.sha256,
        created,
        commit: options.sourceCommit,
        via: attribution.via,
      },
      "published bundle",
    );
    return {
      extension: bundle.extension,
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
    deps.log.error({ err, extension, commit: options.sourceCommit }, "failed to publish extension");
    return { extension, status: "failed", detail };
  }
}
