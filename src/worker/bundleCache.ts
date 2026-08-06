import { createHash, randomBytes } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import AdmZip from "adm-zip";
import type { Logger } from "../logging.js";
import type { CoreApiClient } from "./coreApi.js";

const SHA256_RE = /^[a-f0-9]{64}$/;
/** Written last; its presence is what makes a cache directory usable. */
const MARKER = ".publoader-bundle-complete";

export class BundleExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleExtractionError";
  }
}

/**
 * Content-addressed extension bundle cache.
 *
 * Bundles are immutable by construction; the directory name IS the sha256 of
 * the zip; so a hit needs no revalidation and concurrent workers on the same
 * host can share the tree safely.
 */
export class BundleCache {
  private readonly root: string;

  constructor(
    statePath: string,
    private readonly api: CoreApiClient,
    private readonly log: Logger,
  ) {
    this.root = join(statePath, "bundles");
  }

  pathFor(sha256: string): string {
    return join(this.root, sha256.toLowerCase());
  }

  private async isComplete(dir: string): Promise<boolean> {
    try {
      await stat(join(dir, MARKER));
      return true;
    } catch {
      return false;
    }
  }

  /** Return a local directory holding the extracted bundle, fetching if absent. */
  async ensure(sha256: string): Promise<string> {
    const sha = sha256.toLowerCase();
    if (!SHA256_RE.test(sha)) throw new BundleExtractionError(`bad bundle sha256: ${sha256}`);

    const dest = this.pathFor(sha);
    if (await this.isComplete(dest)) {
      this.log.debug({ bundleSha256: sha }, "bundle cache hit");
      return dest;
    }

    this.log.info({ bundleSha256: sha }, "fetching bundle");
    const zipBytes = await this.api.downloadBundle(sha);

    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const staging = join(this.root, `.tmp-${sha}-${randomBytes(6).toString("hex")}`);
    await mkdir(staging, { recursive: true, mode: 0o700 });

    try {
      extractZip(zipBytes, staging);
      await writeFile(join(staging, MARKER), `${sha}\n`);
      // Publish atomically. A concurrent agent may have won the race; its tree
      // is byte-identical because the name is the content hash, so losing is
      // not an error.
      try {
        await rename(staging, dest);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (!(await this.isComplete(dest))) throw err;
        this.log.debug({ bundleSha256: sha, code }, "lost bundle publish race; using existing");
      }
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }

    this.log.info({ bundleSha256: sha, path: dest }, "bundle ready");
    return dest;
  }
}

/**
 * Extract entries one by one with an explicit containment check. adm-zip's
 * bulk extractor has historically followed `../` entries out of the target
 * directory; bundles come from a publish pipeline but a worker must not depend
 * on that pipeline being uncompromised.
 */
function extractZip(zipBytes: Buffer, destDir: string): void {
  const zip = new AdmZip(zipBytes);
  const root = resolve(destDir);
  for (const entry of zip.getEntries()) {
    const name = entry.entryName.replace(/\\/g, "/");
    if (name.startsWith("/") || isAbsolute(name)) {
      throw new BundleExtractionError(`absolute path in bundle: ${name}`);
    }
    const target = resolve(root, name);
    const rel = relative(root, target);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new BundleExtractionError(`path traversal in bundle: ${name}`);
    }
    if (entry.isDirectory) continue;
    // Extracts the single entry, recreating intermediate directories.
    zip.extractEntryTo(entry, root, true, true);
  }
}

/** Convenience for callers that already hold bytes (tests, offline seeding). */
export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
