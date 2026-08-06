/**
 * Intake for operator- and repository-supplied bundle archives.
 *
 * Every zip that reaches this module is attacker-influenced: an upload is
 * whatever an operator dropped in a browser, and a GitHub zipball is whatever
 * anyone who can push to that repo wrote. Both come through here, and nothing
 * else in the publish path decompresses an archive.
 *
 * What it defends against:
 *
 *  - Zip bombs. Bytes are counted as they are decompressed, not read from the
 *    central directory, since a declared size is attacker-controlled.
 *    `zlib.inflateRaw` gets a hard `maxOutputLength`, so it aborts mid-inflate
 *    instead of allocating gigabytes. Declared sizes are still checked first,
 *    because a cheap refusal beats an expensive one.
 *  - Zip slip. Names are normalised (backslashes, percent-encoding, `.` and
 *    `..` segments) and the resolved path must be inside the extraction root.
 *    Link entries are refused from their unix mode bits rather than their names.
 *  - Executables. Files are refused by extension allowlist and by magic bytes,
 *    so a Mach-O binary named `manga_id_map.json` does not get through. Archive
 *    permissions are never preserved: everything is written 0600.
 *  - Dependency expectations. `node_modules/` and lockfiles are refused, since
 *    nothing here installs dependencies and ignoring them would publish a
 *    bundle whose imports cannot resolve.
 *
 * It cannot stop hostile intent in a well-formed extension. The control plane
 * never executes it (workers do, under Node's permission model), and ingest
 * validates every result envelope against the manifest. See docs/operations.md
 * §"What bundle intake does and does not protect against".
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { posix, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";
import AdmZip from "adm-zip";
import type { IZipEntry } from "adm-zip";

/** Why an archive was refused. Stable strings: they are audited and asserted. */
export type IntakeRefusal =
  | "unreadable_zip"
  | "too_many_entries"
  | "entry_too_large"
  | "archive_too_large"
  | "compression_ratio"
  | "unsupported_compression"
  | "encrypted_entry"
  | "nested_archive"
  | "absolute_path"
  | "traversal"
  | "link_entry"
  | "executable_mode"
  | "disallowed_type"
  | "binary_content"
  | "shebang"
  | "dependency_tree"
  | "python_bundle"
  | "dotfile"
  | "no_manifest"
  | "ambiguous_manifest"
  | "manifest_unreadable"
  /**
   * The requested directory is not in the archive at all. Its own code because
   * it is the one refusal that is not a defect in the archive: it is what a push
   * deleting an extension looks like, so the caller treats it as "skip this
   * extension" rather than "this archive is hostile".
   */
  | "subtree_missing";

export class BundleIntakeError extends Error {
  constructor(
    readonly code: IntakeRefusal,
    message: string,
  ) {
    super(message);
    this.name = "BundleIntakeError";
  }
}

/**
 * Caps: far above any real extension (the largest bundle we ship is tens of
 * kilobytes) and far below what would trouble the core, which runs with a
 * 768 MiB memory limit and a 256 MiB tmpfs.
 */
export interface IntakeLimits {
  /** Files accepted from the selected extension directory. */
  maxEntries: number;
  /** Entries in the whole archive before we even look at names. */
  maxArchiveEntries: number;
  /** Decompressed bytes for one file. */
  maxEntryBytes: number;
  /** Decompressed bytes for everything we extract. */
  maxTotalBytes: number;
  /** Uncompressed:compressed ceiling, per entry and over the whole extraction. */
  maxRatio: number;
}

export const DEFAULT_INTAKE_LIMITS: IntakeLimits = {
  maxEntries: 2_000,
  maxArchiveEntries: 20_000,
  maxEntryBytes: 10 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
  maxRatio: 200,
};

/**
 * Extensions a bundle may contain: source, data and documentation. Nothing that
 * is a program in its own right, and nothing that configures a toolchain. A
 * manifest's `data_files` values are added to this set at extraction time.
 */
export const ALLOWED_EXTENSIONS = new Set([".mjs", ".js", ".ts", ".json", ".proto", ".md", ".txt"]);

/** Refused on sight: containers we will not account for, and toolchain state. */
const ARCHIVE_EXTENSIONS = new Set([
  ".zip",
  ".gz",
  ".tgz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".tar",
  ".zst",
  ".lz4",
  ".jar",
  ".whl",
]);

