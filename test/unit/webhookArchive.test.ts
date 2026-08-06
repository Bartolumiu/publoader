import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import AdmZip from "adm-zip";
import {
  RepoArchiveError,
  extensionRepoPath,
  extractSubtree,
} from "../../src/core/webhooks/repoArchive.js";
import { zipDirectory } from "../../src/core/webhooks/bundleBuilder.js";

/** A GitHub zipball: every entry sits under one `owner-repo-sha/` wrapper. */
function archive(files: Record<string, string>, root = "publoader-publoader-extensions-1a2b3c4"): Buffer {
  const zip = new AdmZip();
  for (const [path, content] of Object.entries(files)) {
    zip.addFile(`${root}/${path}`, Buffer.from(content, "utf8"));
  }
  return zip.toBuffer();
}

const tempDir = (): string => mkdtempSync(join(tmpdir(), "webhook-archive-test-"));

/**
 * A zip built byte by byte, because adm-zip normalises `..` out of an entry
 * name when you *add* it; so the library cannot be used to construct the
 * malicious archive the zip-slip guard exists for. Stored (uncompressed)
 * entries, which is all the reader needs.
 */
function rawZip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    const local = Buffer.concat([localHeader, nameBuf, data]);
    locals.push(local);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
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

describe("extractSubtree", () => {
  it("writes one extension's files with repo-relative paths, stripping the archive root", () => {
    const zip = archive({
      "README.md": "# repo",
      "src/mangaplus/manifest.json": '{"name":"mangaplus"}',
      "src/mangaplus/index.mjs": "export default 1;\n",
      "src/mangaplus/data/ids.json": "{}",
      "src/viz/manifest.json": '{"name":"viz"}',
    });
    const dest = tempDir();
    expect(extractSubtree(zip, extensionRepoPath("mangaplus"), dest)).toBe(3);

    expect(JSON.parse(readFileSync(join(dest, "manifest.json"), "utf8"))).toEqual({
      name: "mangaplus",
    });
    expect(readFileSync(join(dest, "data", "ids.json"), "utf8")).toBe("{}");
    // Sibling extensions and repo-root files must not leak in.
    expect(readdirSync(dest).sort()).toEqual(["data", "index.mjs", "manifest.json"]);
  });

  it("does not confuse an extension with one whose name it prefixes", () => {
    const zip = archive({
      "src/viz/manifest.json": '{"name":"viz"}',
      "src/viz_extra/manifest.json": '{"name":"viz_extra"}',
      "src/viz_extra/index.mjs": "export default 1;\n",
    });
    const dest = tempDir();
    expect(extractSubtree(zip, extensionRepoPath("viz"), dest)).toBe(1);
    expect(existsSync(join(dest, "index.mjs"))).toBe(false);
  });

  it("reports zero files for an extension that is not in the archive", () => {
    const zip = archive({ "src/mangaplus/manifest.json": "{}" });
    expect(extractSubtree(zip, extensionRepoPath("gone"), tempDir())).toBe(0);
  });

  it("refuses an entry that would escape the extraction root", () => {
    // Anyone who can push to the repo chooses these names, so a traversal entry
    // must be a hard error rather than a file written outside the temp dir.
    const dest = tempDir();
    const zip = rawZip([
      { name: "root/src/evil/../../../publoader-zip-slip-canary", data: Buffer.from("pwned") },
    ]);
    expect(() => extractSubtree(zip, extensionRepoPath("evil"), dest)).toThrow(RepoArchiveError);
    // It refuses before writing, so not even a partial extraction happened.
    expect(readdirSync(dest)).toEqual([]);
  });

  it("rejects bytes that are not a zip", () => {
    expect(() => extractSubtree(Buffer.from("not a zip at all"), "src/x", tempDir())).toThrow(
      /not a readable zip/,
    );
  });

  it("skips entries with no archive root wrapper", () => {
    const zip = new AdmZip();
    zip.addFile("src/mangaplus/manifest.json", Buffer.from("{}"));
    zip.addFile("toplevel.txt", Buffer.from("x"));
    // Without the wrapper the first segment is stripped as if it were one, so
    // nothing matches `src/mangaplus/`: a real GitHub archive always has it.
    expect(extractSubtree(zip.toBuffer(), extensionRepoPath("mangaplus"), tempDir())).toBe(0);
  });
});

describe("zipDirectory determinism", () => {
  it("produces identical bytes for identical content with different mtimes", () => {
    // A repo archive is extracted with "now" as its mtime. If that leaked into
    // the zip, every redelivery of the same push would compute a new sha256 and
    // look like a new version of byte-identical code.
    const make = (mtime: Date): Buffer => {
      const dir = tempDir();
      writeFileSync(join(dir, "manifest.json"), '{"name":"fixture"}');
      writeFileSync(join(dir, "index.mjs"), "export default () => ({});\n");
      for (const file of ["manifest.json", "index.mjs"]) {
        utimesSync(join(dir, file), mtime, mtime);
      }
      return zipDirectory(dir);
    };
    expect(make(new Date("2021-05-05T05:05:05Z")).equals(make(new Date("2024-11-11T11:11:11Z")))).toBe(
      true,
    );
  });

  it("excludes build caches and vcs directories", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "manifest.json"), "{}");
    for (const excluded of ["node_modules", "__pycache__", ".git", "dist"]) {
      mkdirSync(join(dir, excluded));
      writeFileSync(join(dir, excluded, "junk"), "x");
    }
    const names = new AdmZip(zipDirectory(dir)).getEntries().map((e) => e.entryName);
    expect(names).toEqual(["manifest.json"]);
  });
});
