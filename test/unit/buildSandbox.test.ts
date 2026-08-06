import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInSandbox, SandboxBuildError } from "../../src/core/sysops/buildSandbox.js";

/**
 * The subprocess esbuild runs in.
 *
 * esbuild does not execute the code it bundles, so this is not a sandbox for
 * arbitrary execution; it is a bound on a step that READS attacker-supplied
 * source inside the control plane. The tests are therefore about the four things
 * that bound: no environment, no dependency resolution, no on-disk tsconfig, and
 * a wall clock.
 *
 * The tsconfig case is a regression test for a real vulnerability, not a
 * hypothetical: with esbuild's defaults, a two-line `tsconfig.json` shipped
 * inside an extension directory mapped an import onto an ABSOLUTE path and
 * esbuild inlined that file into the published bundle; which every enrolled
 * worker can then download. `tsconfigRaw` is what closes it.
 */

const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-build-test-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const FACTORY = "export default () => ({ async collect() { return { chapters: [] }; } });\n";

describe("buildInSandbox", () => {
  it("builds TypeScript sources into one ESM file", async () => {
    const root = scratch();
    writeFileSync(join(root, "index.ts"), `import { hi } from "./helper.js";\n${FACTORY}export const greeting = hi;\n`);
    writeFileSync(join(root, "helper.ts"), 'export const hi = "hello";\n');
    const out = join(scratch(), "index.mjs");

    await buildInSandbox({ root, entry: "index.ts", outFile: out });

    const built = readFileSync(out, "utf8");
    expect(built).toContain("hello");
    expect(built).toContain("collect");
    // The helper was inlined rather than left as an import: a bundle is one file.
    expect(built).not.toContain('from "./helper');
  });

  it("names the dependency when an import cannot be resolved", async () => {
    const root = scratch();
    writeFileSync(join(root, "index.ts"), 'import pad from "left-pad";\nexport default () => pad;\n');
    await expect(
      buildInSandbox({ root, entry: "index.ts", outFile: join(scratch(), "index.mjs") }),
    ).rejects.toThrow(/dependency left-pad cannot be resolved/);
  });

  it("does not report a relative import as a missing dependency", async () => {
    const root = scratch();
    writeFileSync(join(root, "index.ts"), 'import x from "./gone.js";\nexport default () => x;\n');
    const error = await buildInSandbox({
      root,
      entry: "index.ts",
      outFile: join(scratch(), "index.mjs"),
    }).catch((err: Error) => err);
    expect(error).toBeInstanceOf(SandboxBuildError);
    expect((error as Error).message).not.toMatch(/dependency .* cannot be resolved/);
    expect((error as Error).message).toMatch(/the build failed/);
  });

  it("ignores a tsconfig.json in the extension, which could otherwise read any file", async () => {
    // The vulnerability, as a test. `paths` may be absolute, and esbuild's
    // default behaviour is to honour a tsconfig it finds next to the sources.
    const secretDir = scratch();
    const secret = join(secretDir, "stolen.js");
    writeFileSync(secret, 'export const value = "SENTINEL_DATABASE_URL";\n');

    const root = scratch();
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { secrets: [secret] } } }),
    );
    writeFileSync(join(root, "index.ts"), 'import { value } from "secrets";\nexport default () => value;\n');
    const out = join(scratch(), "index.mjs");

    const error = await buildInSandbox({ root, entry: "index.ts", outFile: out }).catch(
      (err: Error) => err,
    );

    // The mapped import does not resolve, so the build fails…
    expect(error).toBeInstanceOf(SandboxBuildError);
    // …and above all, nothing was written containing the file it pointed at.
    if (existsSync(out)) {
      expect(readFileSync(out, "utf8")).not.toContain("SENTINEL_DATABASE_URL");
    }
  });

  it("never runs a package manager, so a postinstall script stays inert", async () => {
    // The only real guarantee that a lifecycle script cannot run is that no code
    // path from here invokes npm/pnpm/yarn at all. This proves the consequence:
    // a package.json whose postinstall would create a file leaves no file.
    const root = scratch();
    const sentinel = join(scratch(), "postinstall-ran.txt");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "hostile",
        version: "1.0.0",
        main: "index.ts",
        scripts: {
          build: "true",
          postinstall: `node -e "require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')"`,
          prepare: `node -e "require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')"`,
        },
      }),
    );
    writeFileSync(join(root, "index.ts"), FACTORY);

    await buildInSandbox({ root, entry: "index.ts", outFile: join(scratch(), "index.mjs") });

    expect(existsSync(sentinel)).toBe(false);
  });

  it("does not inherit the environment, so NODE_PATH cannot widen resolution", async () => {
    // A readable proxy for "the child gets none of our env": esbuild resolves
    // bare imports through NODE_PATH when it is set in ITS environment. With the
    // env inherited this build would succeed; with an explicit minimal env the
    // import cannot resolve. The same isolation is what keeps DATABASE_URL,
    // ADMIN_TOKEN and the MangaDex credentials out of the build.
    const modules = scratch();
    mkdirSync(join(modules, "sneaky"), { recursive: true });
    writeFileSync(
      join(modules, "sneaky", "package.json"),
      JSON.stringify({ name: "sneaky", version: "1.0.0", main: "index.js" }),
    );
    writeFileSync(join(modules, "sneaky", "index.js"), 'module.exports = "resolved";\n');

    const root = scratch();
    writeFileSync(join(root, "index.ts"), 'import x from "sneaky";\nexport default () => x;\n');

    const previous = process.env["NODE_PATH"];
    process.env["NODE_PATH"] = modules;
    try {
      await expect(
        buildInSandbox({ root, entry: "index.ts", outFile: join(scratch(), "index.mjs") }),
      ).rejects.toThrow(/dependency sneaky cannot be resolved/);
    } finally {
      if (previous === undefined) delete process.env["NODE_PATH"];
      else process.env["NODE_PATH"] = previous;
    }
  });

  it("stops a build that runs past its timeout", async () => {
    const root = scratch();
    writeFileSync(join(root, "index.ts"), FACTORY);
    // 1ms cannot even start a node process, so this exercises the kill path
    // deterministically rather than relying on a pathological input.
    await expect(
      buildInSandbox({
        root,
        entry: "index.ts",
        outFile: join(scratch(), "index.mjs"),
        timeoutMs: 1,
      }),
    ).rejects.toThrow(/did not finish within/);
  });

  it("reports a missing entry point as a build failure rather than hanging", async () => {
    const root = scratch();
    await expect(
      buildInSandbox({ root, entry: "index.ts", outFile: join(scratch(), "index.mjs") }),
    ).rejects.toThrow(SandboxBuildError);
  });
});
