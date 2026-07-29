/**
 * Pure decision logic for GitHub push webhooks: is this delivery authentic,
 * does it concern a repo we track, and if so which extensions changed.
 *
 * Nothing here does I/O, so every branch — including every reason a delivery is
 * ignored — is directly testable. Ported from the legacy
 * publoader/github_webhook.py (`verify_signature` / `slot_for_push`), keeping
 * its rejection reasons: they are echoed back to GitHub so a delivery log entry
 * explains itself without anyone reading server logs.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { EXTENSION_NAME_RE } from "../../contracts/manifest.js";

/**
 * GitHub push payloads are tens of KB at most. Matches the legacy cap; applied
 * as the route's bodyLimit so it is enforced before the body is buffered, let
 * alone parsed.
 */
export const MAX_WEBHOOK_BODY_BYTES = 5 * 1024 * 1024;

/** `sha256=` + a 64-character hex digest. Any other length cannot be valid. */
const SIGNATURE_LENGTH = "sha256=".length + 64;

/**
 * Constant-time check of GitHub's X-Hub-Signature-256 header.
 *
 * The length pre-check is not a timing leak: the expected length is a public
 * constant, so an attacker learns nothing from it that the algorithm name did
 * not already tell them. It exists because timingSafeEqual throws on
 * mismatched lengths rather than returning false.
 */
export function verifySignature(
  secret: string | undefined,
  body: Buffer,
  signatureHeader: string | undefined,
): boolean {
  if (!secret || !signatureHeader) return false;
  if (signatureHeader.length !== SIGNATURE_LENGTH) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(signatureHeader, "utf8"));
}

/**
 * What a tracked repo means to us.
 *
 * "extensions" is the only role with an action attached: a push publishes new
 * bundles. "core" is acknowledged and does nothing — core is deployed as an
 * image now (see docs/deployment.md), so there is nothing for a running
 * container to pull.
 */
export type RepoRole = "extensions" | "core";

export interface GithubWebhookConfig {
  /** Shared HMAC secret. Absent means the endpoint refuses everything. */
  secret?: string;
  /** Required to match `repository.full_name`'s owner, case-insensitively. */
  owner: string;
  /** Repo names whose pushes publish bundles. */
  extensionsRepos: string[];
  /** Repo name for the core service image, if pushes to it should be acknowledged. */
  coreRepo?: string;
}

/** Only the payload fields we act on. Everything else is ignored by design. */
export interface PushPayload {
  ref?: string;
  after?: string;
  repository?: {
    name?: string;
    full_name?: string;
    default_branch?: string;
  };
  commits?: { added?: string[]; modified?: string[]; removed?: string[] }[];
  head_commit?: { added?: string[]; modified?: string[]; removed?: string[] } | null;
}

export type RoleDecision =
  | { role: RepoRole; repo: string; after: string }
  | { role: null; reason: string };

/**
 * Map a push payload to a repo role, or explain why the push is ignored.
 *
 * Three gates, all inherited from the legacy `slot_for_push`: the repo must be
 * one we track, the owner must match (so a fork of a tracked repo cannot
 * trigger a publish), and the push must be on that repo's default branch (so a
 * feature branch or a tag does not ship code).
 */
export function roleForPush(payload: PushPayload, cfg: GithubWebhookConfig): RoleDecision {
  const repo = payload.repository ?? {};
  const name = repo.name;
  if (!name) return { role: null, reason: "payload has no repository.name" };

  const role: RepoRole | null = cfg.extensionsRepos.includes(name)
    ? "extensions"
    : cfg.coreRepo && cfg.coreRepo === name
      ? "core"
      : null;
  if (role === null) return { role: null, reason: `untracked repo '${name}'` };

  const fullName = (repo.full_name ?? "").toLowerCase();
  if (cfg.owner && fullName && fullName !== `${cfg.owner}/${name}`.toLowerCase()) {
    return { role: null, reason: "owner mismatch" };
  }

  const defaultBranch = repo.default_branch;
  const ref = payload.ref;
  if (defaultBranch && ref && ref !== `refs/heads/${defaultBranch}`) {
    return { role: null, reason: `ignored ref ${ref}` };
  }

  const after = payload.after ?? "";
  if (!/^[0-9a-f]{40}$/.test(after)) {
    // The sha is interpolated into a GitHub API URL and recorded as a bundle's
    // sourceCommit; accept only something that is actually a commit id.
    return { role: null, reason: "payload has no usable commit sha in 'after'" };
  }

  return { role, repo: name, after };
}

/**
 * Extension directories live at `src/<extension>/…` in both extensions repos.
 * The capture group is constrained to the same character set the manifest
 * schema enforces, so a path cannot name an extension the platform would
 * reject anyway.
 */
const EXTENSION_PATH_RE = /^src\/([a-z0-9_]+)\//;

/**
 * Which extensions a push touched, from the paths in its commits.
 *
 * `commits` is truncated to 20 entries on large pushes, with `head_commit`
 * always present, so both are read and unioned — missing an extension because
 * a push was big would silently ship stale code.
 *
 * A removed path still counts as a change: deleting one file from an extension
 * (a data file, a helper module) changes the program that should be published.
 * A *fully* deleted extension directory has no manifest.json to build, which
 * surfaces as that extension's per-extension error rather than being guessed
 * at here.
 */
export function changedExtensions(payload: PushPayload): string[] {
  const found = new Set<string>();
  const commits = [...(payload.commits ?? []), ...(payload.head_commit ? [payload.head_commit] : [])];
  for (const commit of commits) {
    for (const path of [...(commit.added ?? []), ...(commit.modified ?? []), ...(commit.removed ?? [])]) {
      const match = EXTENSION_PATH_RE.exec(path);
      if (match && EXTENSION_NAME_RE.test(match[1]!)) found.add(match[1]!);
    }
  }
  return [...found].sort();
}
