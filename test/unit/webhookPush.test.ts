import { describe, expect, it, vi } from "vitest";
import AdmZip from "adm-zip";
import type { Bundle } from "@prisma/client";
import type { BundleStore } from "../../src/core/store/bundles.js";
import { BundleRejectedError } from "../../src/core/store/bundles.js";
import type { AuditLog } from "../../src/core/store/settings.js";
import { createLogger } from "../../src/logging.js";
import {
  MAX_EXTENSIONS_PER_DELIVERY,
  handleExtensionsPush,
  type PushHandlerDeps,
} from "../../src/core/webhooks/pushHandler.js";
import { RepoArchiveError } from "../../src/core/webhooks/repoArchive.js";
import type { PushPayload } from "../../src/core/webhooks/github.js";

const COMMIT = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
const log = createLogger("test-webhook-push", "silent");

const manifestFor = (name: string): Record<string, unknown> => ({
  name,
  version: "1.0.0",
  publoader_api: "^2.0.0",
  runtime: "node",
  entrypoint: "index.mjs",
  mangadex_group_id: "4f1de6a2-f0c5-4ac5-bce5-02c7dbb67deb",
  languages: ["en"],
  allowed_hosts: ["example.com"],
});

/** An archive holding a plain-ESM extension directory per name given. */
function archiveWith(names: string[], manifestName?: (n: string) => string): Buffer {
  const zip = new AdmZip();
  for (const name of names) {
    const root = `publoader-publoader-extensions-1a2b3c4/src/${name}`;
    zip.addFile(
      `${root}/manifest.json`,
      Buffer.from(JSON.stringify(manifestFor(manifestName ? manifestName(name) : name))),
    );
    zip.addFile(`${root}/index.mjs`, Buffer.from("export default () => ({});\n"));
  }
  return zip.toBuffer();
}

function deps(overrides: Partial<PushHandlerDeps> = {}): PushHandlerDeps & {
  published: string[];
  audited: { actor: string; subject?: string }[];
} {
  const published: string[] = [];
  const audited: { actor: string; subject?: string }[] = [];
  const bundles = {
    publish: vi.fn(async (opts: { manifest: unknown; sourceCommit?: string }) => {
      const manifest = opts.manifest as { name: string; version: string };
      published.push(manifest.name);
      return {
        bundle: {
          extension: manifest.name,
          version: manifest.version,
          sha256: `sha-${manifest.name}`,
        } as Bundle,
        created: true,
      };
    }),
  } as unknown as BundleStore;
  const audit = {
    record: vi.fn(async (actor: string, _action: string, subject?: string) => {
      audited.push({ actor, ...(subject === undefined ? {} : { subject }) });
    }),
  } as unknown as AuditLog;
  return {
    bundles,
    audit,
    log,
    fetchArchive: async () => archiveWith(["mangaplus"]),
    ...overrides,
    published,
    audited,
  };
}

const payload: PushPayload = { ref: "refs/heads/main", after: COMMIT };

const run = (changed: string[], d: PushHandlerDeps) =>
  handleExtensionsPush(payload, "publoader-extensions", COMMIT, changed, {
    owner: "publoader",
    apiUrl: "https://api.github.invalid",
  }, d);

