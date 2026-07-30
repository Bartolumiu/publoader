// Not self-registering: server.ts is owned elsewhere, so the integrator wires
// this module in with `registerSysopsRoutes(app, ctx)` next to the other route
// modules.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { adminAuthHook, requireOwner, requireScope } from "../auth.js";
import { sessionAuthenticator } from "../session.js";
import { EXTENSION_NAME_RE } from "../../../contracts/manifest.js";
import {
  fetchRepoArchive,
  findExtensionDirs,
  findManifestRoot,
  extractUploadedTree,
  RepoArchiveError,
  type RepoArchiveFetcher,
} from "../../webhooks/repoArchive.js";
import {
  publishExtensionDirectory,
  publishExtensionFromArchive,
  type PublishAttribution,
  type PublishOutcome,
} from "../../webhooks/pushHandler.js";
import {
  githubMeta,
  GithubApiError,
  type GithubApiConfig,
  type GithubMetaClient,
} from "../../webhooks/repoMeta.js";
import { parseRepoList } from "./webhooks.js";
import { listDocs, readDoc, resolveDocsDir } from "../../sysops/docsStore.js";
import {
  isRestartTarget,
  writeRestartRequest,
  RESTART_REQUEST_TTL_MS,
  RESTART_TARGETS,
  type RestartTarget,
} from "../../sysops/restartSignal.js";

/**
 * The four things an operator used to need a shell for.
 *
 * Everything else in the dashboard answers "what is the platform doing?". These
 * routes answer "make it do something to itself": pull the latest extension code
 * from GitHub, restart a service, install an extension that is not in a
 * configured repo yet, and read the documentation. The pattern each one follows
 * is the same — reuse the mechanism that already exists, and be explicit about
 * what it cannot do:
 *
 *  - sync REUSES the push webhook's publish path (extract → esbuild → publish),
 *    so a bundle published by a button and a bundle published by a push are the
 *    same bytes with the same sha256. Two publish paths would be two programs.
 *  - restart is a graceful SELF-EXIT that depends on the container restart
 *    policy. There is no Docker socket here and there must never be one: it is
 *    root-equivalent host access, and this process is reachable from the
 *    internet. See core/sysops/restartSignal.ts.
 *  - install accepts a repo or a zip and runs the same builder, so "it works on
 *    my laptop" and "it works in the platform" cannot diverge.
 *  - docs are served from the image, read-only, from an allowlist.
 */

/** Uploaded bundles use the same ceiling as POST /api/v1/admin/bundles. */
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

/**
 * Ceiling on GitHub API calls for one status/sync request. Each extension may
 * cost one compare per configured repo, and an operator holding down a refresh
 * button must not be able to burn a 5000/hour token budget (or a 60/hour
 * anonymous one) on our behalf.
 */
const MAX_GITHUB_CALLS = 40;

/** One sync publishes at most this many extensions; the rest are reported. */
const MAX_SYNC_EXTENSIONS = 10;

/** Total wall-clock budget for a sync, including downloads and builds. */
const SYNC_BUDGET_MS = 120_000;

/**
 * Delay between answering a restart request and actually exiting. Long enough
 * for the response to reach the browser through the tunnel — an operator who
 * gets a connection reset instead of a 202 has no idea whether the restart
 * happened.
 */
const RESTART_DELAY_MS = 500;

export interface SysopsRouteOptions {
  /** Test seam: GitHub metadata reads (default branch HEAD, commit compare). */
  github?: GithubMetaClient;
  /** Test seam: the repository archive download. */
  fetchArchive?: RepoArchiveFetcher;
  /**
   * Test seam: what "restart myself" does. The default raises SIGTERM on our own
   * pid, which runs the service's existing shutdown path (close the server,
   * disconnect prisma, exit 0) rather than a bare process.exit.
   */
  selfExit?: (target: RestartTarget) => void;
  /** Test seam: docs directory, overriding config.docsPath and the search. */
  docsDir?: string;
}