/** Path segments that mean "I expected you to install something". */
const DEPENDENCY_PATHS = new Set([
  "node_modules",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "npm-shrinkwrap.json",
  "bun.lockb",
]);

/**
 * Leading bytes that mean "this is a program, not source".
 *
 * Checked on the decompressed content of every file, because the extension
 * allowlist only constrains what an attacker names their file. The Mach-O fat
 * magic is also the Java class magic; both are equally unwelcome.
 */
const BINARY_MAGIC: { magic: Buffer; what: string }[] = [
  { magic: Buffer.from("7f454c46", "hex"), what: "an ELF executable" },
  { magic: Buffer.from("feedface", "hex"), what: "a Mach-O executable" },
  { magic: Buffer.from("feedfacf", "hex"), what: "a Mach-O executable" },
  { magic: Buffer.from("cefaedfe", "hex"), what: "a Mach-O executable" },
  { magic: Buffer.from("cffaedfe", "hex"), what: "a Mach-O executable" },
  { magic: Buffer.from("cafebabe", "hex"), what: "a Mach-O universal binary or Java class" },
  { magic: Buffer.from("4d5a", "hex"), what: "a Windows PE executable" },
  { magic: Buffer.from("dey\n", "utf8"), what: "an Android dex file" },
  { magic: Buffer.from("0061736d", "hex"), what: "a WebAssembly module" },
];

/** The same idea for containers, so a renamed `.zip` is caught by content. */
const ARCHIVE_MAGIC: { magic: Buffer; what: string; offset?: number }[] = [
  { magic: Buffer.from("504b0304", "hex"), what: "a zip archive" },
  { magic: Buffer.from("504b0506", "hex"), what: "a zip archive" },
  { magic: Buffer.from("1f8b", "hex"), what: "a gzip stream" },
  { magic: Buffer.from("425a68", "hex"), what: "a bzip2 archive" },
  { magic: Buffer.from("fd377a585a00", "hex"), what: "an xz archive" },
  { magic: Buffer.from("377abcaf271c", "hex"), what: "a 7z archive" },
  { magic: Buffer.from("526172211a07", "hex"), what: "a rar archive" },
  { magic: Buffer.from("28b52ffd", "hex"), what: "a zstd stream" },
  { magic: Buffer.from("ustar", "utf8"), what: "a tar archive", offset: 257 },
];

/** Only stored and deflated. Anything else includes the encrypted variants. */
const STORED = 0;
const DEFLATED = 8;

/** Zip general-purpose bit 0: the entry is encrypted. */
const FLAG_ENCRYPTED = 0x1;

/** Unix file-type mask and the regular-file value, from the mode in `attr`. */
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const EXEC_BITS = 0o111;

export interface IntakeOptions {
  /**
   * Drop the first path segment of every entry. True for a GitHub zipball,
   * which wraps the tree in `owner-repo-sha/`.
   */
  stripArchiveRoot?: boolean;
  /**
   * Repo-relative directory to take, e.g. `src/mangaplus`. Omitted means "find
   * the single directory containing a manifest.json", which is the upload path.
   */
  subPath?: string;
  limits?: Partial<IntakeLimits>;
}

export interface IntakeResult {
  /** Repo-relative directory that was extracted. "" for a zip rooted at the manifest. */
  root: string;
  files: number;
  /** Bytes actually produced by decompression, not what the archive claimed. */
  uncompressedBytes: number;
  compressedBytes: number;
  /** Name the manifest declares. The caller still validates the manifest fully. */
  manifestName: string | null;
}

/** Stats every audit entry carries, refused or accepted. */
export interface ArchiveStats {
  sha256: string;
  bytes: number;
  entries: number;
}

export function archiveStats(zipData: Buffer): ArchiveStats {
  return {
    sha256: createHash("sha256").update(zipData).digest("hex"),
    bytes: zipData.length,
    entries: countEntries(zipData),
  };
}

/** Entry count without trusting anything else about the archive. */
function countEntries(zipData: Buffer): number {
  try {
    return new AdmZip(zipData).getEntries().length;
  } catch {
    return 0;
  }
}