describe("handleExtensionsPush", () => {
  it("publishes one bundle per changed extension and audits each one", async () => {
    const d = deps({ fetchArchive: async () => archiveWith(["mangaplus", "viz"]) });
    const result = await run(["mangaplus", "viz"], d);

    expect(result.commit).toBe(COMMIT);
    expect(result.outcomes).toEqual([
      { extension: "mangaplus", status: "published", version: "1.0.0", sha256: "sha-mangaplus" },
      { extension: "viz", status: "published", version: "1.0.0", sha256: "sha-viz" },
    ]);
    expect(d.published).toEqual(["mangaplus", "viz"]);
    expect(d.audited).toEqual([
      { actor: `github:publoader-extensions@${COMMIT.slice(0, 7)}`, subject: "mangaplus@1.0.0" },
      { actor: `github:publoader-extensions@${COMMIT.slice(0, 7)}`, subject: "viz@1.0.0" },
    ]);
  });

  it("downloads the repository archive exactly once for a multi-extension push", async () => {
    const fetchArchive = vi.fn(async () => archiveWith(["mangaplus", "viz"]));
    await run(["mangaplus", "viz"], deps({ fetchArchive }));
    expect(fetchArchive).toHaveBeenCalledTimes(1);
  });

  it("records the pushed commit as the bundle's sourceCommit", async () => {
    const d = deps();
    await run(["mangaplus"], d);
    expect(d.bundles.publish).toHaveBeenCalledWith(
      expect.objectContaining({ sourceCommit: COMMIT }),
    );
  });

  it("lets one unbuildable extension fail without stopping the others", async () => {
    // `broken` has files but no manifest.json, so its build fails; mangaplus
    // must still ship. One bad extension is not a failed delivery for the rest.
    const d = deps({
      fetchArchive: async () => {
        const zip = new AdmZip(archiveWith(["mangaplus"]));
        zip.addFile(
          "publoader-publoader-extensions-1a2b3c4/src/broken/index.mjs",
          Buffer.from("export default () => ({});\n"),
        );
        return zip.toBuffer();
      },
    });
    const result = await run(["broken", "mangaplus"], d);

    expect(result.outcomes[0]).toMatchObject({ extension: "broken", status: "failed" });
    expect(result.outcomes[0]?.detail).toMatch(/manifest\.json missing or unreadable/);
    expect(result.outcomes[1]).toMatchObject({ extension: "mangaplus", status: "published" });
    expect(d.published).toEqual(["mangaplus"]);
  });

  it("reports a rejected bundle's own reason", async () => {
    const bundles = {
      publish: async () => {
        throw new BundleRejectedError("python bundles are no longer accepted");
      },
    } as unknown as BundleStore;
    const result = await run(["mangaplus"], deps({ bundles }));
    expect(result.outcomes[0]).toEqual({
      extension: "mangaplus",
      status: "failed",
      detail: "python bundles are no longer accepted",
    });
  });

  it("never leaks an unexpected error's message or stack", async () => {
    const bundles = {
      publish: async () => {
        throw new Error("connect ECONNREFUSED 10.0.0.5:5432 while querying /secret/path");
      },
    } as unknown as BundleStore;
    const result = await run(["mangaplus"], deps({ bundles }));
    expect(result.outcomes[0]).toEqual({
      extension: "mangaplus",
      status: "failed",
      detail: "publish failed; see core-api logs",
    });
  });

  it("refuses to publish when the manifest name disagrees with the directory", async () => {
    // Otherwise a push to src/mangaplus could overwrite a different extension.
    const d = deps({ fetchArchive: async () => archiveWith(["mangaplus"], () => "viz") });
    const result = await run(["mangaplus"], d);
    expect(result.outcomes[0]).toMatchObject({ extension: "mangaplus", status: "failed" });
    expect(result.outcomes[0]?.detail).toMatch(/declares name 'viz'/);
    expect(d.published).toEqual([]);
  });

  it("skips an extension whose directory is gone rather than yanking it", async () => {
    const d = deps({ fetchArchive: async () => archiveWith([]) });
    const result = await run(["deleted_ext"], d);
    expect(result.outcomes[0]).toMatchObject({ extension: "deleted_ext", status: "skipped" });
    expect(result.outcomes[0]?.detail).toMatch(/not present at/);
    expect(d.published).toEqual([]);
  });

  it("fails every extension when the archive cannot be fetched, and publishes nothing", async () => {
    const d = deps({
      fetchArchive: async () => {
        throw new RepoArchiveError("archive download failed with HTTP 404");
      },
    });
    const result = await run(["mangaplus", "viz"], d);
    expect(result.outcomes).toEqual([
      { extension: "mangaplus", status: "failed", detail: "archive download failed with HTTP 404" },
      { extension: "viz", status: "failed", detail: "archive download failed with HTTP 404" },
    ]);
    expect(d.published).toEqual([]);
  });

  it("does not report an archive fetch failure's internals for an unexpected error", async () => {
    const d = deps({
      fetchArchive: async () => {
        throw new Error("getaddrinfo EAI_AGAIN api.github.com token=ghp_secret");
      },
    });
    const result = await run(["mangaplus"], d);
    expect(result.outcomes[0]?.detail).toBe("repository archive fetch failed");
  });

  it(`publishes at most ${MAX_EXTENSIONS_PER_DELIVERY} extensions and reports the rest`, async () => {
    const names = ["a_one", "b_two", "c_three", "d_four", "e_five", "f_six", "g_seven"];
    const d = deps({ fetchArchive: async () => archiveWith(names) });
    const result = await run(names, d);

    expect(d.published).toEqual(names.slice(0, MAX_EXTENSIONS_PER_DELIVERY));
    const skipped = result.outcomes.filter((o) => o.status === "skipped");
    expect(skipped.map((o) => o.extension)).toEqual(names.slice(MAX_EXTENSIONS_PER_DELIVERY));
    expect(skipped[0]?.detail).toMatch(/bundle publish/);
  });

  it("does not fetch anything when nothing changed", async () => {
    const fetchArchive = vi.fn(async () => archiveWith([]));
    const result = await run([], deps({ fetchArchive }));
    expect(fetchArchive).not.toHaveBeenCalled();
    expect(result.outcomes).toEqual([]);
  });

  it("stops publishing once the time budget is exhausted", async () => {
    // The clock jumps past the deadline after the first extension, standing in
    // for a slow build without making the test slow.
    const start = Date.now();
    // Read in order: deadline calculation, first extension's check (in budget),
    // second extension's check (over budget).
    const clock = [start, start, start + 10 * 60 * 1000];
    const d = deps({
      fetchArchive: async () => archiveWith(["a_one", "b_two"]),
      now: () => clock.shift() ?? start + 10 * 60 * 1000,
    });
    const result = await run(["a_one", "b_two"], d);
    expect(result.outcomes.map((o) => o.status)).toEqual(["published", "skipped"]);
    expect(result.outcomes[1]?.detail).toMatch(/time budget/);
  });
});