const RestartBody = z.object({
  target: z
    .string()
    .refine(isRestartTarget, `target must be one of: ${RESTART_TARGETS.join(", ")}`),
});

const SyncBody = z.object({
  extensions: z.array(z.string().regex(EXTENSION_NAME_RE)).max(50).optional(),
  dryRun: z.boolean().default(false),
});

/**
 * `owner/name` or a bare `name` (which takes GITHUB_REPO_OWNER). Constrained to
 * what GitHub itself allows, because both halves are interpolated into an API
 * URL — encodeURIComponent already handles that, but a name this shape also
 * cannot be a path or a scheme in an error message an operator reads.
 */
const RepoRef = z
  .string()
  .min(1)
  .max(140)
  .regex(/^([A-Za-z0-9][A-Za-z0-9-]{0,38}\/)?[A-Za-z0-9._-]{1,100}$/, "expected `name` or `owner/name`");

/**
 * A repo-relative directory. No leading slash, no `..`, no backslashes: this
 * string selects a subtree of a downloaded archive, and extractSubtree's own
 * zip-slip check is the backstop rather than the only defence.
 */
const RepoPath = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/, "expected a repo-relative directory path")
  .refine((p) => !p.split("/").includes(".."), "path may not contain ..");

const InstallGithubBody = z.object({
  repo: RepoRef,
  /** Branch, tag or commit sha. Defaults to the repo's default branch HEAD. */
  ref: z.string().min(1).max(120).optional(),
  path: RepoPath.optional(),
});

function parseOrThrow<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue && issue.path.length > 0 ? issue.path.join(".") : "request";
  throw Object.assign(new Error(`invalid ${where}: ${issue?.message ?? "validation failed"}`), {
    statusCode: 400,
  });
}

/** Per-extension answer to "is what is published still what is in git?". */
interface ExtensionStatus {
  extension: string;
  publishedVersion: string | null;
  /** The commit the live bundle was built from, or null if it was not recorded. */
  publishedCommit: string | null;
  /** Which configured repo the published commit was found in, or null. */
  repo: string | null;
  /** That repo's default-branch HEAD. */
  latestCommit: string | null;
  /**
   * True when HEAD differs from the published commit. Null means the question
   * could not be answered — never `false`, which an operator would read as
   * "up to date".
   */
  behind: boolean | null;
  /** Paths under the extension's directory that changed, when known. */
  changedPaths?: string[];
  /** True when GitHub truncated the file list, so `changedPaths` is incomplete. */
  pathsTruncated?: boolean;
  /** Why `behind` is null, or why the answer is partial. */
  reason?: string;
}

interface RepoStatus {
  repo: string;
  defaultBranch?: string;
  sha?: string;
  error?: string;
}

interface GithubStatus {
  /** False when the answer is "I cannot tell you", with `reason` saying why. */
  available: boolean;
  reason?: string;
  /** Whether a GITHUB_TOKEN was presented. Anonymous reads are 60/hour. */
  authenticated: boolean;
  repos: RepoStatus[];
  extensions: ExtensionStatus[];
  /** True when the GitHub call budget was exhausted before every extension. */
  truncated: boolean;
}