function open(zipData: Buffer, limits: IntakeLimits): IZipEntry[] {
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipData);
  } catch {
    throw new BundleIntakeError("unreadable_zip", "the archive is not a readable zip");
  }
  let entries: IZipEntry[];
  try {
    entries = zip.getEntries();
  } catch {
    throw new BundleIntakeError("unreadable_zip", "the archive's central directory is unreadable");
  }
  // Before any per-entry work: a central directory with a million records is
  // itself the attack, and enumerating it is the cost.
  if (entries.length > limits.maxArchiveEntries) {
    throw new BundleIntakeError(
      "too_many_entries",
      `the archive declares ${entries.length} entries, over the ${limits.maxArchiveEntries} limit`,
    );
  }
  return entries;
}

/**
 * Repo-relative path of an entry, or null when it is outside what we consider.
 *
 * The traversal decision is made here, on the name, before any path is built
 * from it:
 *
 *  - backslashes become slashes, so `..\..\x` is not mistaken for a filename;
 *  - percent-encoding is decoded, so `%2e%2e/x` cannot smuggle a `..` past a
 *    textual check;
 *  - an absolute path or a Windows drive letter is refused rather than
 *    stripped, because stripping guesses at intent;
 *  - `.` segments are dropped and any remaining `..` segment is refused. Note
 *    that a `..` which merely cancels out (`a/../b`) is still refused: it has
 *    no legitimate use in a bundle and allowing it means reasoning about
 *    normalisation order.
 */
function normaliseName(rawName: string, stripRoot: boolean): string | null {
  let name = rawName;
  if (name.includes("\\")) name = name.split("\\").join("/");
  if (name.includes("%")) {
    try {
      name = decodeURIComponent(name);
    } catch {
      // A malformed escape is not a path we will guess at.
      throw new BundleIntakeError("traversal", `entry name is not decodable: ${clip(rawName)}`);
    }
    if (name.includes("\\")) name = name.split("\\").join("/");
  }
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw new BundleIntakeError(
      "absolute_path",
      `entry name is an absolute path: ${clip(rawName)}`,
    );
  }
  const segments = name.split("/").filter((part) => part.length > 0 && part !== ".");
  if (segments.includes("..")) {
    throw new BundleIntakeError(
      "traversal",
      `entry name escapes the extraction root: ${clip(rawName)}`,
    );
  }
  if (segments.some((part) => part.includes("\0"))) {
    throw new BundleIntakeError("traversal", `entry name contains a null byte: ${clip(rawName)}`);
  }
  if (stripRoot) {
    if (segments.length < 2) return null;
    segments.shift();
  }
  return segments.join("/");
}

const clip = (value: string): string => value.slice(0, 120).replace(/[^\x20-\x7e]/g, "?");

/** Unix mode from the external attributes, or null when the zip carries none. */
function modeOf(entry: IZipEntry): number | null {
  const mode = (entry.header.attr >>> 16) & 0xffff;
  return mode === 0 ? null : mode;
}

/**
 * Refuse anything that is not a plain file.
 *
 * The name is not consulted: a symlink entry looks exactly like a small text
 * file whose content is the target path, and honouring it is how an extraction
 * writes through a link into somewhere it was never allowed. Devices, fifos and
 * sockets are refused for the same reason, so the check is "is this S_IFREG?"
 * rather than a list of bad types.
 *
 * A zip has no hardlink entry type at all, so there is nothing more to check.
 */
function assertPlainFile(entry: IZipEntry, name: string): void {
  const mode = modeOf(entry);
  if (mode === null) return; // Windows-created zip: no unix mode to judge.
  const type = mode & S_IFMT;
  if (type === S_IFDIR) return;
  if (type !== 0 && type !== S_IFREG) {
    const kind = type === 0o120000 ? "a symlink" : `a special file (mode ${mode.toString(8)})`;
    throw new BundleIntakeError("link_entry", `${name} is ${kind}, which a bundle may not contain`);
  }
  if ((mode & EXEC_BITS) !== 0) {
    throw new BundleIntakeError(
      "executable_mode",
      `${name} is marked executable (mode ${(mode & 0o777).toString(8)}); a bundle contains no executables; \`chmod -x\` it and zip again`,
    );
  }
}

