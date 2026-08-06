import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createHmac } from "node:crypto";
import AdmZip from "adm-zip";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import { buildContext } from "../../src/core/api/context.js";
import { buildServer } from "../../src/core/api/server.js";
import type { RepoArchiveFetcher } from "../../src/core/webhooks/repoArchive.js";
import { closeDb, dbReady, resetDb, testPrisma } from "./db.js";

/**
 * The webhook end to end: a signed GitHub delivery arrives and a bundle exists
 * afterwards. The archive fetcher is injected, so nothing here touches the
 * network; but everything from the HMAC check to BundleStore.publish is the
 * real code path, including the raw-body content-type parser that has to
 * coexist with the server's global JSON parser.
 */
const SECRET = "webhook-secret-for-tests-0123456789";
const ADMIN = "test-admin-token-0123456789";
const COMMIT = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
const ARCHIVE_ROOT = "publoader-publoader-extensions-1a2b3c4";

const sign = (body: string): string =>
  "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");

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

/** A GitHub-shaped zipball containing plain-ESM extension directories. */
function esmArchive(extensions: string[]): Buffer {
  const zip = new AdmZip();
  zip.addFile(`${ARCHIVE_ROOT}/README.md`, Buffer.from("# extensions\n"));
  for (const name of extensions) {
    zip.addFile(
      `${ARCHIVE_ROOT}/src/${name}/manifest.json`,
      Buffer.from(JSON.stringify(manifest(name))),
    );
    zip.addFile(
      `${ARCHIVE_ROOT}/src/${name}/index.mjs`,
      Buffer.from("export default () => ({ async collect() { return { chapters: [] }; } });\n"),
    );
  }
  return zip.toBuffer();
}

/** The same, but as TypeScript sources so the esbuild path is exercised. */
function tsArchive(name: string): Buffer {
  const zip = new AdmZip();
  zip.addFile(
    `${ARCHIVE_ROOT}/src/${name}/manifest.json`,
    Buffer.from(JSON.stringify({ ...manifest(name, "2.0.0"), entrypoint: "index.ts" })),
  );
  zip.addFile(
    `${ARCHIVE_ROOT}/src/${name}/index.ts`,
    Buffer.from(
      "import { greeting } from './helper.js';\n" +
        "export default () => ({ async collect() { return { chapters: [], note: greeting }; } });\n",
    ),
  );
  zip.addFile(`${ARCHIVE_ROOT}/src/${name}/helper.ts`, Buffer.from("export const greeting = 'hi';\n"));
  return zip.toBuffer();
}

function pushBody(paths: string[], overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ref: "refs/heads/main",
    after: COMMIT,
    repository: {
      name: "publoader-extensions",
      full_name: "publoader/publoader-extensions",
      default_branch: "main",
    },
    commits: [{ added: paths, modified: [], removed: [] }],
    head_commit: { added: paths, modified: [], removed: [] },
    ...overrides,
  });
}

