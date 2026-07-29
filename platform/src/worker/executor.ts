import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "../logging.js";
import type { Config } from "../config.js";
import { ResultEnvelope, resultIdempotencyKey } from "../contracts/envelope.js";
import type { ChapterRecord } from "../contracts/records.js";
import type { CoreApiClient, LeasedJob } from "./coreApi.js";
import type { BundleCache } from "./bundleCache.js";

/** Mirrors ALLOWED_CONTENT_TYPES in core/store/artifacts.ts. Kept local so the
 * worker plane never imports core modules. */
const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** stdout is the envelope channel; anything past this is a runaway extension. */
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_TAIL_BYTES = 256 * 1024;
/** Grace between asking the process group to stop and forcing it. */
const KILL_GRACE_MS = 10_000;

export class JobCancelledError extends Error {
  constructor(readonly reason: string) {
    super(`job cancelled: ${reason}`);
    this.name = "JobCancelledError";
  }
}

/** Which envelope list an image batch belongs to. */
type ChapterListName = "updatedChapters" | "allChapters";

interface RunnerImageBatch {
  listName: ChapterListName;
  chapterIndex: number;
  files: string[];
}

/** The exact JSON the Python runner prints as its last stdout line. */
interface RunnerOutput {
  runnerVersion?: number;
  status: "ok" | "error";
  error?: { class: "TRANSIENT" | "PERMANENT"; message: string } | null;
  updatedChapters?: ChapterRecord[];
  allChapters?: ChapterRecord[] | null;
  untrackedManga?: unknown[];
  trackedMangadexIds?: string[];
  mangadexGroupId?: string | null;
  overrideOptions?: Record<string, unknown>;
  extensionLanguages?: string[];
  images?: RunnerImageBatch[];
  stats?: { durationS?: number; httpRequests?: number };
}

interface RunnerInvocation {
  output: RunnerOutput | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stderrTail: string;
}

/**
 * Locate runner.py.
 *
 * Two layouts are probed relative to this module: runner/ sitting beside dist/
 * (what docker/worker/Dockerfile builds, where the agent runs from
 * /app/dist/src/worker and the shim lives at /app/runner), and runner/ one
 * level up from src/ (running straight from source under tsx). Either env var
 * overrides the probe — PUBLOADER_RUNNER is the name the worker image sets.
 */
export async function resolveRunnerPath(): Promise<string> {
  const override = process.env["RUNNER_PATH"] ?? process.env["PUBLOADER_RUNNER"];
  if (override) return override;
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    join(here, "..", "..", "runner", "runner.py"),
    join(here, "..", "..", "..", "runner", "runner.py"),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try the next layout
    }
  }
  throw new Error(
    `runner.py not found (tried ${candidates.join(", ")}); set RUNNER_PATH to its location`,
  );
}

/**
 * Runs one leased job end to end: materialise the bundle, drive the Python
 * runner, upload page images as artifacts, and build the result envelope.
 *
 * The executor never writes to the control plane's state itself — its only
 * output is an envelope for the caller to submit.
 */
export class JobExecutor {
  constructor(
    private readonly api: CoreApiClient,
    private readonly bundles: BundleCache,
    private readonly config: Config,
    private readonly log: Logger,
  ) {}

