/**
 * Turning an extension *directory* into a publishable bundle: build the ESM
 * entrypoint if there are TypeScript sources, stage what belongs in the
 * archive, and zip it.
 *
 * This lives here rather than in the CLI because two callers need it: the
 * operator running `publoader-admin bundle publish <dir>` on a laptop, and the
 * GitHub push webhook building a directory it just extracted from a repo
 * archive. Both must produce byte-identical archives for the same input — the
 * sha256 of this zip is the version pin a worker verifies, so two publish
 * paths that disagree would be two different programs.
 *
 * Everything here throws BundleBuildError with an operator-readable message.
 * The CLI converts that into a non-zero exit; the webhook converts it into a
 * per-extension error in its response.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import AdmZip from "adm-zip";

/** A directory that cannot be built into a bundle, with the reason why. */
export class BundleBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleBuildError";
  }
}

/** Never shipped in a bundle: build inputs and caches, not the program. */
export const ZIP_EXCLUDED = new Set(["__pycache__", ".git", "node_modules", "dist", ".turbo"]);

/**
 * Zip every file under `dir` with paths relative to it, so manifest.json is at
 * the root.
 *
 * Entries are added in sorted order and with a fixed timestamp so the same
 * directory always produces the same bytes — otherwise the content-addressed
 * sha256 would change on every rebuild and each webhook delivery would look
 * like a new version of identical code.
 */
