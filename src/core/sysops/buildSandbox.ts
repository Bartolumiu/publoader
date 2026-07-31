/**
 * Running esbuild over an untrusted extension directory, in a subprocess.
 *
 * esbuild does not execute the code it bundles, so this is not a sandbox for
 * arbitrary execution — it is a blast radius and a resource bound for a step
 * that reads attacker-supplied source in the control-plane process. Four things
 * made the in-process `await import("esbuild")` unacceptable here:
 *
 *  1. RESOURCES. A pathological input (deep nesting, enormous string literals, a
 *     million imports) can consume unbounded CPU and memory. In-process that is
 *     an OOM of core-api. Out of process it is a killed child and a 422.
 *  2. ENVIRONMENT. This process holds DATABASE_URL, ADMIN_TOKEN,
 *     GITHUB_TOKEN and the MangaDex credentials. None of it belongs anywhere
 *     near a build of code someone uploaded, so the child gets an explicit
 *     minimal env rather than an inherited one.
 *  3. TSCONFIG. This one was not theoretical. esbuild honours a `tsconfig.json`
 *     found next to the sources, including `compilerOptions.paths` — and paths
 *     may be ABSOLUTE. A `manifest.json` + `index.ts` + a two-line tsconfig
 *     mapping `"secrets": ["/proc/self/environ"]` had esbuild inline that file
 *     into the published bundle, which any enrolled worker can then download.
 *     Passing `tsconfigRaw` makes esbuild ignore on-disk tsconfig files
 *     entirely, and the mapped import then fails to resolve. Verified in
 *     test/unit/buildSandbox.test.ts.
 *  4. PROCESS GROUP. esbuild's JS API spawns the esbuild Go binary as its own
 *     child. Killing only our direct child on timeout would leave that running,
 *     so the child is `detached` and the whole group is signalled.
 *
 * NO PACKAGE MANAGER IS EVER INVOKED — not npm, not pnpm, not yarn, not `npm
 * exec`. This is deliberate and is the only real guarantee that a
 * `scripts.postinstall` in an uploaded package.json stays inert: there is no
 * code path from here to a lifecycle script. `external: []` completes the
 * picture — a third-party import is a build FAILURE with an explanation, never
 * a fetch.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

/** Wall-clock ceiling for one build. Our largest real extension builds in <2s. */
export const BUILD_TIMEOUT_MS = 30_000;

/** Heap ceiling for the child. esbuild's own Go process is bounded by its work. */
export const BUILD_MAX_HEAP_MB = 256;

export class SandboxBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxBuildError";
  }
}

export interface SandboxBuildRequest {
  /** Directory to build in. Becomes the child's cwd and esbuild's absWorkingDir. */
  root: string;
  /** Entry point, relative to `root`. */
  entry: string;
  /** Absolute output path. Kept outside `root` by callers, so it is not re-read. */
  outFile: string;
  timeoutMs?: number;
}

/**
 * The child program, as a string.
 *
 * Inline rather than a file on disk because the layout differs between `src/`
 * (vitest, tsx) and `dist/` (the container), and a build step that works in one
 * and not the other is a deploy-time surprise. esbuild's absolute path is passed
 * in argv and `require`d directly: the child's cwd is the untrusted extraction
 * directory, which has no node_modules — and must not be searched for one.
 */
const CHILD = `
const [esbuildPath, root, entry, outFile] = process.argv.slice(1);
const esbuild = require(esbuildPath);
esbuild
  .build({
    absWorkingDir: root,
    entryPoints: [entry],
    outfile: outFile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    // Nothing is fetched or installed: an unresolvable import is an error.
    external: [],
    // Ignore any tsconfig.json in the tree. See the module comment: an on-disk
    // tsconfig with absolute compilerOptions.paths is an arbitrary-file-read.
    tsconfigRaw: {},
    // No plugins, ever: a plugin is arbitrary code running in this process.
    plugins: [],
    sourcemap: false,
    logLevel: "silent",
    metafile: false,
  })
  .then((result) => {
    if (result.errors.length > 0) {
      process.stdout.write(JSON.stringify({ errors: result.errors.map((e) => e.text) }));
      process.exit(2);
    }
    process.exit(0);
  })
  .catch((err) => {
    const errors = Array.isArray(err && err.errors) ? err.errors.map((e) => e.text) : [String(err && err.message ? err.message : err)];
    process.stdout.write(JSON.stringify({ errors }));
    process.exit(2);
  });
`;