  async execute(job: LeasedJob, leaseId: string, signal: AbortSignal): Promise<ResultEnvelope> {
    const log = this.log.child({ jobId: job.jobId, extension: job.extension, attempt: job.attempt });
    const startedAt = Date.now();

    const bundleDir = await this.bundles.ensure(job.bundleSha256);
    const workdir = await mkdtemp(join(tmpdir(), `publoader-job-${job.jobId.slice(0, 8)}-`));

    try {
      const jobFile = join(workdir, "job.json");
      const outputDir = join(workdir, "out");
      await writeFile(
        jobFile,
        JSON.stringify(
          {
            jobId: job.jobId,
            runId: job.runId,
            extension: job.extension,
            extensionVersion: job.extensionVersion,
            bundleSha256: job.bundleSha256,
            kind: job.kind,
            attempt: job.attempt,
            segmentIndex: job.segmentIndex,
            segmentTotal: job.segmentTotal,
            segmentKey: job.segmentKey,
            segmentMangaIds: job.segmentMangaIds ?? [],
            postedChapterIds: job.postedChapterIds ?? [],
            manifest: job.manifest,
            timeoutSeconds: job.timeoutSeconds,
            // Database-sourced runtime config. The runner materialises
            // mangaIdMap into the workdir and serves it to the extension in
            // place of the bundle's own manga_id_map.json.
            mangaIdMap: job.mangaIdMap ?? {},
            overrideOptions: job.overrideOptions ?? {},
          },
          null,
          2,
        ),
      );

      const invocation = await this.runRunner({
        bundleDir,
        jobFile,
        outputDir,
        timeoutSeconds: job.timeoutSeconds,
        signal,
        log,
      });

      if (invocation.output === null) {
        const detail = invocation.timedOut
          ? `runner exceeded ${job.timeoutSeconds}s wall clock`
          : `runner exited ${invocation.exitCode}/${invocation.signal} without an envelope`;
        log.error({ stderrTail: invocation.stderrTail }, detail);
        return this.errorEnvelope(job, leaseId, "TRANSIENT", `${detail}\n${invocation.stderrTail}`, {
          durationS: (Date.now() - startedAt) / 1000,
        });
      }

      const runner = invocation.output;
      if (runner.status === "error") {
        const err = runner.error ?? { class: "TRANSIENT" as const, message: "unspecified" };
        log.warn({ errClass: err.class, message: err.message }, "extension reported failure");
        return this.errorEnvelope(job, leaseId, err.class, err.message, runner.stats ?? {});
      }

      const updatedChapters = runner.updatedChapters ?? [];
      const allChapters = runner.allChapters ?? null;
      await this.uploadImages(job.jobId, runner.images ?? [], updatedChapters, allChapters, log);

      const envelope = ResultEnvelope.parse({
        envelopeVersion: 1,
        jobId: job.jobId,
        leaseId,
        segmentKey: job.segmentKey ?? null,
        extension: job.extension,
        bundleSha256: job.bundleSha256,
        idempotencyKey: resultIdempotencyKey(job.jobId, job.attempt),
        status: "ok",
        error: null,
        updatedChapters,
        allChapters,
        untrackedManga: runner.untrackedManga ?? [],
        trackedMangadexIds: runner.trackedMangadexIds ?? [],
        mangadexGroupId: runner.mangadexGroupId ?? null,
        overrideOptions: runner.overrideOptions ?? {},
        extensionLanguages: runner.extensionLanguages ?? [],
        stats: {
          durationS: runner.stats?.durationS ?? (Date.now() - startedAt) / 1000,
          ...(runner.stats?.httpRequests !== undefined
            ? { httpRequests: runner.stats.httpRequests }
            : {}),
        },
      });
      log.info(
        {
          updated: envelope.updatedChapters.length,
          all: envelope.allChapters?.length ?? null,
          durationS: envelope.stats.durationS,
        },
        "job produced envelope",
      );
      return envelope;
    } catch (err) {
      if (err instanceof JobCancelledError) throw err;
      // A malformed runner payload is our contract breaking, not the site's:
      // retrying the same bundle would fail identically.
      log.error({ err }, "executor failed to build envelope");
      return this.errorEnvelope(
        job,
        leaseId,
        "PERMANENT",
        err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        { durationS: (Date.now() - startedAt) / 1000 },
      );
    } finally {
      await rm(workdir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private errorEnvelope(
    job: LeasedJob,
    leaseId: string,
    errClass: "TRANSIENT" | "PERMANENT",
    message: string,
    stats: { durationS?: number; httpRequests?: number },
  ): ResultEnvelope {
    return ResultEnvelope.parse({
      envelopeVersion: 1,
      jobId: job.jobId,
      leaseId,
      segmentKey: job.segmentKey ?? null,
      extension: job.extension,
      bundleSha256: job.bundleSha256,
      idempotencyKey: resultIdempotencyKey(job.jobId, job.attempt),
      status: "error",
      error: { class: errClass, message: message.slice(0, 10_000) },
      updatedChapters: [],
      allChapters: null,
      untrackedManga: [],
      trackedMangadexIds: [],
      mangadexGroupId: null,
      overrideOptions: {},
      extensionLanguages: [],
      stats,
    });
  }

  private async runRunner(opts: {
    bundleDir: string;
    jobFile: string;
    outputDir: string;
    timeoutSeconds: number;
    signal: AbortSignal;
    log: Logger;
  }): Promise<RunnerInvocation> {
    const runnerPath = await resolveRunnerPath();
    const extraArgs = this.config.runnerExtraArgs.split(/\s+/).filter(Boolean);
    const args = [
      runnerPath,
      "--bundle",
      opts.bundleDir,
      "--job",
      opts.jobFile,
      "--output",
      opts.outputDir,
      ...extraArgs,
    ];

    opts.log.info({ python: this.config.runnerPython, runnerPath }, "spawning runner");

    // Deliberately minimal environment: the extension is untrusted code and
    // must not be able to read the worker token, core URL, or anything else
    // this process was configured with.
    const child = spawn(this.config.runnerPython, args, {
      cwd: opts.bundleDir,
      detached: true, // own process group, so a timeout kills grandchildren too
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: opts.outputDir,
        TMPDIR: opts.outputDir,
        LANG: process.env["LANG"] ?? "C.UTF-8",
        PYTHONUNBUFFERED: "1",
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONHASHSEED: "0",
      },
    });

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrTail = "";
    let overflowed = false;

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        overflowed = true;
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const line of text.split("\n")) {
        if (line.trim()) opts.log.debug({ runner: line.trim() }, "runner stderr");
      }
      stderrTail = (stderrTail + text).slice(-MAX_STDERR_TAIL_BYTES);
    });