export function zipDirectory(dir: string): Buffer {
  const zip = new AdmZip();
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (ZIP_EXCLUDED.has(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`);
      else if (entry.isFile()) zip.addFile(`${prefix}${entry.name}`, readFileSync(full));
    }
  };
  walk(dir, "");
  for (const entry of zip.getEntries()) {
    entry.header.time = ZIP_EPOCH;
  }
  return zip.toBuffer();
}

/**
 * Fixed mtime for every zip entry. The value is arbitrary; what matters is
 * that it does not come from the filesystem. A repo archive is extracted with
 * "now" as its mtime, so without this the webhook would compute a different
 * sha256 than the CLI for the very same commit.
 */
const ZIP_EPOCH = new Date("2020-01-01T00:00:00Z");

/** What esbuild's `build` looks like to us. See buildEntrypoint for why it is typed here. */
interface EsbuildModule {
  build(options: Record<string, unknown>): Promise<{ errors: { text: string }[] }>;
}

/**
 * A bundle ships ONE self-contained ESM file. When the extension directory has
 * TypeScript sources (or a package.json build script implying a toolchain),
 * esbuild produces that file here, at publish time — never on a worker.
 * Workers receive pre-built, content-addressed code and have no compiler, no
 * package manager, and no reason to acquire either.
 *
 * `external: []` means dependencies are inlined: what the sha256 pins is the
 * complete program, so a worker's execution cannot be changed by anything
 * resolving differently later. The flip side is that every import must be
 * resolvable from `root` — a node builtin or a relative path. An extension
 * that imports a third-party package cannot be built from a bare repo
 * checkout, which is why the webhook path is limited to dependency-free
 * extensions (see docs/webhooks.md).
 */
export async function buildEntrypoint(root: string, source: string, outFile: string): Promise<void> {
  let esbuild: EsbuildModule;
  try {
    // Resolved at run time so this still works for plain-.mjs extensions on an
    // install where esbuild is absent.
    const specifier = "esbuild";
    esbuild = (await import(specifier)) as EsbuildModule;
  } catch {
    throw new BundleBuildError(
      `${source} needs a build step but esbuild is not installed. ` +
        "Run `pnpm install` in platform/, or ship a prebuilt index.mjs instead.",
    );
  }
  const result = await esbuild.build({
    // absWorkingDir + a relative entry point keeps the output free of absolute
    // paths. esbuild derives both its file comments and its generated symbol
    // names from the path it was given, so building the same commit out of a
    // different temp directory would otherwise produce different bytes — a new
    // sha256 for identical code on every webhook redelivery — and would bake
    // the server's filesystem layout into a published bundle.
    absWorkingDir: root,
    entryPoints: [source],
    outfile: outFile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    external: [],
    sourcemap: false,
    logLevel: "silent",
  });
  if (result.errors.length > 0) {
    throw new BundleBuildError(
      `esbuild failed:\n${result.errors.map((e) => `  ${e.text}`).join("\n")}`,
    );
  }
}

/** The TS entrypoint to build, or null when the directory is already plain ESM. */
export function detectSourceEntrypoint(root: string): string | null {
  for (const candidate of ["index.ts", join("src", "index.ts")]) {
    if (existsSync(join(root, candidate))) return candidate;
  }
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    let pkg: { scripts?: Record<string, string>; main?: string };
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
      // An unparseable package.json is not our problem unless it claimed a build.
      return null;
    }
    if (pkg.scripts?.["build"]) {
      const main = pkg.main ?? "index.ts";
      if (existsSync(join(root, main))) return main;
      throw new BundleBuildError(
        `package.json declares a build script but ${main} does not exist`,
      );
    }
  }
  return null;
}

/**
 * Stage what actually gets zipped: the built index.mjs, a manifest whose
 * entrypoint points at it, and the declared data files. Source, tests,
 * node_modules and lockfiles are deliberately left behind — a bundle is the
 * program, not the project.
 */
export function stageBuiltBundle(
  root: string,
  manifest: BundleManifestHead,
  builtFile: string,
): { staging: string; manifest: BundleManifestHead } {
  const staging = mkdtempSync(join(tmpdir(), "publoader-bundle-"));
  // The staged manifest is the one that ships, and it is the one callers must
  // publish: `entrypoint` now names the built file, not the TypeScript source
  // the schema would reject.
  const staged: BundleManifestHead = { ...manifest, entrypoint: "index.mjs" };
  copyFileSync(builtFile, join(staging, "index.mjs"));
  writeFileSync(join(staging, "manifest.json"), JSON.stringify(staged, null, 2) + "\n");
  const dataFiles = (manifest["data_files"] as Record<string, string> | undefined) ?? {};
  for (const relative of Object.values(dataFiles)) {
    const from = join(root, relative);
    if (!existsSync(from)) {
      rmSync(staging, { recursive: true, force: true });
      throw new BundleBuildError(
        `manifest data_files references ${relative}, which is not in the extension directory`,
      );
    }
    const to = join(staging, relative);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
  return { staging, manifest: staged };
}

/** Manifest fields this module needs; the API validates the rest on publish. */
export interface BundleManifestHead extends Record<string, unknown> {
  name: string;
  version: string;
}

export interface BuiltBundle {
  zipData: Buffer;
  /**
   * The manifest as it exists *inside* `zipData` — for a built bundle that
   * means `entrypoint` already points at index.mjs. Publish this one, not the
   * file on disk, or the manifest and the archive would disagree.
   */
  manifest: BundleManifestHead;
  /** The source file esbuild compiled, or null when the directory was already ESM. */
  builtFrom: string | null;
}

/**
 * Read `root/manifest.json`, build if needed, and return the zip to publish.
 * The one entry point both publish paths use.
 */
export async function buildExtensionBundle(root: string): Promise<BuiltBundle> {
  let manifest: Partial<BundleManifestHead>;
  const manifestPath = join(root, "manifest.json");
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    throw new BundleBuildError(
      `${manifestPath} missing or unreadable: ${(err as Error).message}`,
    );
  }
  if (!manifest.name || !manifest.version) {
    throw new BundleBuildError("manifest.json must declare both `name` and `version`");
  }
  const head = manifest as BundleManifestHead;

  const source = detectSourceEntrypoint(root);
  if (source === null) {
    // Plain ESM (or a legacy python bundle): ship the directory as-is.
    return { zipData: zipDirectory(root), manifest: head, builtFrom: null };
  }
  const staging = mkdtempSync(join(tmpdir(), "publoader-build-"));
  let publishDir: string | null = null;
  try {
    const builtFile = join(staging, "index.mjs");
    await buildEntrypoint(root, source, builtFile);
    const staged = stageBuiltBundle(root, head, builtFile);
    publishDir = staged.staging;
    return { zipData: zipDirectory(publishDir), manifest: staged.manifest, builtFrom: source };
  } finally {
    if (publishDir) rmSync(publishDir, { recursive: true, force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}