/** Resolved once: it is a path inside our own node_modules, not the archive's. */
function esbuildPath(): string {
  const require_ = createRequire(import.meta.url);
  try {
    return require_.resolve("esbuild");
  } catch {
    throw new SandboxBuildError(
      "this build needs esbuild, which is not installed. Run `pnpm install` in platform/, " +
        "or upload a prebuilt index.mjs instead.",
    );
  }
}

/**
 * Build `entry` into `outFile`, or throw SandboxBuildError with a message an
 * operator can act on.
 */
export async function buildInSandbox(request: SandboxBuildRequest): Promise<void> {
  const timeout = request.timeoutMs ?? BUILD_TIMEOUT_MS;
  const resolved = esbuildPath();

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [
        `--max-old-space-size=${BUILD_MAX_HEAP_MB}`,
        "-e",
        CHILD,
        resolved,
        request.root,
        request.entry,
        request.outFile,
      ],
      {
        cwd: request.root,
        // Explicit and minimal. Every secret this service holds arrives through
        // the environment, so an inherited env is the leak. PATH is here only
        // because a child process with none can confuse tooling; esbuild
        // resolves its own binary by absolute path and does not need it.
        env: { PATH: "/usr/bin:/bin", NODE_ENV: "production" },
        // Own process group, so a timeout can take esbuild's Go child with it.
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    // Bounded: a child that prints megabytes must not become our memory problem.
    const capture = (target: "out" | "err") => (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (target === "out") stdout = (stdout + text).slice(0, 64 * 1024);
      else stderr = (stderr + text).slice(0, 8 * 1024);
    };
    child.stdout.on("data", capture("out"));
    child.stderr.on("data", capture("err"));

    const timer = setTimeout(() => {
      timedOut = true;
      // Negative pid signals the whole group. SIGKILL rather than SIGTERM: this
      // is already the failure path and a build has nothing to clean up.
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeout);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new SandboxBuildError(`the build process could not start: ${err.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        return reject(
          new SandboxBuildError(
            `the build did not finish within ${Math.round(timeout / 1000)}s and was stopped`,
          ),
        );
      }
      if (code === 0) return resolvePromise();
      reject(new SandboxBuildError(describeFailure(stdout, stderr, code)));
    });
  });
}

/**
 * Turn the child's output into one operator-readable message.
 *
 * An unresolvable bare import is the failure worth naming precisely, because it
 * has a specific cause (an extension expecting `npm install`) and a specific
 * fix, and because "Could not resolve" on its own sends people looking for a
 * typo.
 */
function describeFailure(stdout: string, stderr: string, code: number | null): string {
  let errors: string[] = [];
  try {
    const parsed = JSON.parse(stdout) as { errors?: unknown };
    if (Array.isArray(parsed.errors)) errors = parsed.errors.map((e) => String(e));
  } catch {
    // Not our JSON: an OOM kill or a crash writes to stderr instead.
  }

  const dependency = errors
    .map((text) => /Could not resolve "([^"]+)"/.exec(text))
    .find((match): match is RegExpExecArray => match !== null && !match[1]!.startsWith("."));
  if (dependency) {
    return (
      `dependency ${dependency[1]} cannot be resolved; extensions must be dependency-free or ` +
      "vendored. Nothing is installed at publish time: import node builtins, or commit the code " +
      "you need into the extension directory."
    );
  }
  if (errors.length > 0) {
    return `the build failed:\n${errors.map((text) => `  ${text}`).join("\n")}`;
  }
  // No structured errors: the child died. An OOM kill is the likely reason and
  // the one an operator can act on.
  const detail = stderr.trim().split("\n").slice(0, 3).join(" ").slice(0, 300);
  return (
    `the build process exited with code ${code ?? "unknown"} without reporting an error` +
    (detail ? `: ${detail}` : `. It may have exceeded the ${BUILD_MAX_HEAP_MB} MB memory limit.`)
  );
}
