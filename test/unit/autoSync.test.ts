import { describe, expect, it, vi } from "vitest";
import AdmZip from "adm-zip";
import { autoSyncExtensions, listExtensionDirectories } from "../../src/core/webhooks/autoSync.js";
import { createLogger } from "../../src/logging.js";

/**
 * The GitHub poll that catches what the push webhook missed.
 *
 * The behaviours worth pinning are the ones that decide whether an extension
 * silently stops updating: what counts as an extension directory, when the
 * commit is remembered, and — most importantly — that a failed publish is NOT
 * remembered, because recording it would skip that commit until somebody
 * pushed again.
 */
describe("github auto-sync", () => {
  const log = createLogger("test-autosync", "error");

  /** A repo zipball: GitHub wraps everything in one top-level directory. */
  function archive(files: Record<string, string>): Buffer {
    const zip = new AdmZip();
    for (const [path, content] of Object.entries(files)) {
      zip.addFile(`publoader-extensions-abc1234/${path}`, Buffer.from(content));
    }
    return zip.toBuffer();
  }

  const manifest = (name: string) =>
    JSON.stringify({
      name,
      version: "1.0.0",
      publoader_api: "^2.0.0",
      runtime: "node",
      entrypoint: "index.mjs",
      mangadex_group_id: "4f1de6a2-f0c5-4ac5-bce5-02c7dbb67deb",
      languages: ["en"],
      allowed_hosts: ["example.com"],
    });

  /**
   * An in-memory settings store: only get/set are used. The backing map is
   * returned alongside so a test can assert on what was remembered, which is
   * the whole point of several of these.
   */
  function settings(initial: Record<string, string> = {}): {
    store: Map<string, string>;
    fake: never;
  } {
    const store = new Map(Object.entries(initial));
    return {
      store,
      fake: {
        getSetting: async (k: string) => store.get(k) ?? null,
        setSetting: async (k: string, v: string) => void store.set(k, v),
        getGithubAutoSync: async () => true,
      } as never,
    };
  }

  const deps = (over: Record<string, unknown>) =>
    ({
      bundles: { publish: vi.fn() },
      audit: { record: vi.fn() },
      log,
      ...over,
    }) as never;

  const cfg = { repos: ["publoader-extensions"], owner: "publoader", apiUrl: "https://api.github.com" };

  describe("finding extensions in a repo", () => {
    it("takes directories under src/ that have a manifest", () => {
      const found = listExtensionDirectories(
        archive({
          "src/mangaplus/manifest.json": manifest("mangaplus"),
          "src/mangaplus/index.mjs": "export default () => ({});",
          "src/alpha/manifest.json": manifest("alpha"),
          "src/alpha/index.mjs": "export default () => ({});",
        }),
      );
      expect(found).toEqual(["alpha", "mangaplus"]);
    });

    it("ignores shared code that lives beside the extensions", () => {
      // `src/lib` and friends are normal in these repos. Treating them as
      // extensions would produce a failure row on every pass, forever.
      const found = listExtensionDirectories(
        archive({
          "src/mangaplus/manifest.json": manifest("mangaplus"),
          "src/lib/util.ts": "export const x = 1;",
          "src/types/api.d.ts": "export {};",
          "README.md": "# repo",
        }),
      );
      expect(found).toEqual(["mangaplus"]);
    });

    it("returns nothing for a repo with no src/ at all", () => {
      expect(listExtensionDirectories(archive({ "README.md": "# not an extensions repo" }))).toEqual([]);
    });
  });

  describe("deciding what to do", () => {
    it("does not download when the repo head is already the synced commit", async () => {
      const fetchArchive = vi.fn();
      const results = await autoSyncExtensions(
        deps({
          settings: settings({ "github_synced_head:publoader-extensions": "abc123" }).fake,
          github: { head: async () => ({ sha: "abc123", defaultBranch: "main" }) },
          fetchArchive,
        }),
        cfg,
      );
      // The common case: an archive is up to 32 MB and most polls find nothing.
      expect(fetchArchive).not.toHaveBeenCalled();
      expect(results[0]).toMatchObject({ status: "unchanged", commit: "abc123" });
    });

    it("publishes every extension in the repo when the head has moved", async () => {
      // The outcome is built from the BundleStore's own row, so the fake has to
      // carry `extension` — that is the field the caller keys everything on.
      const publish = vi.fn().mockResolvedValue({
        bundle: { extension: "mangaplus", version: "1.0.0", sha256: "f".repeat(64) },
        created: true,
      });
      const store = settings();
      const results = await autoSyncExtensions(
        deps({
          settings: store.fake,
          bundles: { publish },
          github: { head: async () => ({ sha: "def456", defaultBranch: "main" }) },
          fetchArchive: async () =>
            archive({
              "src/mangaplus/manifest.json": manifest("mangaplus"),
              "src/mangaplus/index.mjs": "export default () => ({ async collect() { return {}; } });",
            }),
        }),
        cfg,
      );
      expect(results[0]!.outcomes.map((o) => o.extension)).toEqual(["mangaplus"]);
      expect(publish).toHaveBeenCalledTimes(1);
    });

    it("does NOT remember the commit when a publish failed", async () => {
      // The rule that keeps a transient failure from becoming permanent
      // staleness: remembering this commit would skip the repo until the next
      // push, which is exactly what polling exists to catch.
      const store = settings();
      await autoSyncExtensions(
        deps({
          settings: store.fake,
          bundles: { publish: vi.fn().mockRejectedValue(new Error("build failed")) },
          github: { head: async () => ({ sha: "def456", defaultBranch: "main" }) },
          fetchArchive: async () =>
            archive({
              "src/mangaplus/manifest.json": manifest("mangaplus"),
              "src/mangaplus/index.mjs": "export default () => ({});",
            }),
        }),
        cfg,
      );
      expect(store.store.get("github_synced_head:publoader-extensions")).toBeUndefined();
    });

    it("remembers a repo that simply has no extensions in it", async () => {
      // Nothing to publish is a settled answer, not a failure — re-downloading
      // every tick to learn it again is pure waste.
      const store = settings();
      const results = await autoSyncExtensions(
        deps({
          settings: store.fake,
          github: { head: async () => ({ sha: "def456", defaultBranch: "main" }) },
          fetchArchive: async () => archive({ "README.md": "# docs only" }),
        }),
        cfg,
      );
      expect(results[0]!.status).toBe("unchanged");
      expect(store.store.get("github_synced_head:publoader-extensions")).toBe("def456");
    });

    it("reports a GitHub outage instead of throwing", async () => {
      // This runs inside the scheduler tick; throwing here would take out
      // scheduling, which is the one thing that service must keep doing.
      const results = await autoSyncExtensions(
        deps({
          settings: settings().fake,
          github: {
            head: async () => {
              throw new Error("502 Bad Gateway");
            },
          },
        }),
        cfg,
      );
      expect(results[0]).toMatchObject({ status: "failed", detail: "502 Bad Gateway" });
    });

    it("one broken repo does not stop the others", async () => {
      const heads: Record<string, string> = { good: "aaa", bad: "bbb" };
      const results = await autoSyncExtensions(
        deps({
          settings: settings({ "github_synced_head:good": "aaa" }).fake,
          github: {
            head: async (_c: unknown, repo: string) => {
              if (repo === "bad") throw new Error("404 Not Found");
              return { sha: heads[repo]!, defaultBranch: "main" };
            },
          },
        }),
        { ...cfg, repos: ["good", "bad"] },
      );
      expect(results).toHaveLength(2);
      expect(results[0]!.status).toBe("unchanged");
      expect(results[1]!.status).toBe("failed");
    });
  });
});
