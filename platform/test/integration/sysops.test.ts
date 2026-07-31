import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import AdmZip from "adm-zip";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import { buildContext, type AppContext } from "../../src/core/api/context.js";
import { MAX_UPLOAD_BYTES, registerSysopsRoutes } from "../../src/core/api/routes/sysops.js";
import type { RepoArchiveFetcher } from "../../src/core/webhooks/repoArchive.js";
import {
  GithubApiError,
  type CommitComparison,
  type GithubMetaClient,
} from "../../src/core/webhooks/repoMeta.js";
import {
  honourRestartRequest,
  parseRestartRequest,
  restartAckKey,
  RESTART_REQUEST_KEY,
  RESTART_REQUEST_TTL_MS,
} from "../../src/core/sysops/restartSignal.js";
import { closeDb, dbReady, resetDb, testPrisma } from "./db.js";

/**
 * Operator self-service: fetch from GitHub, restart, install an extension, read
 * the docs.
 *
 * Three properties matter more than the happy paths, and each has its own group
 * below. (1) The GitHub check must never report "current" when it does not know —
 * an unreachable API, a missing token and a bundle with no recorded commit are
 * each their own answer. (2) The restart endpoint must write its row and its
 * audit entry and NOT actually exit anything here, so `selfExit` is injected.
 * (3) The docs endpoint serves files from disk to the internet, so traversal is
 * tested directly, in the encodings a router hands through.
 *
 * `registerSysopsRoutes` is called on the server built by buildServer, which is
 * exactly the one line server.ts needs; asserting the routes exist afterwards
 * means a dropped registration fails once, loudly.
 */

const ADMIN = "test-admin-token-0123456789";
const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OLD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PRIVATE_HEAD = "cccccccccccccccccccccccccccccccccccccccc";
const ARCHIVE_ROOT = "publoader-publoader-extensions-aaaaaaa";

const manifest = (name: string, version = "1.0.0"): Record<string, unknown> => ({
  name,
  version,
  publoader_api: "^2.0.0",
  runtime: "node",
  entrypoint: "index.mjs",
  mangadex_group_id: "4f1de6a2-f0c5-4ac5-bce5-02c7dbb67deb",
  languages: ["en"],
  allowed_hosts: ["example.com"],
});

const FACTORY = "export default () => ({ async collect() { return { chapters: [] }; } });\n";

/** A GitHub-shaped zipball: everything under one `owner-repo-sha/` wrapper. */
function repoArchive(
  extensions: { name: string; version?: string; broken?: boolean; path?: string }[],
): Buffer {
  const zip = new AdmZip();
  zip.addFile(`${ARCHIVE_ROOT}/README.md`, Buffer.from("# extensions\n"));
  for (const entry of extensions) {
    const dir = entry.path ?? `src/${entry.name}`;
    zip.addFile(
      `${ARCHIVE_ROOT}/${dir}/manifest.json`,
      Buffer.from(entry.broken ? "{ not json" : JSON.stringify(manifest(entry.name, entry.version))),
    );
    zip.addFile(`${ARCHIVE_ROOT}/${dir}/index.mjs`, Buffer.from(FACTORY));
  }
  return zip.toBuffer();
}

/** An operator-supplied zip. `prefix` simulates zipping the folder itself. */
function uploadZip(files: Record<string, string>, prefix = ""): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(`${prefix}${name}`, Buffer.from(content));
  }
  return zip.toBuffer();
}

/** Where a successful zip-slip would land. Asserted absent, never created. */
const SLIP_TARGET = join(tmpdir(), "publoader-zip-slip.txt");

/**
 * A zip whose entry name escapes the extraction root.
 *
 * It has to be crafted rather than built: adm-zip SANITISES `../` out of entry
 * names when it writes an archive, so `zip.addFile("../evil")` produces a
 * harmless `evil` and would test nothing. A real attacker writes the central
 * directory themselves, so the name is patched into the finished bytes — the
 * placeholder is the same length as the replacement, which keeps every offset in
 * the archive valid.
 */
function slipZip(): Buffer {
  const placeholder = "xx/xx/publoader-zip-slip.txt";
  const escape = "../../publoader-zip-slip.txt";
  const zip = new AdmZip();
  zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest("evil"))));
  zip.addFile("index.mjs", Buffer.from(FACTORY));
  zip.addFile(placeholder, Buffer.from("owned\n"));
  // latin1 round-trips every byte value unchanged, so this is a byte edit.
  return Buffer.from(zip.toBuffer().toString("latin1").split(placeholder).join(escape), "latin1");
}

interface GithubStub extends GithubMetaClient {
  calls: string[];
}

/**
 * A GitHub metadata client that answers from a table. `heads` maps repo → sha;
 * `comparisons` maps `repo:base` → comparison, where a missing entry is the 404
 * that means "that commit is not in this repo".
 */
function githubStub(options: {
  heads?: Record<string, string>;
  comparisons?: Record<string, CommitComparison>;
  refs?: Record<string, string>;
  headError?: Error;
  compareError?: Error;
}): GithubStub {
  const calls: string[] = [];
  return {
    calls,
    async head(_cfg, repo) {
      calls.push(`head:${repo}`);
      if (options.headError) throw options.headError;
      const sha = options.heads?.[repo];
      if (!sha) throw new GithubApiError(`GitHub lookup of ${repo} failed with HTTP 404`, 404);
      return { repo, defaultBranch: "main", sha };
    },
    async compare(_cfg, repo, base, _head) {
      calls.push(`compare:${repo}:${base.slice(0, 7)}`);
      if (options.compareError) throw options.compareError;
      return options.comparisons?.[`${repo}:${base}`] ?? null;
    },
    async resolveRef(_cfg, repo, ref) {
      calls.push(`ref:${repo}:${ref}`);
      const sha = options.refs?.[`${repo}:${ref}`];
      if (!sha) throw new GithubApiError(`${repo} has no ref '${ref}'`, 404);
      return sha;
    },
  };
}