describe.skipIf(!dbReady())("github push webhook", () => {
  const prisma = testPrisma();
  const config = loadConfig({
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    ADMIN_TOKEN: ADMIN,
    LOG_LEVEL: "error",
    GITHUB_WEBHOOK_SECRET: SECRET,
    GITHUB_REPO_OWNER: "publoader",
    GITHUB_EXTENSIONS_REPOS: "publoader-extensions,publoader-extensions-private",
    GITHUB_CORE_REPO: "publoader",
  });
  const log = createLogger("test-webhooks", "silent");
  let app: FastifyInstance;
  let archive: Buffer;
  let fetchCalls: { repo: string; ref: string }[];

  beforeEach(async () => {
    await resetDb(prisma);
    archive = esmArchive(["mangaplus"]);
    fetchCalls = [];
    const fetchArchive: RepoArchiveFetcher = async (req) => {
      fetchCalls.push({ repo: req.repo, ref: req.ref });
      return archive;
    };
    // Mirrors the single registration line server.ts needs, with the fetcher
    // injected so the test never reaches api.github.com.
    // buildServer registers the webhook routes; the fetcher rides on the
    // context so this test never reaches api.github.com.
    const ctx = buildContext(prisma, config, log);
    ctx.webhookFetchArchive = fetchArchive;
    app = buildServer(ctx);
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  const deliver = (
    body: string,
    opts: { event?: string; signature?: string | null; url?: string } = {},
  ) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-github-event": opts.event ?? "push",
    };
    if (opts.signature !== null) headers["x-hub-signature-256"] = opts.signature ?? sign(body);
    return app.inject({ method: "POST", url: opts.url ?? "/webhook", headers, payload: body });
  };

  describe("delivery handling", () => {
    it("answers GitHub's setup ping with a 200 so the delivery log is green", async () => {
      const res = await deliver("{}", { event: "ping" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, pong: true });
    });

    it("rejects an invalid signature with 401", async () => {
      const body = pushBody(["src/mangaplus/index.mjs"]);
      const res = await deliver(body, { signature: sign(body).slice(0, -2) + "ff" });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ ok: false, error: "invalid signature" });
    });

    it("rejects a missing signature with 401", async () => {
      const res = await deliver(pushBody(["src/mangaplus/index.mjs"]), { signature: null });
      expect(res.statusCode).toBe(401);
    });

    it("rejects a signature made with the wrong secret", async () => {
      const body = pushBody(["src/mangaplus/index.mjs"]);
      const forged = "sha256=" + createHmac("sha256", "guessed-secret-value-99").update(body).digest("hex");
      expect((await deliver(body, { signature: forged })).statusCode).toBe(401);
    });

    it("does not publish anything for an unsigned delivery", async () => {
      await deliver(pushBody(["src/mangaplus/index.mjs"]), { signature: null });
      expect(await prisma.bundle.count()).toBe(0);
      expect(fetchCalls).toEqual([]);
    });

    it("rejects an oversized body before parsing or verifying it", async () => {
      // 5 MiB cap, matching the legacy listener. The signature is deliberately
      // valid-shaped: the size check has to come first.
      const body = JSON.stringify({ padding: "x".repeat(6 * 1024 * 1024) });
      const res = await deliver(body);
      expect(res.statusCode).toBe(413);
      expect(await prisma.bundle.count()).toBe(0);
    });

    it("ignores a non-push event and names it", async () => {
      const res = await deliver("{}", { event: "issues" });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ ok: true, ignored: "event 'issues'" });
    });

    it("rejects a malformed json body from an otherwise valid delivery", async () => {
      const res = await deliver("{not json");
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ ok: false, error: "invalid json" });
    });

    it("serves the /api/v1/webhooks/github alias identically", async () => {
      const res = await deliver("{}", { event: "ping", url: "/api/v1/webhooks/github" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, pong: true });
    });
  });

  describe("repo and branch gating", () => {
    it("ignores an untracked repo and says which one", async () => {
      const body = pushBody(["src/mangaplus/index.mjs"], {
        repository: {
          name: "some-other-repo",
          full_name: "publoader/some-other-repo",
          default_branch: "main",
        },
      });
      const res = await deliver(body);
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ ok: true, ignored: "untracked repo 'some-other-repo'" });
      expect(await prisma.bundle.count()).toBe(0);
    });

    it("ignores a fork under a different owner", async () => {
      const body = pushBody(["src/mangaplus/index.mjs"], {
        repository: {
          name: "publoader-extensions",
          full_name: "someone-else/publoader-extensions",
          default_branch: "main",
        },
      });
      const res = await deliver(body);
      expect(res.json()).toEqual({ ok: true, ignored: "owner mismatch" });
      expect(await prisma.bundle.count()).toBe(0);
    });

    it("ignores a push to a non-default branch", async () => {
      const res = await deliver(pushBody(["src/mangaplus/index.mjs"], { ref: "refs/heads/wip" }));
      expect(res.json()).toEqual({ ok: true, ignored: "ignored ref refs/heads/wip" });
      expect(await prisma.bundle.count()).toBe(0);
    });

    it("acknowledges a core-repo push and points at the image-based deploy path", async () => {
      const body = pushBody(["src/services/api.ts"], {
        repository: { name: "publoader", full_name: "publoader/publoader", default_branch: "main" },
      });
      const res = await deliver(body);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, acknowledged: true, action: "none" });
      expect(res.json().reason).toMatch(/image-based/);
      expect(res.json().reason).toMatch(/docs\/deployment\.md/);
      expect(fetchCalls).toEqual([]);
    });

    it("does nothing for a push that touched no extension directory", async () => {
      const res = await deliver(pushBody(["README.md", "schedule.json"]));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ignored: "no paths under src/<extension>/ changed" });
      expect(fetchCalls).toEqual([]);
    });
  });

  describe("publishing", () => {
    it("publishes a bundle for the changed extension", async () => {
      const res = await deliver(pushBody(["src/mangaplus/index.mjs"]));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        ok: true,
        commit: COMMIT,
        outcomes: [{ extension: "mangaplus", status: "published", version: "1.0.0" }],
      });
      expect(fetchCalls).toEqual([{ repo: "publoader-extensions", ref: COMMIT }]);

      const bundle = await prisma.bundle.findFirst({ where: { extension: "mangaplus" } });
      expect(bundle).toMatchObject({ extension: "mangaplus", version: "1.0.0", sourceCommit: COMMIT });
      expect(bundle!.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(res.json().outcomes[0].sha256).toBe(bundle!.sha256);
    });

    it("audit-logs the publish against the repo and short sha", async () => {
      await deliver(pushBody(["src/mangaplus/index.mjs"]));
      const events = await prisma.auditEvent.findMany();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actor: `github:publoader-extensions@${COMMIT.slice(0, 7)}`,
        action: "bundle.publish",
        subject: "mangaplus@1.0.0",
      });
      expect(events[0]!.detail).toMatchObject({ via: "github-webhook", sourceCommit: COMMIT });
    });

    it("publishes every changed extension in one delivery, downloading once", async () => {
      archive = esmArchive(["mangaplus", "viz"]);
      const res = await deliver(pushBody(["src/mangaplus/a.mjs", "src/viz/b.mjs"]));
      expect(res.statusCode).toBe(200);
      expect(res.json().outcomes.map((o: { extension: string }) => o.extension)).toEqual([
        "mangaplus",
        "viz",
      ]);
      expect(fetchCalls).toHaveLength(1);
      expect(await prisma.bundle.count()).toBe(2);
    });

    it("is idempotent across a redelivery of the same push", async () => {
      // GitHub's "Redeliver" button, or a retried delivery, must not churn a new
      // sha256 for byte-identical code.
      const body = pushBody(["src/mangaplus/index.mjs"]);
      const first = await deliver(body);
      const second = await deliver(body);
      expect(first.json().outcomes[0].status).toBe("published");
      expect(second.json().outcomes[0]).toMatchObject({ status: "unchanged" });
      expect(second.json().outcomes[0].sha256).toBe(first.json().outcomes[0].sha256);
      expect(await prisma.bundle.count()).toBe(1);
    });

    it("builds a TypeScript extension with esbuild and publishes the bundled output", async () => {
      archive = tsArchive("mangaplus");
      const res = await deliver(pushBody(["src/mangaplus/index.ts"]));
      expect(res.json().outcomes[0].detail).toBeUndefined();
      expect(res.statusCode).toBe(200);
      expect(res.json().outcomes[0]).toMatchObject({ status: "published", version: "2.0.0" });

      const bundle = await prisma.bundle.findFirstOrThrow({ where: { extension: "mangaplus" } });
      const entries = new AdmZip(Buffer.from(bundle.archive)).getEntries().map((e) => e.entryName);
      // Sources are left behind; the bundle is the built program plus its manifest.
      expect(entries.sort()).toEqual(["index.mjs", "manifest.json"]);
      const built = new AdmZip(Buffer.from(bundle.archive)).getEntry("index.mjs")!.getData().toString();
      expect(built).toContain("hi");
      // A bundler is free to emit `export { x as default }` rather than the
      // literal `export default`: esbuild does exactly that when it bundles,
      // so asserting the literal string tests the bundler's style rather than
      // the requirement. What matters is that a default export exists in one of
      // the forms the publish validator accepts.
      expect(/export\s+default|as\s+default\s*[},]/.test(built)).toBe(true);
      // No absolute path from the build machine leaked into the shipped bytes.
      expect(built).not.toContain("publoader-push-");
      expect(built).not.toMatch(/\/(private|var|home|Users)\//);
    });

    it("rebuilds a TypeScript extension to the identical sha256 on redelivery", async () => {
      // esbuild derives both its file comments and its generated symbol names
      // from the path it is handed, so a build out of a fresh temp directory has
      // to stay reproducible; otherwise every redelivery churns a new bundle
      // for byte-identical source.
      archive = tsArchive("mangaplus");
      const body = pushBody(["src/mangaplus/index.ts"]);
      const first = await deliver(body);
      const second = await deliver(body);
      expect(first.json().outcomes[0].status).toBe("published");
      expect(second.json().outcomes[0]).toMatchObject({ status: "unchanged" });
      expect(second.json().outcomes[0].sha256).toBe(first.json().outcomes[0].sha256);
      expect(await prisma.bundle.count()).toBe(1);
    });

    it("reports 207 with per-extension detail when one extension fails", async () => {
      // `broken` is in the archive but has no manifest.json; mangaplus is fine.
      const zip = new AdmZip(esmArchive(["mangaplus"]));
      zip.addFile(`${ARCHIVE_ROOT}/src/broken/index.mjs`, Buffer.from("export default 1;\n"));
      archive = zip.toBuffer();

      const res = await deliver(pushBody(["src/broken/index.mjs", "src/mangaplus/index.mjs"]));
      expect(res.statusCode).toBe(207);
      expect(res.json().ok).toBe(false);
      const [broken, good] = res.json().outcomes;
      expect(broken).toMatchObject({ extension: "broken", status: "failed" });
      expect(good).toMatchObject({ extension: "mangaplus", status: "published" });
      // The healthy extension still landed.
      expect(await prisma.bundle.count()).toBe(1);
    });

    it("does not leak filesystem paths or the secret in a failure detail", async () => {
      const zip = new AdmZip();
      zip.addFile(`${ARCHIVE_ROOT}/src/broken/notes.txt`, Buffer.from("no manifest here"));
      archive = zip.toBuffer();
      const res = await deliver(pushBody(["src/broken/notes.txt"]));
      const detail = String(res.json().outcomes[0].detail);
      expect(detail).not.toContain(SECRET);
      expect(detail).not.toContain("BundleBuildError");
      expect(detail).not.toMatch(/\n\s+at /);
    });

    it("rejects a python bundle with the porting instruction, not a 500", async () => {
      const zip = new AdmZip();
      zip.addFile(
        `${ARCHIVE_ROOT}/src/mangaplus/manifest.json`,
        Buffer.from(
          JSON.stringify({
            ...manifest("mangaplus"),
            publoader_api: "^1.0.0",
            runtime: "python",
            entrypoint: "mangaplus.py",
          }),
        ),
      );
      zip.addFile(`${ARCHIVE_ROOT}/src/mangaplus/mangaplus.py`, Buffer.from("class Extension: pass\n"));
      archive = zip.toBuffer();

      const res = await deliver(pushBody(["src/mangaplus/mangaplus.py"]));
      expect(res.statusCode).toBe(207);
      expect(res.json().outcomes[0].detail).toMatch(/extension API v2/);
      expect(await prisma.bundle.count()).toBe(0);
    });
  });

  describe("coexistence with the rest of the API", () => {
    it("leaves the global JSON body parser intact for other routes", async () => {
      // The webhook scope swaps in a raw-buffer parser for application/json.
      // If that escaped its plugin scope, every admin route would break.
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/runs",
        headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
        payload: { extension: "nonexistent", kind: "FORCE" },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "no bundle published for nonexistent" });
    });

    it("still answers /healthz", async () => {
      expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    });

    it("does not accept GET on the webhook path", async () => {
      expect((await app.inject({ method: "GET", url: "/webhook" })).statusCode).toBe(404);
    });
  });

  describe("without a configured secret", () => {
    it("fails closed with 503 rather than accepting deliveries", async () => {
      const ctx = buildContext(
        prisma,
        loadConfig({
          DATABASE_URL: process.env.TEST_DATABASE_URL!,
          ADMIN_TOKEN: ADMIN,
          LOG_LEVEL: "error",
          GITHUB_EXTENSIONS_REPOS: "publoader-extensions",
          // GITHUB_WEBHOOK_SECRET deliberately absent.
        }),
        log,
      );
      const unconfigured = buildServer(ctx);
      await unconfigured.ready();
      try {
        const body = pushBody(["src/mangaplus/index.mjs"]);
        const res = await unconfigured.inject({
          method: "POST",
          url: "/webhook",
          headers: {
            "content-type": "application/json",
            "x-github-event": "push",
            "x-hub-signature-256": sign(body),
          },
          payload: body,
        });
        expect(res.statusCode).toBe(503);
        expect(res.json()).toEqual({ ok: false, error: "webhook is not configured" });
      } finally {
        await unconfigured.close();
      }
    });
  });

  describe("rate limiting", () => {
    it("sheds a burst from one IP with 429", async () => {
      const body = pushBody(["README.md"]);
      const codes: number[] = [];
      for (let i = 0; i < 14; i += 1) {
        codes.push((await deliver(body)).statusCode);
      }
      expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
      // The early ones went through: the limiter sheds a burst, it does not
      // block the endpoint outright.
      expect(codes[0]).toBe(200);
    });
  });
});
