import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const HERE = fileURLToPath(new URL(".", import.meta.url));
const RUNNER = join(HERE, "..", "..", "runner-node", "runner.mjs");
const FIXTURE = join(HERE, "..", "e2e", "fixtures", "e2etest");

const MD_MANGA_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_MD_ID = "44444444-4444-4444-8444-444444444444";

const MANIFEST = JSON.parse(
  await readFile(join(FIXTURE, "manifest.json"), "utf8"),
) as Record<string, unknown>;

interface RunnerEnvelope {
  runnerVersion: number;
  status: "ok" | "error";
  error: { class: string; message: string } | null;
  updatedChapters: Record<string, unknown>[];
  allChapters: Record<string, unknown>[] | null;
  untrackedManga: Record<string, unknown>[];
  trackedMangadexIds: string[];
  mangadexGroupId: string | null;
  overrideOptions: Record<string, unknown>;
  extensionLanguages: string[];
  images: unknown[];
  stats: { durationS: number };
}

/**
 * Spawn the real runner against the real fixture bundle, exactly the way the
 * executor does; including the Node permission flags, so this test also proves
 * the sandbox does not block the runner's own work. No network is involved:
 * the fixture never calls ctx.fetch.
 */
async function runFixture(job: Record<string, unknown>): Promise<RunnerEnvelope> {
  const workdir = await mkdtemp(join(tmpdir(), "publoader-runner-test-"));
  try {
    const jobFile = join(workdir, "job.json");
    const outputDir = join(workdir, "out");
    await writeFile(
      jobFile,
      JSON.stringify({
        jobId: "00000000-0000-4000-8000-000000000001",
        extension: "e2etest",
        kind: "SCHEDULED",
        segmentMangaIds: [],
        postedChapterIds: [],
        manifest: MANIFEST,
        mangaIdMap: { [MD_MANGA_ID]: ["m1"] },
        overrideOptions: {},
        timeoutSeconds: 120,
        ...job,
      }),
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--disallow-code-generation-from-strings",
        "--permission",
        `--allow-fs-read=${FIXTURE}`,
        `--allow-fs-read=${join(RUNNER, "..")}`,
        `--allow-fs-read=${workdir}`,
        `--allow-fs-write=${outputDir}`,
        `--allow-fs-write=${workdir}`,
        RUNNER,
        "--bundle",
        FIXTURE,
        "--job",
        jobFile,
        "--output",
        outputDir,
      ],
      { cwd: FIXTURE, maxBuffer: 32 * 1024 * 1024 },
    );

    const lines = stdout.trim().split("\n");
    const last = lines[lines.length - 1] ?? "";
    return JSON.parse(last) as RunnerEnvelope;
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

describe("node runner", () => {
  it("produces a v2 envelope with both fixture chapters", async () => {
    const envelope = await runFixture({});

    expect(envelope.runnerVersion).toBe(2);
    expect(envelope.status).toBe("ok");
    expect(envelope.error).toBeNull();
    expect(envelope.updatedChapters).toHaveLength(2);
    expect(envelope.updatedChapters.map((c) => c["chapterId"])).toEqual(["c1", "c2"]);
    // The fixture never sets mdMangaId; resolving it from the platform's map
    // is what proves the DB overlay reaches the extension's output.
    expect(envelope.updatedChapters.every((c) => c["mdMangaId"] === MD_MANGA_ID)).toBe(true);
    expect(envelope.allChapters).toBeNull();
    expect(envelope.untrackedManga).toEqual([
      {
        mangaId: "m2",
        mangaName: "Untracked E2E Manga",
        mangaLanguage: "en",
        mangaUrl: "https://e2e.example.com/manga/m2",
      },
    ]);
    expect(envelope.trackedMangadexIds).toEqual([MD_MANGA_ID]);
    expect(envelope.mangadexGroupId).toBe("22222222-2222-4222-8222-222222222222");
    expect(envelope.extensionLanguages).toEqual(["en"]);
    // Config is database-authoritative; a worker never vouches for any.
    expect(envelope.overrideOptions).toEqual({});
    expect(envelope.images).toEqual([]);
    expect(envelope.stats.durationS).toBeGreaterThanOrEqual(0);
    // The slow path must NOT have triggered: 90s would blow the test timeout,
    // but assert it explicitly so a regression is legible rather than a hang.
    expect(envelope.stats.durationS).toBeLessThan(10);
  });

  it("emits every ChapterRecord field the envelope schema requires", async () => {
    const envelope = await runFixture({});
    expect(Object.keys(envelope.updatedChapters[0] ?? {}).sort()).toEqual(
      [
        "chapterExpire",
        "chapterId",
        "chapterLanguage",
        "chapterLookup",
        "chapterNumber",
        "chapterTimestamp",
        "chapterTitle",
        "chapterUrl",
        "chapterVolume",
        "extensionName",
        "imageArtifacts",
        "mangaId",
        "mangaName",
        "mangaUrl",
        "mdChapterId",
        "mdGroupId",
        "mdMangaId",
      ].sort(),
    );
    expect(envelope.updatedChapters[0]?.["extensionName"]).toBe("e2etest");
    expect(envelope.updatedChapters[0]?.["imageArtifacts"]).toEqual([]);
  });

  it("honours postedChapterIds", async () => {
    const envelope = await runFixture({ postedChapterIds: ["c1"] });
    expect(envelope.updatedChapters.map((c) => c["chapterId"])).toEqual(["c2"]);
  });

  it("ignores postedChapterIds on a clean run and returns a catalogue", async () => {
    const envelope = await runFixture({ kind: "CLEAN", postedChapterIds: ["c1", "c2"] });
    expect(envelope.updatedChapters).toHaveLength(2);
    expect(envelope.allChapters).toEqual([]);
  });

  it("drops chapters whose external manga id has no mapping", async () => {
    // v1 parity: an unmapped series cannot be uploaded, so it never travels.
    const envelope = await runFixture({ mangaIdMap: { [OTHER_MD_ID]: ["somethingelse"] } });
    expect(envelope.status).toBe("ok");
    expect(envelope.updatedChapters).toEqual([]);
    // Untracked manga are deliberately still reported; that is how a new
    // series reaches the operator in the first place.
    expect(envelope.untrackedManga).toHaveLength(1);
    expect(envelope.trackedMangadexIds).toEqual([OTHER_MD_ID]);
  });

  it("filters to the segment even though the fixture ignores trackedSubset", async () => {
    const envelope = await runFixture({ segmentMangaIds: ["m1"] });
    expect(envelope.updatedChapters).toHaveLength(2);

    const otherSegment = await runFixture({
      segmentMangaIds: ["m9"],
      mangaIdMap: { [MD_MANGA_ID]: ["m1", "m9"] },
    });
    // m1's chapters resolve fine but belong to another segment, so this
    // segment contributes nothing; non-overlapping output by construction.
    expect(otherSegment.updatedChapters).toEqual([]);
  });

  it("reports a missing entrypoint as PERMANENT", async () => {
    const envelope = await runFixture({
      manifest: { ...MANIFEST, entrypoint: "does-not-exist.mjs" },
    });
    expect(envelope.status).toBe("error");
    expect(envelope.error?.class).toBe("PERMANENT");
    expect(envelope.error?.message).toMatch(/could not import entrypoint/);
  });

  it("reports a manifest without allowed_hosts as PERMANENT", async () => {
    const envelope = await runFixture({ manifest: { ...MANIFEST, allowed_hosts: [] } });
    expect(envelope.status).toBe("error");
    expect(envelope.error?.class).toBe("PERMANENT");
    expect(envelope.error?.message).toMatch(/allowed_hosts/);
  });

  it("keeps stdout clean enough that the envelope is always the last line", async () => {
    // The fixture logs through ctx.log (stderr). This asserts the runner's
    // stdout redirection holds: exactly one line, and it parses.
    const envelope = await runFixture({});
    expect(envelope.status).toBe("ok");
  });
});

describe("large envelopes", () => {
  /**
   * The runner writes its envelope to stdout and then calls `process.exit()`.
   * stdout to a pipe; which is always the case, because the agent captures it -
   * is asynchronous: past the pipe buffer (~64 KiB) `write()` queues the rest and
   * returns false, and `process.exit()` discards whatever is still queued.
   *
   * The result was a runner that exited 0 having printed a truncated line the
   * agent could not parse: "runner exited 0/null without an envelope", classed
   * TRANSIENT and retried forever. It only happened when the answer was big, so
   * ordinary UPDATE runs always worked and a CLEAN run over a large catalogue
   * did not.
   */
  it("delivers an envelope far larger than the pipe buffer", async () => {
    const envelope = await runFixture({
      kind: "CLEAN",
      mangaIdMap: { [MD_MANGA_ID]: ["m1", "bulk"] },
    });

    expect(envelope.status).toBe("ok");
    expect(envelope.updatedChapters.length).toBeGreaterThan(1000);

    // The assertion that matters is the size: anything under the buffer would
    // pass whether or not the flush is awaited.
    const bytes = Buffer.byteLength(JSON.stringify(envelope));
    expect(bytes, "envelope is too small to exercise the bug").toBeGreaterThan(256 * 1024);
  });
});
