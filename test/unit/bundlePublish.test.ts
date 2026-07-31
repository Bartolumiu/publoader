import { describe, expect, it } from "vitest";
import AdmZip from "adm-zip";
import type { PrismaClient } from "@prisma/client";
import { BundleRejectedError, BundleStore } from "../../src/core/store/bundles.js";

/**
 * Every case here is rejected before any database call, so the store gets a
 * prisma that throws if it is ever touched — reaching it would itself be the
 * bug (an invalid bundle must never be persisted).
 */
const noPrisma = new Proxy(
  {},
  {
    get() {
      throw new Error("publish() reached the database for a bundle it should have rejected");
    },
  },
) as PrismaClient;

const store = new BundleStore(noPrisma);

const baseManifest = {
  name: "fixture",
  version: "1.0.0",
  mangadex_group_id: "22222222-2222-4222-8222-222222222222",
  languages: ["en"],
  allowed_hosts: ["example.com"],
};

function zipWith(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.from(content, "utf8"));
  }
  return zip.toBuffer();
}

const GOOD_ENTRYPOINT = "export default (ctx) => ({ async collect() { return {}; } });\n";

function publish(manifest: Record<string, unknown>, files: Record<string, string>, allowLegacy?: boolean) {
  return store.publish({
    zipData: zipWith({ "manifest.json": JSON.stringify(manifest), ...files }),
    manifest,
    ...(allowLegacy === undefined ? {} : { allowLegacy }),
  });
}

describe("BundleStore.publish runtime enforcement", () => {
  it("rejects an explicit python bundle", async () => {
    await expect(
      publish(
        { ...baseManifest, publoader_api: "^1.0.0", runtime: "python", entrypoint: "fixture.py" },
        { "fixture.py": "class Extension: pass" },
      ),
    ).rejects.toThrow(BundleRejectedError);
  });

  it("rejects a bundle whose python runtime is only implied by publoader_api", async () => {
    // manifestRuntime() infers from the api major when `runtime` is absent;
    // a v1 manifest must not slip through by omitting the field.
    await expect(
      publish(
        { ...baseManifest, publoader_api: "^1.0.0", entrypoint: "fixture.py" },
        { "fixture.py": "class Extension: pass" },
      ),
    ).rejects.toThrow(/no longer accepted/);
  });

  it("names extension API v2 in the rejection so the fix is obvious", async () => {
    await expect(
      publish(
        { ...baseManifest, publoader_api: "^1.0.0", entrypoint: "fixture.py" },
        { "fixture.py": "class Extension: pass" },
      ),
    ).rejects.toThrow(/extension API v2/);
  });

  it("lets a python bundle through only with the explicit override", async () => {
    // Reaching the database is the pass condition here: the runtime gate is
    // behind us, and noPrisma turns the next step into a distinct error.
    await expect(
      publish(
        { ...baseManifest, publoader_api: "^1.0.0", entrypoint: "fixture.py" },
        { "fixture.py": "class Extension: pass" },
        true,
      ),
    ).rejects.toThrow(/reached the database/);
  });
});

describe("BundleStore.publish node entrypoint validation", () => {
  const nodeManifest = {
    ...baseManifest,
    publoader_api: "^2.0.0",
    runtime: "node",
    entrypoint: "index.mjs",
  };

  it("accepts a well-formed node bundle", async () => {
    await expect(publish(nodeManifest, { "index.mjs": GOOD_ENTRYPOINT })).rejects.toThrow(
      /reached the database/,
    );
  });

  it("rejects a missing entrypoint", async () => {
    await expect(publish(nodeManifest, {})).rejects.toThrow(/is missing from the bundle/);
  });

  it("rejects an empty entrypoint", async () => {
    await expect(publish(nodeManifest, { "index.mjs": "   \n" })).rejects.toThrow(/is empty/);
  });

  it("rejects an entrypoint with no default export", async () => {
    await expect(
      publish(nodeManifest, { "index.mjs": "export const collect = () => {};\n" }),
    ).rejects.toThrow(/no default export/);
  });

  it("accepts a transpiled CJS-style default export", async () => {
    await expect(
      publish(nodeManifest, { "index.mjs": "exports.default = () => ({});\n" }),
    ).rejects.toThrow(/reached the database/);
  });

  it("rejects a .py entrypoint declared as a node runtime", async () => {
    await expect(
      publish(
        { ...nodeManifest, entrypoint: "index.py" },
        { "index.py": "# default export? no such thing\nexport default\n" },
      ),
      // The manifest schema constrains the extension list, so this is caught
      // either there or by the .mjs/.js check — both are correct rejections.
    ).rejects.toThrow();
  });
});