    let timedOut = false;
    let cancelReason: string | null = null;

    const stopGroup = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        // Group already gone.
      }
    };
    const terminate = () => {
      stopGroup("SIGTERM");
      setTimeout(() => stopGroup("SIGKILL"), KILL_GRACE_MS).unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      opts.log.error({ timeoutSeconds: opts.timeoutSeconds }, "runner timed out; killing group");
      terminate();
    }, opts.timeoutSeconds * 1000);
    timer.unref();

    const onAbort = () => {
      cancelReason = (opts.signal.reason as string) ?? "cancelled";
      opts.log.warn({ reason: cancelReason }, "cancel requested; killing runner group");
      terminate();
    };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolvePromise, rejectPromise) => {
        child.on("error", rejectPromise);
        child.on("close", (code, sig) => resolvePromise({ code, signal: sig }));
      },
    ).finally(() => {
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
    });

    if (cancelReason !== null) throw new JobCancelledError(cancelReason);

    if (overflowed) {
      opts.log.error({ stdoutBytes }, "runner stdout exceeded cap; envelope discarded");
      return { output: null, exitCode: exit.code, signal: exit.signal, timedOut, stderrTail };
    }

    const output = parseRunnerOutput(Buffer.concat(stdoutChunks).toString("utf8"));
    if (output === null && !timedOut) {
      opts.log.error({ exitCode: exit.code }, "runner produced no parseable envelope");
    }
    return { output, exitCode: exit.code, signal: exit.signal, timedOut, stderrTail };
  }

  /**
   * Upload every page image the runner wrote to disk and splice the returned
   * artifact ids back into the chapter they belong to, preserving page order.
   */
  private async uploadImages(
    jobId: string,
    batches: RunnerImageBatch[],
    updatedChapters: ChapterRecord[],
    allChapters: ChapterRecord[] | null,
    log: Logger,
  ): Promise<void> {
    if (batches.length === 0) return;
    let uploaded = 0;

    for (const batch of batches) {
      const list = batch.listName === "allChapters" ? allChapters : updatedChapters;
      const chapter = list?.[batch.chapterIndex];
      if (!chapter) {
        log.warn(
          { listName: batch.listName, chapterIndex: batch.chapterIndex },
          "image batch references a chapter that is not in the envelope; dropping",
        );
        continue;
      }
      const artifactIds: string[] = [];
      for (const file of batch.files) {
        const contentType = CONTENT_TYPE_BY_EXT[extname(file).toLowerCase()];
        if (!contentType) {
          log.warn({ file }, "unsupported image type; dropping page");
          continue;
        }
        const data = await readFile(file);
        const sha256 = createHash("sha256").update(data).digest("hex");
        const result = await this.api.uploadArtifact({ data, contentType, sha256, jobId });
        artifactIds.push(result.artifactId);
        uploaded += 1;
      }
      chapter.imageArtifacts = artifactIds;
    }
    log.info({ uploaded }, "uploaded page artifacts");
  }
}

/**
 * The runner prints its envelope as the last line of stdout. Extension code
 * that writes to stdout is redirected to stderr on the Python side, but we
 * still scan backwards so a stray line can never mask the result.
 */
export function parseRunnerOutput(stdout: string): RunnerOutput | null {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? "").trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as RunnerOutput;
      if (parsed && (parsed.status === "ok" || parsed.status === "error")) return parsed;
    } catch {
      // Not the envelope line; keep walking backwards.
    }
  }
  return null;
}