export function registerSysopsRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  options: SysopsRouteOptions = {},
): void {
  const github = options.github ?? githubMeta;
  const fetchArchive = options.fetchArchive ?? ctx.webhookFetchArchive ?? fetchRepoArchive;
  const selfExit =
    options.selfExit ??
    ((target: RestartTarget) => {
      ctx.log.warn({ target }, "restart requested: raising SIGTERM on self");
      // The registered SIGTERM handler closes the HTTP server, closes the
      // metrics server and disconnects prisma before exiting 0. Docker's
      // `restart: unless-stopped` starts us again.
      process.kill(process.pid, "SIGTERM");
    });

  // Resolved once: the answer cannot change while the process lives, and a
  // per-request upward filesystem walk would be pure waste. A missing directory
  // is reported by the route, not hidden.
  const docsDir = options.docsDir ?? resolveDocsDir(ctx.config.docsPath);

  const githubConfig = (): GithubApiConfig => ({
    apiUrl: ctx.config.githubApiUrl,
    owner: ctx.config.githubRepoOwner,
    ...(ctx.config.githubToken ? { token: ctx.config.githubToken } : {}),
  });

  app.register(async (scope) => {
    scope.addHook(
      "preHandler",
      adminAuthHook({
        adminToken: ctx.config.adminToken,
        session: sessionAuthenticator(ctx),
        apiTokens: ctx.apiTokens,
      }),
    );
    scope.addHook("preHandler", async (req, reply) => {
      if (!ctx.adminLimiter.allow(req.ip)) {
        await reply.code(429).send({ error: "rate limited" });
      }
    });

    /** Same attribution rules as routes/admin.ts and routes/ops.ts. */
    const actor = (req: FastifyRequest) => {
      const claimed = (req.headers["x-actor"] as string | undefined)?.slice(0, 64);
      const principal = req.principal;
      if (principal?.kind === "api-token") {
        return claimed ? `${principal.name} for ${claimed}` : principal.name;
      }
      if (principal?.kind === "session") return principal.name;
      return `admin:${claimed ?? "root"}`;
    };

    // ---- 1. is there anything new on GitHub? ----

    /**
     * Compare every published extension against its repo's default-branch HEAD.
     *
     * The honesty requirement is the whole design here. There are four ways this
     * can fail to know the answer — no repos configured, no token for a private
     * repo, GitHub unreachable, or a bundle published without a `sourceCommit` —
     * and all four must read as "cannot tell, because X" rather than as "up to
     * date". An operator who is told everything is current does not look again.
     */
    scope.get(
      "/api/v1/admin/sysops/github/status",
      { preHandler: requireScope("bundles:read") },
      async () => collectGithubStatus(),
    );

    /**
     * Publish the extensions that are behind, using the push webhook's path.
     *
     * Per-extension outcomes, and one failure never fails the others: a repo
     * where someone broke the TypeScript must not block the four extensions that
     * build fine. `dryRun` answers "what would this do?" without publishing,
     * which is the safe way to use a button that changes the code every worker
     * will execute.
     */
    scope.post(
      "/api/v1/admin/sysops/github/sync",
      { preHandler: requireScope("bundles:write") },
      async (req, reply) => {
        const body = parseOrThrow(SyncBody, req.body ?? {});
        const status = await collectGithubStatus();
        if (!status.available) {
          return reply.code(503).send({ error: status.reason ?? "GitHub is not available" });
        }

        const requested = body.extensions ? new Set(body.extensions) : null;
        const outcomes: SyncOutcome[] = [];
        const candidates: ExtensionStatus[] = [];

        for (const entry of status.extensions) {
          if (requested && !requested.has(entry.extension)) continue;
          if (entry.behind === null) {
            outcomes.push({
              extension: entry.extension,
              status: "skipped",
              detail: entry.reason ?? "could not determine whether this extension is behind",
            });
          } else if (!entry.behind) {
            outcomes.push({
              extension: entry.extension,
              status: "current",
              detail: `already published from ${entry.publishedCommit?.slice(0, 7) ?? "an unknown commit"}`,
            });
          } else {
            candidates.push(entry);
          }
        }
        for (const name of requested ?? []) {
          if (!status.extensions.some((entry) => entry.extension === name)) {
            outcomes.push({
              extension: name,
              status: "skipped",
              detail: "no published bundle for this extension; install it first",
            });
          }
        }

        for (const entry of candidates.slice(MAX_SYNC_EXTENSIONS)) {
          outcomes.push({
            extension: entry.extension,
            status: "skipped",
            detail: `more than ${MAX_SYNC_EXTENSIONS} extensions are behind; sync the rest in a second pass`,
          });
        }

        const deadline = Date.now() + SYNC_BUDGET_MS;
        // One archive per repo, not one per extension: two extensions behind in
        // the same repo must not mean downloading the same tree twice.
        const archives = new Map<string, Buffer>();

        for (const entry of candidates.slice(0, MAX_SYNC_EXTENSIONS)) {
          const repo = entry.repo;
          const commit = entry.latestCommit;
          if (!repo || !commit) {
            outcomes.push({
              extension: entry.extension,
              status: "skipped",
              detail: "no repo or HEAD commit resolved for this extension",
            });
            continue;
          }
          if (body.dryRun) {
            outcomes.push({
              extension: entry.extension,
              status: "would-publish",
              repo,
              commit,
              detail: `would build src/${entry.extension} at ${commit.slice(0, 7)} and publish it`,
              ...(entry.changedPaths ? { changedPaths: entry.changedPaths } : {}),
            });
            continue;
          }
          if (Date.now() >= deadline) {
            outcomes.push({
              extension: entry.extension,
              status: "skipped",
              detail: "sync ran out of its time budget before this extension was reached",
            });
            continue;
          }

          let archive = archives.get(`${repo}@${commit}`);
          if (!archive) {
            try {
              archive = await fetchArchive({
                owner: ctx.config.githubRepoOwner,
                repo,
                ref: commit,
                ...(ctx.config.githubToken ? { token: ctx.config.githubToken } : {}),
                apiUrl: ctx.config.githubApiUrl,
              });
              archives.set(`${repo}@${commit}`, archive);
            } catch (err) {
              const detail =
                err instanceof RepoArchiveError ? err.message : "repository archive fetch failed";
              ctx.log.error({ err, repo, commit }, "sysops sync could not fetch repository archive");
              outcomes.push({ extension: entry.extension, status: "failed", repo, commit, detail });
              continue;
            }
          }

          const outcome = await publishExtensionFromArchive(
            archive,
            entry.extension,
            commit,
            ctx,
            attribution(actor(req), "sysops-github-sync", entry.repo ?? undefined),
          );
          outcomes.push({
            ...outcome,
            repo,
            commit,
            ...(await liveness(outcome)),
          });
        }

        const failed = outcomes.some((o) => o.status === "failed");
        return reply.code(failed ? 207 : 200).send({
          ok: !failed,
          dryRun: body.dryRun,
          outcomes,
          repos: status.repos,
        });
      },
    );

    // ---- 2. restart a service, without the Docker socket ----

    /**
     * Restart by graceful self-exit, relying on the container restart policy.
     *
     * OWNER *and* settings:write: an api-token is never OWNER however broadly it
     * is scoped, and "take the control plane down" is not an authority to hand a
     * machine client that only needed to publish bundles.
     *
     * The response is sent before the exit, and the exit uses the service's
     * existing SIGTERM path so in-flight work finishes the way it does on every
     * deploy. What this route CANNOT do is start something that is already down:
     * if the deployment has no restart policy, this is a stop button. That is
     * why it is refusable with SYSOPS_RESTART_ENABLED=false and why the response
     * says so out loud.
     */
    scope.post(
      "/api/v1/admin/sysops/restart",
      { preHandler: [requireOwner, requireScope("settings:write")] },
      async (req, reply) => {
        const body = parseOrThrow(RestartBody, req.body ?? {});
        const target = body.target as RestartTarget;

        if (!ctx.config.sysopsRestartEnabled) {
          return reply.code(503).send({
            error:
              "restart is disabled (SYSOPS_RESTART_ENABLED=false). Restart works by exiting the " +
              "process and letting the container runtime start it again; without a restart policy " +
              "that would stop the service for good.",
          });
        }

        const requestedAt = new Date().toISOString();
        const requestedBy = actor(req);
        const polled = target === "api" ? [] : servicesFor(target);

        // Written before the response so the row is durable even if this process
        // is the one exiting. The other services poll it; it expires on its own.
        if (polled.length > 0) {
          await writeRestartRequest(ctx.settings, { target, requestedAt, requestedBy });
        }
        await ctx.audit.record(requestedBy, "sysops.restart", target, {
          requestedAt,
          selfExit: target === "api" || target === "all",
          polled,
        });
        ctx.log.warn({ target, requestedBy }, "restart requested from the dashboard");

        const exiting = target === "api" || target === "all";
        reply.code(202).send({
          ok: true,
          target,
          /** The API exits itself; everything else acts on its next loop pass. */
          exitingNow: exiting ? ["api"] : [],
          polling: polled,
          requestedAt,
          note:
            "This relies on the container restart policy (`restart: unless-stopped`). " +
            "A service started by `docker run` without --restart, or a compose file without a " +
            "restart policy, will stay down. Polling services act within one loop pass " +
            `(up to ~30s) and ignore the request after ${Math.round(RESTART_REQUEST_TTL_MS / 1000)}s.`,
        });

        if (exiting) {
          const timer = setTimeout(() => selfExit(target), RESTART_DELAY_MS);
          // Never hold the event loop open on this timer's account: an unref'd
          // timer still fires in a live server, and a test that injects a
          // no-op selfExit must not hang for half a second at teardown.
          timer.unref();
        }
        return reply;
      },
    );

    // ---- 3. install an extension ----

    /**
     * Install from any GitHub repo, configured or not.
     *
     * This is the path for an extension that does not live in
     * GITHUB_EXTENSIONS_REPOS yet — a fork, a contributor's branch, a new source
     * being trialled. It is the same download, build and publish the webhook
     * runs; only the trigger and the audit attribution differ.
     */
    scope.post(
      "/api/v1/admin/sysops/extensions/install-github",
      { preHandler: requireScope("bundles:write") },
      async (req, reply) => {
        const body = parseOrThrow(InstallGithubBody, req.body ?? {});
        const slash = body.repo.indexOf("/");
        const owner = slash < 0 ? ctx.config.githubRepoOwner : body.repo.slice(0, slash);
        const repo = slash < 0 ? body.repo : body.repo.slice(slash + 1);

        // The commit is resolved rather than trusted so the bundle records real
        // provenance: `sourceCommit` is what the "is this behind?" check reads
        // later, and a branch name there would make that question unanswerable.
        let commit: string;
        let ref: string;
        try {
          if (body.ref && /^[0-9a-f]{40}$/.test(body.ref)) {
            commit = body.ref;
            ref = body.ref;
          } else if (body.ref) {
            commit = await github.resolveRef({ ...githubConfig(), owner }, repo, body.ref);
            ref = body.ref;
          } else {
            const head = await github.head({ ...githubConfig(), owner }, repo);
            commit = head.sha;
            ref = head.defaultBranch;
          }
        } catch (err) {
          const detail = err instanceof GithubApiError ? err.message : "GitHub lookup failed";
          ctx.log.error({ err, owner, repo, ref: body.ref }, "install-github could not resolve a commit");
          return reply.code(502).send({ error: detail });
        }

        let archive: Buffer;
        try {
          archive = await fetchArchive({
            owner,
            repo,
            ref: commit,
            ...(ctx.config.githubToken ? { token: ctx.config.githubToken } : {}),
            apiUrl: ctx.config.githubApiUrl,
          });
        } catch (err) {
          const detail =
            err instanceof RepoArchiveError ? err.message : "repository archive fetch failed";
          ctx.log.error({ err, owner, repo, commit }, "install-github could not fetch the archive");
          return reply.code(502).send({ error: detail });
        }

        // Where the extension lives is a question about the tree, not about the
        // operator. Ambiguity is reported so they can answer it with `path`
        // rather than having one guessed for them.
        let subPath = body.path;
        if (subPath === undefined) {
          let found: string[];
          try {
            found = findExtensionDirs(archive);
          } catch (err) {
            return reply
              .code(422)
              .send({ error: err instanceof RepoArchiveError ? err.message : "unreadable archive" });
          }
          if (found.length === 0) {
            return reply.code(422).send({
              error: `no manifest.json found in ${owner}/${repo} at ${commit.slice(0, 7)}; pass \`path\` if the extension lives somewhere unusual`,
            });
          }
          if (found.length > 1) {
            return reply.code(422).send({
              error: `${owner}/${repo} contains ${found.length} extensions; pass \`path\` to choose one`,
              candidates: found.slice(0, 50),
            });
          }
          subPath = found[0]!;
        }

        // A conventional `src/<name>` directory must agree with the manifest, as
        // it does for the webhook. An explicit unconventional path cannot: the
        // manifest is then the only authority on the name.
        const conventional = /^src\/([a-z0-9_]+)$/.exec(subPath);
        const outcome = await publishExtensionFromArchive(
          archive,
          conventional?.[1] ?? subPath.split("/").pop() ?? subPath,
          commit,
          ctx,
          attribution(actor(req), "sysops-install-github", ref),
          { subPath, requireName: conventional !== null },
        );
        return reply.code(statusFor(outcome)).send({
          ...outcome,
          repo: `${owner}/${repo}`,
          ref,
          commit,
          ...(await liveness(outcome)),
        });
      },
    );

    /**
     * Install from a zip the operator drops in the browser.
     *
     * This is the "it is on my laptop and not in git yet" path, and it accepts
     * both shapes an operator will actually produce: a built extension
     * (manifest.json + index.mjs) or the source directory (manifest.json +
     * index.ts / src/), which is built here with the same esbuild invocation the
     * webhook uses. A folder zipped from a file manager wraps everything in one
     * directory; that is unwrapped rather than rejected.
     */
    scope.post(
      "/api/v1/admin/sysops/extensions/install-upload",
      { bodyLimit: MAX_BUNDLE_BYTES, preHandler: requireScope("bundles:write") },
      async (req, reply) => {
        if (!Buffer.isBuffer(req.body)) {
          return reply
            .code(400)
            .send({ error: "zip body required (content-type application/zip)" });
        }
        const workDir = mkdtempSync(join(tmpdir(), "publoader-upload-"));
        try {
          try {
            extractUploadedTree(req.body, workDir);
          } catch (err) {
            return reply
              .code(422)
              .send({ error: err instanceof RepoArchiveError ? err.message : "unreadable zip" });
          }
          const root = findManifestRoot(workDir);
          if (root === null) {
            return reply.code(422).send({
              error:
                "no manifest.json in the uploaded zip. Zip the extension directory (or its " +
                "contents): manifest.json plus either a built index.mjs or the TypeScript source.",
            });
          }
          const outcome = await publishExtensionDirectory(
            root,
            ctx,
            attribution(actor(req), "sysops-install-upload"),
            { expectedName: null, origin: "the uploaded zip" },
          );
          return reply.code(statusFor(outcome)).send({
            ...outcome,
            source: "upload",
            ...(await liveness(outcome)),
          });
        } finally {
          rmSync(workDir, { recursive: true, force: true });
        }
      },
    );

    // ---- 4. read the docs ----

    /**
     * The documents shipped with this build.
     *
     * `stats:read` is the floor: this is the operator handbook, not data. It is
     * still behind admin auth because the deployment notes name hosts, paths and
     * the shape of the credential layout.
     */
    scope.get("/api/v1/admin/docs", { preHandler: requireScope("stats:read") }, async () => {
      // An EMPTY directory is the same answer as a missing one, and it is the
      // shape a build produces when `COPY docs ./docs` was dropped or pointed at
      // the wrong context. Reporting `documents: []` with `available: true` would
      // read as "this project has no documentation", which is a different and
      // untrue statement.
      const documents = docsDir === null ? [] : listDocs(docsDir);
      if (documents.length === 0) {
        return {
          available: false,
          reason:
            "no documentation was shipped with this build. The core image copies the repository's " +
            "docs/ directory to /app/docs (see docker/core/Dockerfile); DOCS_PATH overrides where " +
            "the API looks.",
          documents: [],
        };
      }
      return { available: true, documents };
    });

    /**
     * One document's markdown.
     *
     * `:name` is validated against an allowlist derived from the shipped
     * directory (see core/sysops/docsStore.ts). Every rejection is the same 404:
     * distinguishing "malformed name" from "no such document" would confirm
     * which files exist to whoever is probing the endpoint.
     */
    scope.get(
      "/api/v1/admin/docs/:name",
      { preHandler: requireScope("stats:read") },
      async (req, reply) => {
        if (docsDir === null) {
          return reply.code(404).send({ error: "no documentation was shipped with this build" });
        }
        const { name } = req.params as { name: string };
        const doc = readDoc(docsDir, name);
        if (!doc) return reply.code(404).send({ error: "unknown document" });
        return doc;
      },
    );

    // ---- helpers that need ctx ----

    /**
     * Did this bundle become the one the scheduler will pin?
     *
     * "Is it live?" is the operator's next question after every publish, and the
     * answer is not always yes: publishing an older version number leaves the
     * newer one as `latest`, and a yanked-then-republished bundle behaves
     * differently again. Answering it here beats making them cross-check the
     * Extensions tab.
     */
    async function liveness(
      outcome: PublishOutcome,
    ): Promise<{ isLatest?: boolean; latest?: { version: string; sha256: string } }> {
      if (outcome.status !== "published" && outcome.status !== "unchanged") return {};
      const latest = await ctx.bundles.latest(outcome.extension);
      if (!latest) return { isLatest: false };
      return {
        isLatest: latest.sha256 === outcome.sha256,
        latest: { version: latest.version, sha256: latest.sha256 },
      };
    }

    /** See ExtensionStatus. Shared by the status route and the sync route. */
    async function collectGithubStatus(): Promise<GithubStatus> {
      const repos = parseRepoList(ctx.config.githubExtensionsRepos);
      const authenticated = Boolean(ctx.config.githubToken);
      const bundles = await ctx.bundles.listLatest();

      if (repos.length === 0) {
        return {
          available: false,
          reason:
            "GITHUB_EXTENSIONS_REPOS is not set, so there is no repository to compare against.",
          authenticated,
          repos: [],
          extensions: [],
          truncated: false,
        };
      }

      const cfg = githubConfig();
      let calls = 0;
      const heads = new Map<string, string>();
      const repoStatuses: RepoStatus[] = [];
      for (const repo of repos) {
        if (calls >= MAX_GITHUB_CALLS) {
          repoStatuses.push({ repo, error: "GitHub call budget exhausted" });
          continue;
        }
        calls += 1;
        try {
          const head = await github.head(cfg, repo);
          heads.set(repo, head.sha);
          repoStatuses.push({ repo, defaultBranch: head.defaultBranch, sha: head.sha });
        } catch (err) {
          const message = err instanceof GithubApiError ? err.message : "GitHub lookup failed";
          ctx.log.warn({ err, repo }, "sysops could not resolve repository HEAD");
          repoStatuses.push({ repo, error: message });
        }
      }

      if (heads.size === 0) {
        return {
          available: false,
          reason:
            repoStatuses.find((r) => r.error)?.error ??
            "none of the configured repositories could be reached",
          authenticated,
          repos: repoStatuses,
          extensions: [],
          truncated: false,
        };
      }

      let truncated = false;
      const extensions: ExtensionStatus[] = [];
      for (const bundle of bundles) {
        const base: ExtensionStatus = {
          extension: bundle.extension,
          publishedVersion: bundle.version,
          publishedCommit: bundle.sourceCommit,
          repo: null,
          latestCommit: null,
          behind: null,
        };
        if (!bundle.sourceCommit) {
          extensions.push({
            ...base,
            reason:
              "this bundle records no source commit (published from a local directory), so there " +
              "is nothing to compare; publish it from GitHub once to establish provenance",
          });
          continue;
        }

        // Cheapest case first, and the common one: the published commit IS the
        // head of one of the repos, so nothing needs comparing.
        const atHead = [...heads.entries()].find(([, sha]) => sha === bundle.sourceCommit);
        if (atHead) {
          extensions.push({
            ...base,
            repo: atHead[0],
            latestCommit: atHead[1],
            behind: false,
          });
          continue;
        }

        // Which repo a bundle came from is not recorded anywhere, so the compare
        // does double duty: a 404 means "that commit is not in this repo", which
        // identifies the repo as a side effect of asking the real question.
        let resolved: ExtensionStatus | null = null;
        let lastError: string | null = null;
        for (const [repo, headSha] of heads) {
          if (calls >= MAX_GITHUB_CALLS) {
            truncated = true;
            break;
          }
          calls += 1;
          let comparison;
          try {
            comparison = await github.compare(cfg, repo, bundle.sourceCommit, headSha);
          } catch (err) {
            lastError = err instanceof GithubApiError ? err.message : "GitHub compare failed";
            ctx.log.warn({ err, repo, extension: bundle.extension }, "sysops compare failed");
            continue;
          }
          if (comparison === null) continue; // not this repo
          const prefix = `src/${bundle.extension}/`;
          const changedPaths = comparison.paths.filter((p) => p.startsWith(prefix));
          resolved = {
            ...base,
            repo,
            latestCommit: headSha,
            behind: true,
            changedPaths,
            ...(comparison.pathsTruncated ? { pathsTruncated: true } : {}),
            ...(comparison.pathsTruncated
              ? {
                  reason:
                    "GitHub truncated the changed-file list at 300 entries, so changedPaths is incomplete",
                }
              : changedPaths.length === 0
                ? {
                    reason:
                      "the repository moved on but nothing under this extension's directory " +
                      "changed; syncing would republish identical bytes",
                  }
                : {}),
          };
          break;
        }
        extensions.push(
          resolved ?? {
            ...base,
            reason:
              lastError ??
              (truncated
                ? "GitHub call budget exhausted before this extension was checked"
                : `commit ${bundle.sourceCommit.slice(0, 7)} was not found in any configured repository (force-pushed away, or published from a repo that is not configured)`),
          },
        );
      }

      return { available: true, authenticated, repos: repoStatuses, extensions, truncated };
    }
  });
}

/** A sync outcome is a publish outcome plus where it came from. */
interface SyncOutcome extends Omit<PublishOutcome, "status"> {
  status: PublishOutcome["status"] | "current" | "would-publish";
  repo?: string;
  commit?: string;
  changedPaths?: string[];
  isLatest?: boolean;
  latest?: { version: string; sha256: string };
}

function attribution(actor: string, via: string, ref?: string): PublishAttribution {
  return { actor, via, ...(ref ? { ref } : {}) };
}

/** Which processes a target asks to exit, excluding the API's own self-exit. */
function servicesFor(target: RestartTarget): string[] {
  if (target === "all") return ["scheduler", "processor", "uploader"];
  if (target === "api") return [];
  return [target];
}

/**
 * HTTP status for a single-extension install. 422 for a rejected bundle (the
 * body carries the reason), 200 for a republish of identical bytes, 201 for a
 * new one — matching POST /api/v1/admin/bundles so a client can treat them alike.
 */
function statusFor(outcome: PublishOutcome): number {
  if (outcome.status === "failed") return 422;
  if (outcome.status === "skipped") return 422;
  return outcome.status === "published" ? 201 : 200;
}