function extensionOf(name: string): string {
  const base = posix.basename(name);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/** Name-level checks, all cheap and all before a single byte is decompressed. */
function assertAcceptableName(name: string, allowedFiles: ReadonlySet<string>): void {
  for (const segment of name.split("/")) {
    if (DEPENDENCY_PATHS.has(segment)) {
      throw new BundleIntakeError(
        "dependency_tree",
        `${name}: a bundle is built without installing anything, so ${segment} cannot be honoured. ` +
          "Vendor what you need into the extension, or import only node builtins.",
      );
    }
    // A dotfile is never part of the program and is often part of a toolchain
    // (.npmrc carries registry credentials and hooks; .git carries history).
    if (segment.startsWith(".") && segment !== ".") {
      throw new BundleIntakeError("dotfile", `${name}: a bundle may not contain dotfiles`);
    }
  }

  const extension = extensionOf(name);
  // Its own refusal rather than falling through to the type allowlist: a pre-v2
  // python extension is a real thing an operator may still have on disk, and
  // "port it" is a more useful answer than "we accept these seven extensions".
  if (extension === ".py" || extension === ".pyc" || extension === ".pyi") {
    throw new BundleIntakeError(
      "python_bundle",
      `${name}: python bundles are no longer accepted; port to extension API v2 ` +
        '(set publoader_api "^2.0.0", runtime "node", and default-export an ' +
        "ExtensionFactory from a single ESM entrypoint)",
    );
  }
  if (ARCHIVE_EXTENSIONS.has(extension)) {
    throw new BundleIntakeError(
      "nested_archive",
      `${name}: a bundle may not contain another archive`,
    );
  }
  if (!allowedFiles.has(name) && !ALLOWED_EXTENSIONS.has(extension)) {
    throw new BundleIntakeError(
      "disallowed_type",
      `${name}: a bundle may contain only ${[...ALLOWED_EXTENSIONS].join(", ")} files, ` +
        "plus the paths its manifest declares in data_files",
    );
  }
}

/** Content-level checks on decompressed bytes. */
function assertAcceptableContent(name: string, data: Buffer): void {
  for (const { magic, what } of BINARY_MAGIC) {
    if (data.subarray(0, magic.length).equals(magic)) {
      throw new BundleIntakeError("binary_content", `${name} is ${what}, whatever it is named`);
    }
  }
  for (const { magic, what, offset = 0 } of ARCHIVE_MAGIC) {
    if (data.subarray(offset, offset + magic.length).equals(magic)) {
      throw new BundleIntakeError("nested_archive", `${name} is ${what}, whatever it is named`);
    }
  }
  // A shebang means "run me". Source files that a bundler consumes have no use
  // for one, and a shebang in a .json or .md file is not a mistake.
  if (data.length >= 2 && data[0] === 0x23 && data[1] === 0x21) {
    throw new BundleIntakeError("shebang", `${name} starts with a shebang; a bundle is not a script`);
  }
}

/**
 * Decompress one entry with a hard output ceiling.
 *
 * The load-bearing bomb defence, and why this does not use `entry.getData()`:
 * adm-zip inflates an entry fully into memory before it can be measured, which
 * is the allocation being prevented. `maxOutputLength` makes zlib stop and
 * throw at the limit, so the declared size never has to be believed.
 */
function inflateEntry(entry: IZipEntry, name: string, budget: number, limits: IntakeLimits): Buffer {
  const flags = entry.header.flags;
  if ((flags & FLAG_ENCRYPTED) !== 0) {
    throw new BundleIntakeError("encrypted_entry", `${name} is encrypted`);
  }
  const method = entry.header.method;
  if (method !== STORED && method !== DEFLATED) {
    throw new BundleIntakeError(
      "unsupported_compression",
      `${name} uses compression method ${method}; only stored and deflated entries are accepted`,
    );
  }

  const compressed = entry.getCompressedData();
  const ceiling = Math.min(limits.maxEntryBytes, budget);

  if (method === STORED) {
    // Nothing to inflate, but the same ceilings apply: a stored entry can be
    // enormous, it just cannot lie about being small.
    if (compressed.length > limits.maxEntryBytes) {
      throw new BundleIntakeError(
        "entry_too_large",
        `${name} is ${compressed.length} bytes, over the ${limits.maxEntryBytes} byte per-file limit`,
      );
    }
    if (compressed.length > budget) {
      throw new BundleIntakeError(
        "archive_too_large",
        `the archive expands past the ${limits.maxTotalBytes} byte total limit at ${name}`,
      );
    }
    return compressed;
  }

  try {
    return inflateRawSync(compressed, { maxOutputLength: ceiling });
  } catch (err) {
    const code = (err as { code?: string }).code;
    // ERR_BUFFER_TOO_LARGE is the ceiling doing its job. Which limit was hit
    // decides the message: an entry over its own cap is a different operator
    // problem from an archive that is collectively too big.
    if (code === "ERR_BUFFER_TOO_LARGE" || code === "ERR_OUT_OF_RANGE") {
      if (ceiling === limits.maxEntryBytes) {
        throw new BundleIntakeError(
          "entry_too_large",
          `${name} expands past the ${limits.maxEntryBytes} byte per-file limit`,
        );
      }
      throw new BundleIntakeError(
        "archive_too_large",
        `the archive expands past the ${limits.maxTotalBytes} byte total limit at ${name}`,
      );
    }
    throw new BundleIntakeError("unreadable_zip", `${name} could not be decompressed`);
  }
}

/** Cheap pre-check on what the archive CLAIMS, before spending any CPU. */
function assertDeclaredSizes(entry: IZipEntry, name: string, limits: IntakeLimits): void {
  const declared = entry.header.size;
  const compressed = Math.max(entry.header.compressedSize, 1);
  if (declared > limits.maxEntryBytes) {
    throw new BundleIntakeError(
      "entry_too_large",
      `${name} declares ${declared} bytes, over the ${limits.maxEntryBytes} byte per-file limit`,
    );
  }
  if (declared / compressed > limits.maxRatio) {
    throw new BundleIntakeError(
      "compression_ratio",
      `${name} declares a ${Math.round(declared / compressed)}:1 compression ratio, over the ${limits.maxRatio}:1 limit`,
    );
  }
}

/** Directories in the archive that hold a manifest.json, shallowest first. */
export function findExtensionRoots(zipData: Buffer, options: IntakeOptions = {}): string[] {
  const limits = { ...DEFAULT_INTAKE_LIMITS, ...options.limits };
  const roots = new Set<string>();
  for (const entry of open(zipData, limits)) {
    if (entry.isDirectory) continue;
    let name: string | null;
    try {
      name = normaliseName(entry.entryName, options.stripArchiveRoot === true);
    } catch {
      // A hostile name is not a candidate root; the extraction pass refuses it.
      continue;
    }
    if (name === null || posix.basename(name) !== "manifest.json") continue;
    roots.add(posix.dirname(name) === "." ? "" : posix.dirname(name));
  }
  return [...roots].sort((a, b) => {
    const conventional = (p: string) => (/^src\/[a-z0-9_]+$/.test(p) ? 0 : 1);
    return (
      conventional(a) - conventional(b) ||
      a.split("/").length - b.split("/").length ||
      a.localeCompare(b)
    );
  });
}

/**
 * Validate an archive and write one extension directory into `destDir`.
 *
 * `destDir` must already exist and should come from `mkdtemp`. Files are
 * written 0600 and directories 0700, and the archive's own modes are never
 * applied, so the extracted tree is readable only by the service account.
 *
 * Throws BundleIntakeError, whose `code` is the refusal class and whose message
 * is written for the operator who has to fix the zip.
 */
export function extractBundleTree(
  zipData: Buffer,
  destDir: string,
  options: IntakeOptions = {},
): IntakeResult {
  const limits = { ...DEFAULT_INTAKE_LIMITS, ...options.limits };
  const stripRoot = options.stripArchiveRoot === true;
  const entries = open(zipData, limits);
  const destRoot = resolve(destDir);

  let root = options.subPath;
  if (root === undefined) {
    const found = findExtensionRoots(zipData, options);
    if (found.length === 0) {
      throw new BundleIntakeError(
        "no_manifest",
        "no manifest.json in the archive. Zip the extension directory (or its contents): " +
          "manifest.json plus either a built index.mjs or the TypeScript source.",
      );
    }
    if (found.length > 1) {
      throw new BundleIntakeError(
        "ambiguous_manifest",
        `the archive contains ${found.length} extensions (${found.slice(0, 5).join(", ")}); ` +
          "upload one at a time",
      );
    }
    root = found[0]!;
  }
  const prefix = root === "" ? "" : `${root.replace(/\/+$/, "")}/`;

  // Pass one: names and declared sizes only. Nothing is decompressed, so a
  // hostile archive is refused before it costs anything.
  const selected: { entry: IZipEntry; name: string; relative: string }[] = [];
  for (const entry of entries) {
    const name = normaliseName(entry.entryName, stripRoot);
    if (name === null) continue;
    if (prefix !== "" && !name.startsWith(prefix)) continue;
    if (entry.isDirectory) continue;
    assertPlainFile(entry, name);
    const relative = name.slice(prefix.length);
    if (relative === "") continue;
    assertDeclaredSizes(entry, name, limits);
    selected.push({ entry, name, relative });
  }

  if (selected.length === 0) {
    if (root === "") {
      throw new BundleIntakeError("no_manifest", "the archive contains no files");
    }
    throw new BundleIntakeError("subtree_missing", `${root} is not present in the archive`);
  }
  if (selected.length > limits.maxEntries) {
    throw new BundleIntakeError(
      "too_many_entries",
      `${root || "the archive"} contains ${selected.length} files, over the ${limits.maxEntries} limit`,
    );
  }

  // The manifest first, and separately: its `data_files` widen the allowlist for
  // everything else, so it has to be readable before the rest can be judged.
  const manifestEntry = selected.find((item) => item.relative === "manifest.json");
  if (!manifestEntry) {
    throw new BundleIntakeError(
      "no_manifest",
      `${root || "the archive"}: manifest.json missing or unreadable; a bundle needs one at ` +
        "the root of the extension directory",
    );
  }

  let budget = limits.maxTotalBytes;
  let compressedBytes = 0;
  const manifestData = inflateEntry(manifestEntry.entry, manifestEntry.name, budget, limits);
  budget -= manifestData.length;
  compressedBytes += manifestEntry.entry.header.compressedSize;
  assertAcceptableContent(manifestEntry.name, manifestData);

  let manifestName: string | null = null;
  const dataFiles = new Set<string>();
  try {
    const parsed: unknown = JSON.parse(manifestData.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    const record = parsed as { name?: unknown; data_files?: unknown };
    if (typeof record.name === "string") manifestName = record.name;
    if (typeof record.data_files === "object" && record.data_files !== null) {
      for (const value of Object.values(record.data_files as Record<string, unknown>)) {
        // A declared data file widens the allowlist, so it gets the same name
        // checks as everything else: a data_files entry of "../../etc/passwd"
        // must not become permission to write there.
        if (typeof value !== "string") continue;
        const declared = normaliseName(value, false);
        if (declared) dataFiles.add(declared);
      }
    }
  } catch (err) {
    if (err instanceof BundleIntakeError) throw err;
    throw new BundleIntakeError(
      "manifest_unreadable",
      `${manifestEntry.name} is not valid JSON: ${(err as Error).message}`,
    );
  }

  mkdirSync(destRoot, { recursive: true, mode: 0o700 });
  writeEntry(destRoot, manifestEntry.relative, manifestEntry.name, manifestData);

  let uncompressedBytes = manifestData.length;
  let files = 1;
  for (const item of selected) {
    if (item === manifestEntry) continue;
    assertAcceptableName(item.relative, dataFiles);
    const data = inflateEntry(item.entry, item.name, budget, limits);
    assertAcceptableContent(item.name, data);
    budget -= data.length;
    uncompressedBytes += data.length;
    compressedBytes += item.entry.header.compressedSize;
    writeEntry(destRoot, item.relative, item.name, data);
    files += 1;
  }

  // Overall ratio, on what was actually produced against what was actually
  // read. Per-entry ratios can each sit under the limit while the archive as a
  // whole is still a bomb spread across many files.
  const ratio = uncompressedBytes / Math.max(compressedBytes, 1);
  if (ratio > limits.maxRatio) {
    throw new BundleIntakeError(
      "compression_ratio",
      `the archive expands ${Math.round(ratio)}:1 overall, over the ${limits.maxRatio}:1 limit`,
    );
  }

  return { root, files, uncompressedBytes, compressedBytes, manifestName };
}

/**
 * Write one file, 0600, inside `destRoot`.
 *
 * The resolved-path check is redundant after normaliseName and is kept anyway:
 * it is the last line before a write and costs one string comparison.
 */
function writeEntry(destRoot: string, relative: string, name: string, data: Buffer): void {
  const target = resolve(destRoot, relative);
  if (target !== destRoot && !target.startsWith(destRoot + sep)) {
    throw new BundleIntakeError("traversal", `entry escapes the extraction root: ${clip(name)}`);
  }
  const parent = resolve(target, "..");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  // 0600 and never the archive's mode: nothing extracted here is executable,
  // and nothing else on the host has any business reading it.
  writeFileSync(target, data, { mode: 0o600 });
}