describe.skipIf(!dbReady())("operator self-service endpoints", () => {
  const prisma = testPrisma();
  const baseEnv = {
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    ADMIN_TOKEN: ADMIN,
    LOG_LEVEL: "error",
    GITHUB_REPO_OWNER: "publoader",
    GITHUB_EXTENSIONS_REPOS: "publoader-extensions,publoader-extensions-private",
    GITHUB_TOKEN: "ghp_testtoken",
  };
  const log = createLogger("test-sysops", "silent");
  const root = { authorization: `Bearer ${ADMIN}` };

  let app: FastifyInstance;
  let ctx: AppContext;
  let github: GithubStub;
  let archive: Buffer;
  let fetchCalls: { owner: string; repo: string; ref: string }[];
  let archiveError: Error | null;
  let exits: string[];
  let docsDir: string;

  /**
   * A scratch server carrying only these routes.
   *
   * buildServer already registers them (see server.ts), but with the real GitHub
   * client and the real archive download — registering them there a second time
   * would collide, and calling out to api.github.com from a test suite is not an
   * option. So the request pipeline is reproduced here exactly as buildServer
   * builds it: the empty-body-tolerant JSON parser, the raw parser for
   * application/zip, and the error handler that turns a `statusCode`-tagged
   * throw into a 400 rather than a 500.
   */
  async function boot(
    env: Record<string, string> = {},
    stubs: { github?: GithubStub; docsDir?: string } = {},
  ): Promise<void> {
    if (app) await app.close();
    const config = loadConfig({ ...baseEnv, ...env });
    ctx = buildContext(prisma, config, log);
    const fetchArchive: RepoArchiveFetcher = async (req) => {
      fetchCalls.push({ owner: req.owner, repo: req.repo, ref: req.ref });
      if (archiveError) throw archiveError;
      return archive;
    };

    app = Fastify({ bodyLimit: 1024 * 1024 }) as unknown as FastifyInstance;
    app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
      const text = typeof body === "string" ? body.trim() : "";
      if (text.length === 0) return done(null, {});
      try {
        done(null, JSON.parse(text));
      } catch (err) {
        const failure = err as Error & { statusCode?: number };
        failure.statusCode = 400;
        done(failure, undefined);
      }
    });
    app.addContentTypeParser("application/zip", { parseAs: "buffer" }, (_req, body, done) =>
      done(null, body),
    );
    app.setErrorHandler((err: FastifyError, _req, reply) => {
      const status = typeof err.statusCode === "number" ? err.statusCode : 500;
      reply.code(status).send({ error: status >= 500 ? "internal error" : err.message });
    });

    // THE wiring line server.ts needs, with every outbound call stubbed.
    registerSysopsRoutes(app, ctx, {
      github: stubs.github ?? github,
      fetchArchive,
      selfExit: (target) => exits.push(target),
      docsDir: stubs.docsDir ?? docsDir,
    });
    await app.ready();
  }

  beforeEach(async () => {
    await resetDb(prisma);
    await prisma.apiToken.deleteMany({});
    fetchCalls = [];
    archiveError = null;
    exits = [];
    archive = repoArchive([{ name: "mangaplus" }]);
    github = githubStub({
      heads: { "publoader-extensions": HEAD, "publoader-extensions-private": PRIVATE_HEAD },
    });
    // A real directory, so listDocs/readDoc do real filesystem work.
    docsDir = mkdtempSync(join(tmpdir(), "publoader-docs-"));
    writeFileSync(
      join(docsDir, "operations.md"),
      "# Operations\n\nRun `docker compose ps`. See [deployment](deployment.md).\n",
    );
    writeFileSync(join(docsDir, "deployment.md"), "# Deployment\n\n## Upgrades\n\nRoll forward.\n");
    // Neither of these may ever be served: no `.md`, and a dotfile.
    writeFileSync(join(docsDir, "secret.env"), "ADMIN_TOKEN=hunter2\n");
    writeFileSync(join(docsDir, ".hidden.md"), "# hidden\n");
    await boot();
    expect(app.hasRoute({ method: "GET", url: "/api/v1/admin/sysops/github/status" })).toBe(true);
    expect(app.hasRoute({ method: "GET", url: "/api/v1/admin/docs/:name" })).toBe(true);
  });

  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  /**
   * A scoped `pa_…` credential carrying exactly `scopes`. Minted through the
   * store rather than through POST /admin/tokens, because that route lives on the
   * full server and this suite runs a scratch one.
   */
  async function mint(scopes: string[]): Promise<Record<string, string>> {
    const { token } = await ctx.apiTokens.mint({
      name: `sysops-${scopes.join("-")}-${Math.random().toString(36).slice(2, 7)}`,
      scopes,
      createdBy: "test",
    });
    return { authorization: `Bearer ${token}` };
  }

  /** Publish a bundle the way the CLI would, so `latest` and `sourceCommit` exist. */
  async function seedBundle(
    name: string,
    opts: { commit?: string | null; version?: string } = {},
  ): Promise<void> {
    const zip = new AdmZip();
    zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest(name, opts.version ?? "1.0.0"))));
    zip.addFile("index.mjs", Buffer.from(FACTORY));
    await ctx.bundles.publish({
      zipData: zip.toBuffer(),
      manifest: manifest(name, opts.version ?? "1.0.0"),
      ...(opts.commit === null ? {} : { sourceCommit: opts.commit ?? OLD }),
    });
  }

  const auditFor = (action: string) =>
    prisma.auditEvent.findMany({ where: { action }, orderBy: { createdAt: "asc" } });

  // ------------------------------------------------------------- github status

  describe("GET /sysops/github/status", () => {
    it("reports a bundle whose commit is the repo HEAD as current", async () => {
      await seedBundle("mangaplus", { commit: HEAD });
      const res = await app.inject({ url: "/api/v1/admin/sysops/github/status", headers: root });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.available).toBe(true);
      expect(body.authenticated).toBe(true);
      expect(body.extensions).toHaveLength(1);
      expect(body.extensions[0]).toMatchObject({
        extension: "mangaplus",
        publishedCommit: HEAD,
        latestCommit: HEAD,
        repo: "publoader-extensions",
        behind: false,
      });
      // No compare is needed when the published commit IS the head.
      expect(github.calls.filter((c) => c.startsWith("compare:"))).toEqual([]);
    });

    it("reports a behind extension with the paths that changed under its directory", async () => {
      await seedBundle("mangaplus", { commit: OLD });
      github = githubStub({
        heads: { "publoader-extensions": HEAD, "publoader-extensions-private": PRIVATE_HEAD },
        comparisons: {
          [`publoader-extensions:${OLD}`]: {
            aheadBy: 3,
            paths: ["src/mangaplus/index.ts", "src/other/index.ts", "README.md"],
            pathsTruncated: false,
          },
        },
      });
      await boot();
      const body = (
        await app.inject({ url: "/api/v1/admin/sysops/github/status", headers: root })
      ).json();
      expect(body.extensions[0]).toMatchObject({
        extension: "mangaplus",
        behind: true,
        repo: "publoader-extensions",
        latestCommit: HEAD,
        changedPaths: ["src/mangaplus/index.ts"],
      });
    });

    it("says so when the repository moved but this extension did not", async () => {
      await seedBundle("mangaplus", { commit: OLD });
      github = githubStub({
        heads: { "publoader-extensions": HEAD },
        comparisons: {
          [`publoader-extensions:${OLD}`]: { aheadBy: 1, paths: ["README.md"], pathsTruncated: false },
        },
      });
      await boot({ GITHUB_EXTENSIONS_REPOS: "publoader-extensions" });
      const body = (
        await app.inject({ url: "/api/v1/admin/sysops/github/status", headers: root })
      ).json();
      expect(body.extensions[0].behind).toBe(true);
      expect(body.extensions[0].changedPaths).toEqual([]);
      expect(body.extensions[0].reason).toMatch(/republish identical bytes/);
    });

    it("cannot tell for a bundle published without a source commit, and says which", async () => {
      await seedBundle("localonly", { commit: null });
      const body = (
        await app.inject({ url: "/api/v1/admin/sysops/github/status", headers: root })
      ).json();
      expect(body.available).toBe(true);
      // Null, never false: "unknown" and "up to date" must not look alike.
      expect(body.extensions[0].behind).toBeNull();
      expect(body.extensions[0].reason).toMatch(/no source commit/);
    });

    it("cannot tell when the published commit is in none of the configured repos", async () => {
      await seedBundle("mangaplus", { commit: OLD });
      const body = (
        await app.inject({ url: "/api/v1/admin/sysops/github/status", headers: root })
      ).json();
      expect(body.extensions[0].behind).toBeNull();
      expect(body.extensions[0].reason).toMatch(/was not found in any configured repository/);
      // Both repos were asked before giving up.
      expect(github.calls.filter((c) => c.startsWith("compare:"))).toHaveLength(2);
    });

    it("degrades honestly when no extensions repos are configured", async () => {
      await boot({ GITHUB_EXTENSIONS_REPOS: "" });
      await seedBundle("mangaplus", { commit: HEAD });
      const body = (
        await app.inject({ url: "/api/v1/admin/sysops/github/status", headers: root })
      ).json();
      expect(body.available).toBe(false);
      expect(body.reason).toMatch(/GITHUB_EXTENSIONS_REPOS is not set/);
      expect(body.extensions).toEqual([]);
    });

    it("degrades honestly when GitHub is unreachable", async () => {
      github = githubStub({ headError: new GithubApiError("GitHub API rate limit reached", 403) });
      await boot();
      await seedBundle("mangaplus", { commit: HEAD });
      const body = (
        await app.inject({ url: "/api/v1/admin/sysops/github/status", headers: root })
      ).json();
      expect(body.available).toBe(false);
      expect(body.reason).toMatch(/rate limit/);
      expect(body.repos.every((repo: { error?: string }) => repo.error)).toBe(true);
    });

    it("reports the absence of a token, because it changes the rate limit", async () => {
      await boot({ GITHUB_TOKEN: "" });
      const body = (
        await app.inject({ url: "/api/v1/admin/sysops/github/status", headers: root })
      ).json();
      expect(body.authenticated).toBe(false);
    });

    it("needs bundles:read", async () => {
      const headers = await mint(["stats:read"]);
      const res = await app.inject({ url: "/api/v1/admin/sysops/github/status", headers });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("missing scope: bundles:read");
    });
  });

  // --------------------------------------------------------------- github sync

  describe("POST /sysops/github/sync", () => {
    const behindStub = () =>
      githubStub({
        heads: { "publoader-extensions": HEAD },
        comparisons: {
          [`publoader-extensions:${OLD}`]: {
            aheadBy: 1,
            paths: ["src/mangaplus/index.mjs"],
            pathsTruncated: false,
          },
        },
      });

    beforeEach(async () => {
      github = behindStub();
      await boot({ GITHUB_EXTENSIONS_REPOS: "publoader-extensions" });
      await seedBundle("mangaplus", { commit: OLD });
    });

    it("publishes a behind extension, records provenance, and says it is live", async () => {
      archive = repoArchive([{ name: "mangaplus", version: "2.0.0" }]);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/sysops/github/sync",
        headers: root,
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.outcomes).toHaveLength(1);
      expect(body.outcomes[0]).toMatchObject({
        extension: "mangaplus",
        status: "published",
        version: "2.0.0",
        repo: "publoader-extensions",
        commit: HEAD,
        // The operator's next question, answered without a second request.
        isLatest: true,
      });

      const bundle = await prisma.bundle.findFirst({
        where: { extension: "mangaplus", version: "2.0.0" },
      });
      expect(bundle?.sourceCommit).toBe(HEAD);
      expect(fetchCalls).toEqual([{ owner: "publoader", repo: "publoader-extensions", ref: HEAD }]);

      // The seed went through the store, which does not audit; this is the
      // publish the route made.
      const audit = await auditFor("bundle.publish");
      expect(audit).toHaveLength(1);
      expect(audit[0]?.actor).toBe("admin:root");
      expect(audit[0]?.detail).toMatchObject({ via: "sysops-github-sync", sourceCommit: HEAD });
    });

    it("dry-runs without publishing or downloading", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/sysops/github/sync",
        headers: root,
        payload: { dryRun: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().dryRun).toBe(true);
      expect(res.json().outcomes[0]).toMatchObject({
        extension: "mangaplus",
        status: "would-publish",
        commit: HEAD,
      });
      expect(fetchCalls).toEqual([]);
      expect(await prisma.bundle.count()).toBe(1);
    });

    it("reports a current extension as current instead of republishing it", async () => {
      await prisma.bundle.updateMany({ where: { extension: "mangaplus" }, data: { sourceCommit: HEAD } });
      const body = (
        await app.inject({
          method: "POST",
          url: "/api/v1/admin/sysops/github/sync",
          headers: root,
          payload: {},
        })
      ).json();
      expect(body.outcomes[0]).toMatchObject({ extension: "mangaplus", status: "current" });
      expect(fetchCalls).toEqual([]);
    });

    it("lets one extension fail without taking the others down", async () => {
      await seedBundle("viz", { commit: OLD });
      github = githubStub({
        heads: { "publoader-extensions": HEAD },
        comparisons: {
          [`publoader-extensions:${OLD}`]: {
            aheadBy: 2,
            paths: ["src/mangaplus/index.mjs", "src/viz/index.mjs"],
            pathsTruncated: false,
          },
        },
      });
      await boot({ GITHUB_EXTENSIONS_REPOS: "publoader-extensions" });
      archive = repoArchive([
        { name: "mangaplus", version: "2.0.0" },
        { name: "viz", broken: true },
      ]);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/sysops/github/sync",
        headers: root,
        payload: {},
      });
      // 207: something needs attention, and what did work is not hidden by it.
      expect(res.statusCode).toBe(207);
      const outcomes: { extension: string; status: string }[] = res.json().outcomes;
      expect(outcomes.find((o) => o.extension === "mangaplus")?.status).toBe("published");
      expect(outcomes.find((o) => o.extension === "viz")?.status).toBe("failed");
      // Downloaded once for both, not once per extension.
      expect(fetchCalls).toHaveLength(1);
    });

    it("only syncs the extensions asked for, and explains an unknown name", async () => {
      await seedBundle("viz", { commit: OLD });
      const body = (
        await app.inject({
          method: "POST",
          url: "/api/v1/admin/sysops/github/sync",
          headers: root,
          payload: { dryRun: true, extensions: ["mangaplus", "nope"] },
        })
      ).json();
      const byName = new Map<string, { status: string; detail?: string }>(
        body.outcomes.map((o: { extension: string; status: string; detail?: string }) => [o.extension, o]),
      );
      expect(byName.get("mangaplus")?.status).toBe("would-publish");
      expect(byName.get("nope")?.status).toBe("skipped");
      expect(byName.get("nope")?.detail).toMatch(/no published bundle/);
      expect(byName.has("viz")).toBe(false);
    });

    it("refuses rather than pretending when GitHub is unavailable", async () => {
      github = githubStub({ headError: new GithubApiError("GitHub is down", 500) });
      await boot({ GITHUB_EXTENSIONS_REPOS: "publoader-extensions" });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/sysops/github/sync",
        headers: root,
        payload: {},
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toMatch(/GitHub is down/);
      expect(fetchCalls).toEqual([]);
    });

    it("needs bundles:write", async () => {
      const headers = await mint(["bundles:read"]);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/sysops/github/sync",
        headers,
        payload: {},
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("missing scope: bundles:write");
    });
  });

  // ---------------------------------------------------------------- restarting

  describe("POST /sysops/restart", () => {
    it("answers 202 and exits itself for the api target", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/sysops/restart",
        headers: root,
        payload: { target: "api" },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ ok: true, target: "api", exitingNow: ["api"], polling: [] });
      expect(res.json().note).toMatch(/restart policy/);

      // No Setting row: the API does not need to poll for its own restart.
      expect(await ctx.settings.getSetting(RESTART_REQUEST_KEY)).toBeNull();
      const audit = await auditFor("sysops.restart");
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor: "admin:root", subject: "api" });
    });

    it("writes a Setting row the other services poll, without exiting", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/sysops/restart",
        headers: root,
        payload: { target: "scheduler" },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ target: "scheduler", exitingNow: [], polling: ["scheduler"] });

      const request = parseRestartRequest(await ctx.settings.getSetting(RESTART_REQUEST_KEY));
      expect(request).toMatchObject({ target: "scheduler", requestedBy: "admin:root" });
      // The API is not the target, so nothing here exits.
      expect(exits).toEqual([]);
    });

    it("fans out to every service for the all target", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/sysops/restart",
        headers: root,
        payload: { target: "all" },
      });
      expect(res.json()).toMatchObject({
        exitingNow: ["api"],
        polling: ["scheduler", "processor", "uploader"],
      });
      expect(parseRestartRequest(await ctx.settings.getSetting(RESTART_REQUEST_KEY))?.target).toBe("all");
    });

    it("refuses an unknown target", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/sysops/restart",
        headers: root,
        payload: { target: "postgres" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/target must be one of/);
      expect(await ctx.settings.getSetting(RESTART_REQUEST_KEY)).toBeNull();
    });

    it("refuses when the deployment has no restart policy to rely on", async () => {
      await boot({ SYSOPS_RESTART_ENABLED: "false" });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/sysops/restart",
        headers: root,
        payload: { target: "all" },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toMatch(/SYSOPS_RESTART_ENABLED=false/);
      expect(await ctx.settings.getSetting(RESTART_REQUEST_KEY)).toBeNull();
      expect(exits).toEqual([]);
    });

    it("is closed to api tokens however broadly they are scoped", async () => {
      // A wildcard token holds settings:write and is still not OWNER.
      const headers = await mint(["*"]);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/sysops/restart",
        headers,
        payload: { target: "all" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("owner role required");
      expect(await ctx.settings.getSetting(RESTART_REQUEST_KEY)).toBeNull();
    });
  });

  describe("the restart signal the other services poll", () => {
    it("is honoured once per service, so a fast restart cannot loop", async () => {
      await app.inject({
        method: "POST",
        url: "/api/v1/admin/sysops/restart",
        headers: root,
        payload: { target: "all" },
      });

      // First pass after the request: the service exits.
      expect(await honourRestartRequest(ctx.settings, "scheduler")).toMatchObject({ target: "all" });
      // It comes back seconds later and must NOT exit again.
      expect(await honourRestartRequest(ctx.settings, "scheduler")).toBeNull();
      // Its siblings have not acted yet, so they still see it.
      expect(await honourRestartRequest(ctx.settings, "uploader")).not.toBeNull();
      expect(await ctx.settings.getSetting(restartAckKey("scheduler"))).toBeTruthy();
    });

    it("ignores a request older than its TTL, so a stale row cannot restart anything", async () => {
      const stale = new Date(Date.now() - RESTART_REQUEST_TTL_MS - 1_000).toISOString();
      await ctx.settings.setSetting(
        RESTART_REQUEST_KEY,
        JSON.stringify({ target: "all", requestedAt: stale, requestedBy: "user:someone" }),
      );
      expect(await honourRestartRequest(ctx.settings, "processor")).toBeNull();
    });

    it("ignores a request aimed at a different service", async () => {
      await app.inject({
        method: "POST",
        url: "/api/v1/admin/sysops/restart",
        headers: root,
        payload: { target: "uploader" },
      });
      expect(await honourRestartRequest(ctx.settings, "processor")).toBeNull();
      expect(await honourRestartRequest(ctx.settings, "uploader")).not.toBeNull();
    });

    it("ignores an unparseable row rather than throwing in a service loop", async () => {
      await ctx.settings.setSetting(RESTART_REQUEST_KEY, "not json at all");
      expect(await honourRestartRequest(ctx.settings, "scheduler")).toBeNull();
    });
  });

  // ------------------------------------------------------------------ install

  describe("POST /sysops/extensions/install-github", () => {
    it("finds the single extension in a repo, publishes it, and reports it live", async () => {
      github = githubStub({ heads: { "some-fork": HEAD } });
      await boot();
      archive = repoArchive([{ name: "newsource" }]);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/sysops/extensions/install-github",
        headers: root,
        payload: { repo: "someone/some-fork" },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        extension: "newsource",
        version: "1.0.0",
        status: "published",
        repo: "someone/some-fork",
        commit: HEAD,
        ref: "main",
        isLatest: true,
      });
      expect(fetchCalls).toEqual([{ owner: "someone", repo: "some-fork", ref: HEAD }]);
      const bundle = await prisma.bundle.findFirst({ where: { extension: "newsource" } });
      expect(bundle?.sourceCommit).toBe(HEAD);
      expect((await auditFor("bundle.publish"))[0]?.detail).toMatchObject({
        via: "sysops-install-github",
      });
    });

    it("resolves a branch name to a commit so provenance is a real sha", async () => {
      github = githubStub({ heads: { fork: HEAD }, refs: { "fork:wip": OLD } });
      await boot();
      archive = repoArchive([{ name: "newsource" }]);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/sysops/extensions/install-github",
        headers: root,
        payload: { repo: "fork", ref: "wip" },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().commit).toBe(OLD);
      expect(fetchCalls[0]?.ref).toBe(OLD);
      // Bare `repo` uses the configured owner.
      expect(fetchCalls[0]?.owner).toBe("publoader");
    });

    it("refuses to guess when a repo holds several extensions", async () => {
      github = githubStub({ heads: { multi: HEAD } });
      await boot();
      archive = repoArchive([{ name: "one" }, { name: "two" }]);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/sysops/extensions/install-github",
        headers: root,
        payload: { repo: "multi" },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toMatch(/contains 2 extensions; pass `path`/);
      expect(res.json().candidates).toEqual(["src/one", "src/two"]);
      expect(await prisma.bundle.count()).toBe(0);
    });

    it("installs from an explicit unconventional path, taking the name from the manifest", async () => {
      github = githubStub({ heads: { odd: HEAD } });
      await boot();
      archive = repoArchive([{ name: "oddball", path: "extensions/oddball-source" }]);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/sysops/extensions/install-github",
        headers: root,
        payload: { repo: "odd", path: "extensions/oddball-source" },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().extension).toBe("oddball");
    });

    it("rejects a path that tries to escape the repo", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/sysops/extensions/install-github",
        headers: root,
        payload: { repo: "any", path: "../../etc" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/invalid path/);
      expect(fetchCalls).toEqual([]);
    });

    it("reports an unresolvable ref as a GitHub problem, not a build failure", async () => {
      github = githubStub({ heads: { fork: HEAD } });
      await boot();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/sysops/extensions/install-github",
        headers: root,
        payload: { repo: "fork", ref: "no-such-branch" },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toMatch(/has no ref 'no-such-branch'/);
    });

    it("needs bundles:write", async () => {
      const headers = await mint(["bundles:read"]);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/sysops/extensions/install-github",
        headers,
        payload: { repo: "fork" },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("POST /sysops/extensions/install-upload", () => {
    const upload = (body: Buffer, headers: Record<string, string> = root) =>
      app.inject({
        method: "POST",
        url: "/api/v1/admin/sysops/extensions/install-upload",
        headers: { ...headers, "content-type": "application/zip" },
        payload: body,
      });

    it("publishes a prebuilt bundle zipped at the root", async () => {
      const res = await upload(
        uploadZip({ "manifest.json": JSON.stringify(manifest("local")), "index.mjs": FACTORY }),
      );
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        extension: "local",
        version: "1.0.0",
        status: "published",
        source: "upload",
        isLatest: true,
      });
      expect((await auditFor("bundle.publish"))[0]?.detail).toMatchObject({
        via: "sysops-install-upload",
      });
    });

    it("unwraps a zip of the folder itself, which is what a file manager produces", async () => {
      const res = await upload(
        uploadZip(
          { "manifest.json": JSON.stringify(manifest("wrapped")), "index.mjs": FACTORY },
          "wrapped-extension/",
        ),
      );
      expect(res.json()).toMatchObject({ extension: "wrapped", status: "published" });
      expect(res.statusCode).toBe(201);
    });

    it("builds TypeScript source with the same esbuild step the webhook uses", async () => {
      const res = await upload(
        uploadZip({
          "manifest.json": JSON.stringify({ ...manifest("sourced", "3.0.0"), entrypoint: "index.ts" }),
          "index.ts": "import { hi } from './helper.js';\nexport default () => ({ hi });\n",
          "helper.ts": "export const hi = 'hello';\n",
        }),
      );
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ extension: "sourced", version: "3.0.0" });

      // What was stored is a built bundle: one ESM file, no sources.
      const bundle = await prisma.bundle.findFirst({ where: { extension: "sourced" } });
      const entries = new AdmZip(Buffer.from(bundle!.archive)).getEntries().map((e) => e.entryName);
      expect(entries.sort()).toEqual(["index.mjs", "manifest.json"]);
      // The staged manifest points at the built file, not the TypeScript source.
      expect((bundle!.manifest as { entrypoint: string }).entrypoint).toBe("index.mjs");
    });

    it("rejects a python bundle with the porting message", async () => {
      const res = await upload(
        uploadZip({
          "manifest.json": JSON.stringify({
            ...manifest("legacy"),
            publoader_api: "^1.0.0",
            runtime: "python",
            entrypoint: "extension.py",
          }),
          "extension.py": "class Extension: pass\n",
        }),
      );
      expect(res.statusCode).toBe(422);
      // Refused at intake now (a .py file is not an allowed type at all), so the
      // porting message has to be carried by the refusal rather than by
      // BundleStore — an operator with a v1 extension must be told to port it,
      // not told that .py is not in an allowlist.
      expect(res.json().code).toBe("python_bundle");
      expect(res.json().error).toMatch(/extension API v2/);
      expect(await prisma.bundle.count()).toBe(0);
    });

    it("rejects a zip with no manifest, saying what to zip", async () => {
      const res = await upload(uploadZip({ "index.mjs": FACTORY }));
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe("no_manifest");
      expect(res.json().error).toMatch(/no manifest\.json in the archive/);
    });

    it("refuses an entry that would escape the extraction directory", async () => {
      const res = await upload(slipZip());
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toMatch(/escapes the extraction root/);
      expect(existsSync(SLIP_TARGET)).toBe(false);
      expect(await prisma.bundle.count()).toBe(0);
    });

    it("rejects a body that is not a zip", async () => {
      const res = await upload(Buffer.from("this is not a zip file at all"));
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toMatch(/not a readable zip|no manifest/);
    });

    it("says when the uploaded bundle did not become latest", async () => {
      // `latest()` is the most recently PUBLISHED non-yanked bundle, not the
      // highest version. So re-uploading an older zip after a newer publish is
      // the case where "published: yes, live: no" is the honest answer — and the
      // one an operator hits when they drag in yesterday's folder.
      const older = uploadZip({
        "manifest.json": JSON.stringify(manifest("ordered", "1.0.0")),
        "index.mjs": FACTORY,
      });
      expect((await upload(older)).statusCode).toBe(201);
      await seedBundle("ordered", { version: "2.0.0", commit: HEAD });

      const res = await upload(older);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: "unchanged", version: "1.0.0", isLatest: false });
      expect(res.json().latest).toMatchObject({ version: "2.0.0" });
    });

    it("needs bundles:write", async () => {
      const headers = await mint(["bundles:read"]);
      const res = await upload(
        uploadZip({ "manifest.json": JSON.stringify(manifest("nope")), "index.mjs": FACTORY }),
        headers,
      );
      expect(res.statusCode).toBe(403);
    });
  });

  // ------------------------------------------------------- intake at the edge

  /**
   * The route's half of the hardening: what an operator sees when an archive is
   * refused, what lands in the audit log, and the two limits that live on the
   * endpoint rather than in the intake (body size and per-credential rate).
   *
   * The refusal classes themselves are covered exhaustively in
   * test/unit/bundleIntake.test.ts; these are the cases that only exist over
   * HTTP.
   */
  describe("hostile uploads at the edge", () => {
    const upload = (body: Buffer, headers: Record<string, string> = root) =>
      app.inject({
        method: "POST",
        url: "/api/v1/admin/sysops/extensions/install-upload",
        headers: { ...headers, "content-type": "application/zip" },
        payload: body,
      });

    it("refuses an executable disguised as a data file, and audits the refusal", async () => {
      const zip = new AdmZip();
      zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest("hostile"))));
      zip.addFile("index.mjs", Buffer.from(FACTORY));
      zip.addFile(
        "manga_id_map.json",
        Buffer.concat([Buffer.from("7f454c46", "hex"), Buffer.alloc(64)]),
      );
      const body = zip.toBuffer();

      const res = await upload(body);
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe("binary_content");
      expect(res.json().error).toMatch(/ELF/);
      // The stats travel with the refusal so an operator can match it to a file.
      expect(res.json().bytes).toBe(body.length);
      expect(res.json().entries).toBe(3);
      expect(res.json().sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(await prisma.bundle.count()).toBe(0);

      // A refused upload is exactly the event worth finding later.
      const audit = await auditFor("bundle.intake.refused");
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor: "admin:root", subject: "upload" });
      expect(audit[0]?.detail).toMatchObject({
        code: "binary_content",
        bytes: body.length,
        entries: 3,
      });
    });

    it("audits an accepted upload with the same fingerprint", async () => {
      const body = uploadZip({
        "manifest.json": JSON.stringify(manifest("accepted")),
        "index.mjs": FACTORY,
      });
      expect((await upload(body)).statusCode).toBe(201);
      const audit = await auditFor("bundle.intake");
      expect(audit).toHaveLength(1);
      expect(audit[0]?.detail).toMatchObject({
        bytes: body.length,
        entries: 2,
        via: "sysops-install-upload",
        outcome: "published",
      });
    });

    it("refuses a body larger than the upload limit before reading it", async () => {
      const res = await upload(Buffer.alloc(MAX_UPLOAD_BYTES + 1024, 0x50));
      // Fastify answers 413 from the body limit; the intake is never reached.
      expect(res.statusCode).toBe(413);
      expect(await prisma.bundle.count()).toBe(0);
    });

    it("rate-limits publishing per credential, not per address", async () => {
      const zip = uploadZip({
        "manifest.json": JSON.stringify(manifest("ratelimited")),
        "index.mjs": FACTORY,
      });
      const scoped = await mint(["bundles:write"]);
      const codes: number[] = [];
      for (let attempt = 0; attempt < 8; attempt++) {
        codes.push((await upload(zip, scoped)).statusCode);
      }
      // Six bursts, then refused.
      expect(codes.filter((code) => code === 429).length).toBeGreaterThan(0);
      expect(codes.slice(0, 6).every((code) => code !== 429)).toBe(true);
      // A different principal has its own bucket and is unaffected.
      expect((await upload(zip, root)).statusCode).not.toBe(429);
    });

    it("does not spend the publish budget on a dry-run sync", async () => {
      const scoped = await mint(["bundles:write"]);
      for (let attempt = 0; attempt < 8; attempt++) {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/admin/sysops/github/sync",
          headers: scoped,
          payload: { dryRun: true },
        });
        expect(res.statusCode).not.toBe(429);
      }
    });

    it("applies the same intake to a repository archive, per extension", async () => {
      // A repo is no more trustworthy than an upload: the archive is fetched over
      // the network and written by anyone who can push.
      await seedBundle("mangaplus", { commit: OLD });
      github = githubStub({
        heads: { "publoader-extensions": HEAD },
        comparisons: {
          [`publoader-extensions:${OLD}`]: {
            aheadBy: 1,
            paths: ["src/mangaplus/index.mjs"],
            pathsTruncated: false,
          },
        },
      });
      await boot({ GITHUB_EXTENSIONS_REPOS: "publoader-extensions" });
      await seedBundle("mangaplus", { commit: OLD });

      const zip = new AdmZip();
      zip.addFile(
        `${ARCHIVE_ROOT}/src/mangaplus/manifest.json`,
        Buffer.from(JSON.stringify(manifest("mangaplus", "2.0.0"))),
      );
      zip.addFile(`${ARCHIVE_ROOT}/src/mangaplus/index.mjs`, Buffer.from(FACTORY));
      zip.addFile(`${ARCHIVE_ROOT}/src/mangaplus/vendor.so`, Buffer.from("not really a binary"));
      archive = zip.toBuffer();

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/sysops/github/sync",
        headers: root,
        payload: {},
      });
      expect(res.statusCode).toBe(207);
      expect(res.json().outcomes[0]).toMatchObject({ extension: "mangaplus", status: "failed" });
      expect(res.json().outcomes[0].detail).toMatch(/may contain only/);
      // Nothing was published from the refused archive.
      expect(await prisma.bundle.count({ where: { version: "2.0.0" } })).toBe(0);
    });
  });

  // --------------------------------------------------------------------- docs

  describe("GET /docs", () => {
    it("lists the shipped documents with their titles and sizes", async () => {
      const res = await app.inject({ url: "/api/v1/admin/docs", headers: root });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.available).toBe(true);
      expect(body.documents.map((doc: { name: string }) => doc.name)).toEqual([
        "deployment.md",
        "operations.md",
      ]);
      expect(body.documents[1]).toMatchObject({ name: "operations.md", title: "Operations" });
      expect(body.documents[1].bytes).toBeGreaterThan(0);
    });

    it("serves one document's markdown", async () => {
      const res = await app.inject({ url: "/api/v1/admin/docs/operations.md", headers: root });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ name: "operations.md", title: "Operations" });
      expect(res.json().markdown).toContain("docker compose ps");
    });

    it("says the docs were not shipped rather than that there are none", async () => {
      const empty = mkdtempSync(join(tmpdir(), "publoader-nodocs-"));
      await boot({}, { docsDir: empty });
      const res = await app.inject({ url: "/api/v1/admin/docs", headers: root });
      expect(res.statusCode).toBe(200);
      expect(res.json().available).toBe(false);
      expect(res.json().reason).toMatch(/no documentation was shipped/i);
      rmSync(empty, { recursive: true, force: true });
    });

    it("needs stats:read", async () => {
      const headers = await mint(["bundles:write"]);
      expect((await app.inject({ url: "/api/v1/admin/docs", headers })).statusCode).toBe(403);
      expect(
        (await app.inject({ url: "/api/v1/admin/docs/operations.md", headers })).statusCode,
      ).toBe(403);
    });

    it("is unreachable without authentication", async () => {
      expect((await app.inject({ url: "/api/v1/admin/docs" })).statusCode).toBe(401);
      expect((await app.inject({ url: "/api/v1/admin/docs/operations.md" })).statusCode).toBe(401);
    });
  });

  /**
   * Traversal is the primary risk of this endpoint: it is a file reader exposed
   * to the internet. Every one of these must be a 404 with no content, and none
   * may be distinguishable from "no such document" — a different status for a
   * malformed name would confirm which files exist.
   */
  describe("docs traversal", () => {
    const outside = join(tmpdir(), "publoader-outside-docs.md");

    beforeEach(() => {
      writeFileSync(outside, "# outside\n");
      // A nested directory inside the docs dir: a name with a separator must not
      // reach it even though the file is technically under the root.
      mkdirSync(join(docsDir, "nested"), { recursive: true });
      writeFileSync(join(docsDir, "nested", "inner.md"), "# inner\n");
    });

    const attempts = [
      "../../package.json",
      "..%2F..%2Fpackage.json",
      "%2e%2e%2f%2e%2e%2fpackage.json",
      "....//package.json",
      "/etc/passwd",
      "%2Fetc%2Fpasswd",
      "..",
      "%2e%2e",
      "nested/inner.md",
      "nested%2Finner.md",
      "secret.env",
      ".hidden.md",
      "operations.md%00.png",
      "operations.md.bak",
      "OPERATIONS.MD/../secret.env",
      "\\..\\..\\package.json",
      encodeURIComponent(outside),
    ];

    for (const attempt of attempts) {
      it(`refuses ${JSON.stringify(attempt)}`, async () => {
        const res = await app.inject({ url: `/api/v1/admin/docs/${attempt}`, headers: root });
        expect([400, 404]).toContain(res.statusCode);
        const text = res.body;
        expect(text).not.toContain("publoader-platform");
        expect(text).not.toContain("ADMIN_TOKEN");
        expect(text).not.toContain("root:");
        expect(text).not.toContain("# inner");
        expect(text).not.toContain("# outside");
      });
    }

    it("still serves the legitimate names in the same directory", async () => {
      for (const name of ["operations.md", "deployment.md"]) {
        expect((await app.inject({ url: `/api/v1/admin/docs/${name}`, headers: root })).statusCode).toBe(
          200,
        );
      }
    });
  });
});
