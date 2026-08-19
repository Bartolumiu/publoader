import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createLogger } from "../../src/logging.js";
import { AuditLog, SettingsStore } from "../../src/core/store/settings.js";
import { parseMangaIdMapFile } from "../../src/core/store/bundles.js";
import { isMapSyncPush, MAP_SYNC_COMMIT_MARKER } from "../../src/core/webhooks/github.js";
import { encodeRepoPath, isSafeRepoPath, type GithubContentsClient } from "../../src/core/webhooks/repoContents.js";
import {
  DEFAULT_INDENT,
  DEFAULT_SHAPE,
  detectLayout,
  detectMapShape,
  parseMapText,
  planWrite,
  renderMapFile,
} from "../../src/core/mapsync/mapFile.js";
import {
  MapSyncService,
  MAP_SYNC_LAST_RUN_KEY,
  type MapSyncConfig,
} from "../../src/core/mapsync/service.js";

/**
 * This job commits to somebody's git repository once a week with nobody
 * watching, so the tests are mostly about what it must NOT do: rewrite a file
 * into a different shape, produce a churn commit when nothing changed, empty a
 * file because a query came back short, or answer its own commit with a bundle
 * republish.
 */

const log = createLogger("test-map-sync", "silent");

const MD_A = "aaaaaaaa-0000-4000-8000-000000000001";
const MD_B = "bbbbbbbb-0000-4000-8000-000000000002";
const MD_C = "cccccccc-0000-4000-8000-000000000003";

const row = (mangaId: string, mdMangaId: string, namespace = "") => ({ namespace, mangaId, mdMangaId });

describe("renderMapFile", () => {
  it("writes mangaplus's inverted shape, sorted and stable", () => {
    const text = renderMapFile([row("100002", MD_B), row("100001", MD_A), row("100003", MD_B)]);
    // One line per mapping, four-space indent: the way the file is written by
    // hand. Rendering each id on its own line turned 761 lines into 2565.
    expect(text).toBe(
      `{\n    "${MD_A}": ["100001"],\n    "${MD_B}": ["100002", "100003"]\n}\n`,
    );
    // Same rows in any order render byte-identically, which is what stops a
    // weekly no-op run from producing a commit.
    expect(renderMapFile([row("100003", MD_B), row("100001", MD_A), row("100002", MD_B)])).toBe(text);
  });

  it("keeps alpha_manga's forward shape when that is what the file uses", () => {
    const text = renderMapFile([row("9", MD_B), row("10", MD_A)], { nested: false, inner: "forward" });
    // Numeric-aware ordering: 9 before 10, not after it.
    expect(text).toBe(`{\n    "9": "${MD_B}",\n    "10": "${MD_A}"\n}\n`);
  });

  it("writes an array on one line however many ids it holds", () => {
    const rows = ["100003", "100120", "100141", "200020", "600002", "700006"].map((id) => row(id, MD_A));
    const text = renderMapFile(rows);
    expect(text).toBe(
      `{\n    "${MD_A}": ["100003", "100120", "100141", "200020", "600002", "700006"]\n}\n`,
    );
    // Three lines per mapping is what the bad render produced; one is the point.
    expect(text.split("\n")).toHaveLength(4);
  });

  it("indents to the width the file already uses", () => {
    const rows = [row("1", MD_A)];
    expect(renderMapFile(rows, { nested: false, inner: "forward", indent: 2 })).toBe(
      `{\n  "1": "${MD_A}"\n}\n`,
    );
    expect(renderMapFile(rows, { nested: false, inner: "forward", indent: 4 })).toBe(
      `{\n    "1": "${MD_A}"\n}\n`,
    );
  });

  it("keeps alpha_manga's right-aligned keys when the file aligns them", () => {
    const text = renderMapFile(
      [row("6000597", MD_A), row("10000372", MD_B)],
      { nested: false, inner: "forward", indent: 2, align: true },
    );
    // Every key ends in the same column; the shorter one is padded, not the
    // longer one truncated.
    expect(text).toBe(`{\n   "6000597": "${MD_A}",\n  "10000372": "${MD_B}"\n}\n`);
  });

  it("nests with the file's indent, and says an empty namespace on one line", () => {
    const text = renderMapFile([row("709", MD_A, "vizmanga")], { nested: true, inner: "forward", indent: 4 });
    expect(text).toBe(`{\n    "vizmanga": {\n        "709": "${MD_A}"\n    }\n}\n`);
  });

  it("nests a namespaced extension even when asked for a flat shape", () => {
    const text = renderMapFile(
      [row("709", MD_A, "vizmanga"), row("709", MD_B, "shonenjump")],
      { nested: false, inner: "forward" },
    );
    expect(JSON.parse(text)).toEqual({ shonenjump: { "709": MD_B }, vizmanga: { "709": MD_A } });
  });

  it("does not invent an empty namespace key for rows that have none", () => {
    // The file was nested; the rows are not. Writing `{"": {…}}` would be a
    // valid parse and a nonsense file.
    const text = renderMapFile([row("1", MD_A)], { nested: true, inner: "forward" });
    expect(JSON.parse(text)).toEqual({ "1": MD_A });
  });

  it("round-trips through the parser the platform reads these files with", () => {
    const rows = [row("709", MD_A, "vizmanga"), row("218", MD_B, "vizmanga"), row("1", MD_C, "shonenjump")];
    const parsed = parseMangaIdMapFile(JSON.parse(renderMapFile(rows, { nested: true, inner: "forward" })));
    expect(parsed.sort(byId)).toEqual(rows.sort(byId));
  });
});

describe("detectMapShape", () => {
  it("recognises each shape that exists in the wild", () => {
    expect(detectMapShape({ [MD_A]: ["1", "2"] })).toEqual({ nested: false, inner: "inverted" });
    expect(detectMapShape({ "1": MD_A })).toEqual({ nested: false, inner: "forward" });
    expect(detectMapShape({ vizmanga: { "709": MD_A } })).toEqual({ nested: true, inner: "forward" });
  });

  it("returns null for something that is not a map, so nothing is overwritten on a guess", () => {
    expect(detectMapShape([])).toBeNull();
    expect(detectMapShape({})).toBeNull();
    expect(parseMapText("not json").shape).toBeNull();
  });
});

/**
 * The layout is read from the text because `JSON.parse` has already lost it,
 * and getting it wrong is what turns a seven-mapping change into a diff that
 * replaces every line of the file.
 */
describe("detectLayout", () => {
  it("reads mangaplus: four spaces, keys not aligned", () => {
    const text = `{\n    "${MD_A}": ["100001"],\n    "${MD_B}": ["100002"]\n}\n`;
    expect(detectLayout(text, false)).toEqual({ indent: 4, align: false });
  });

  it("reads alpha_manga: keys right-aligned to a common column", () => {
    const text = `{\n   "6000597": "${MD_A}",\n  "10000372": "${MD_B}"\n}\n`;
    expect(detectLayout(text, false)).toEqual({ indent: 2, align: true });
  });

  it("reads viz: one level is four spaces even though the entries sit at eight", () => {
    const text = `{\n    "vizmanga": {\n        "709": "${MD_A}"\n    }\n}\n`;
    expect(detectLayout(text, true)).toEqual({ indent: 4, align: false });
  });

  it("does not call a nested file aligned, whatever its columns happen to do", () => {
    // The leading runs differ here only because of nesting, which is not
    // alignment; reading it as alignment would pad every key in the file.
    const text = `{\n    "ns": {\n        "70": "${MD_A}"\n    }\n}\n`;
    expect(detectLayout(text, true).align).toBe(false);
  });

  it("falls back to the default for a file with no key lines to learn from", () => {
    expect(detectLayout("{}\n", false)).toEqual({ indent: DEFAULT_INDENT, align: false });
  });

  it("carries the layout onto the shape parseMapText returns", () => {
    const text = `{\n  "1": "${MD_A}",\n  "2": "${MD_B}"\n}\n`;
    expect(parseMapText(text).shape).toEqual({
      nested: false,
      inner: "forward",
      indent: 2,
      align: false,
    });
  });

  /**
   * The property that matters most: a file the sync has no change to make to
   * comes back byte-identical, so the run makes no commit at all. This is what
   * the old renderer broke, and a round trip is the only honest way to state it.
   */
  it("round-trips a file it has nothing to change byte for byte", () => {
    for (const original of [
      `{\n    "${MD_A}": ["100001", "200008"],\n    "${MD_B}": ["100002"]\n}\n`,
      `{\n   "6000597": "${MD_A}",\n  "10000372": "${MD_B}"\n}\n`,
      `{\n    "vizmanga": {\n        "218": "${MD_A}",\n        "709": "${MD_B}"\n    }\n}\n`,
    ]) {
      const { rows, shape } = parseMapText(original);
      expect(renderMapFile(rows, shape!)).toBe(original);
    }
  });
});

describe("planWrite", () => {
  const current = (rows: ReturnType<typeof row>[], shape = DEFAULT_SHAPE) => ({
    text: renderMapFile(rows, shape),
    rows,
  });

  it("makes no commit when the file already says what the database says", () => {
    const rows = [row("1", MD_A), row("2", MD_B)];
    expect(planWrite(current(rows), { text: renderMapFile(rows), rows })).toMatchObject({
      action: "unchanged",
      added: 0,
      removed: 0,
    });
  });

  it("writes, and counts both directions, when the map moved on", () => {
    const before = [row("1", MD_A)];
    const after = [row("1", MD_A), row("2", MD_B)];
    expect(planWrite(current(before), { text: renderMapFile(after), rows: after })).toEqual({
      action: "write",
      added: 1,
      removed: 0,
    });
  });

  it("does not create a file that is not in the repo", () => {
    const rows = [row("1", MD_A)];
    const plan = planWrite(null, { text: renderMapFile(rows), rows });
    expect(plan.action).toBe("skipped");
    expect(plan.reason).toMatch(/not in the repo/);
  });

  it("refuses to empty a file when the database has nothing for the extension", () => {
    const plan = planWrite(current([row("1", MD_A)]), { text: renderMapFile([]), rows: [] });
    expect(plan.action).toBe("refused");
    expect(plan.reason).toMatch(/refusing to empty/);
  });

  it("refuses a write that would delete more than half the mappings", () => {
    const before = Array.from({ length: 10 }, (_, i) => row(String(i), MD_A));
    const after = before.slice(0, 3);
    const plan = planWrite(current(before), { text: renderMapFile(after), rows: after });
    expect(plan.action).toBe("refused");
    expect(plan.removed).toBe(7);
    // …and an operator who means it can say so.
    expect(
      planWrite(current(before), { text: renderMapFile(after), rows: after }, { force: true }).action,
    ).toBe("write");
  });

  it("allows a small shrink, because untracking one series is routine", () => {
    const before = Array.from({ length: 10 }, (_, i) => row(String(i), MD_A));
    const after = before.slice(0, 9);
    expect(planWrite(current(before), { text: renderMapFile(after), rows: after })).toMatchObject({
      action: "write",
      removed: 1,
    });
  });
});

describe("isMapSyncPush", () => {
  const commit = (message: string) => ({ message, modified: ["src/mangaplus/manga_id_map.json"] });

  it("recognises a push that is entirely our own commits", () => {
    expect(isMapSyncPush({ commits: [commit(`chore(mangaplus): sync ${MAP_SYNC_COMMIT_MARKER}`)] })).toBe(true);
  });

  it("publishes a push that also carries a human's commit", () => {
    expect(
      isMapSyncPush({
        commits: [commit(`chore(mangaplus): sync ${MAP_SYNC_COMMIT_MARKER}`), commit("fix parser")],
      }),
    ).toBe(false);
  });

  it("publishes when there is nothing to judge", () => {
    expect(isMapSyncPush({})).toBe(false);
    expect(isMapSyncPush({ commits: [] })).toBe(false);
    expect(isMapSyncPush({ commits: [{ modified: ["src/mangaplus/index.ts"] }] })).toBe(false);
  });
});

describe("repo paths", () => {
  it("keeps the hierarchy while escaping each segment", () => {
    expect(encodeRepoPath("src/mangaplus/manga_id_map.json")).toBe("src/mangaplus/manga_id_map.json");
    expect(encodeRepoPath("src/a b/c.json")).toBe("src/a%20b/c.json");
  });

  it("rejects a manifest data-file path that could escape the extension directory", () => {
    expect(isSafeRepoPath("src/mangaplus/manga_id_map.json")).toBe(true);
    expect(isSafeRepoPath("../../.github/workflows/release.yml")).toBe(false);
    expect(isSafeRepoPath("/etc/passwd")).toBe(false);
    expect(isSafeRepoPath("src/x/..\\y.json")).toBe(false);
    expect(isSafeRepoPath("")).toBe(false);
  });
});

// --- the service, against a GitHub that lives in this process ---------------

interface FakeRepo {
  files: Map<string, string>;
  dirs: string[];
}

function fakeGithub(repos: Record<string, FakeRepo>) {
  const writes: { repo: string; path: string; text: string; message: string; sha?: string }[] = [];
  const client: GithubContentsClient = {
    async listDirs(_cfg, repo) {
      const found = repos[repo];
      if (!found) throw new Error(`no such repo ${repo}`);
      return found.dirs;
    },
    async getFile(_cfg, repo, path) {
      const text = repos[repo]?.files.get(path);
      return text === undefined ? null : { path, sha: `sha-${path}`, text };
    },
    async putFile(_cfg, repo, req) {
      writes.push({ repo, ...req });
      repos[repo]!.files.set(req.path, req.text);
      return { path: req.path, commit: "0".repeat(40) };
    },
  };
  return { client, writes };
}

/**
 * The two tables this job reads plus the settings row it schedules itself with.
 * A real Prisma is integration-test territory; the decisions worth testing here
 * are the ones above and the wiring between them.
 */
function fakePrisma(opts: {
  tracked: { extension: string; namespace: string; mangaId: string; mdMangaId: string }[];
  bundles?: { extension: string; manifest: unknown }[];
  settings?: Record<string, string>;
}) {
  const settings = new Map(Object.entries(opts.settings ?? {}));
  return {
    settings,
    prisma: {
      trackedManga: {
        findMany: async ({ where }: { where?: { extension?: { in: string[] } } } = {}) =>
          opts.tracked.filter((t) => !where?.extension || where.extension.in.includes(t.extension)),
      },
      bundle: {
        findMany: async () =>
          (opts.bundles ?? []).map((b, i) => ({
            ...b,
            id: String(i),
            version: "1.0.0",
            sha256: "x",
            yanked: false,
            publishedAt: new Date(),
          })),
      },
      setting: {
        findUnique: async ({ where }: { where: { key: string } }) =>
          settings.has(where.key) ? { key: where.key, value: settings.get(where.key)! } : null,
        create: async ({ data }: { data: { key: string; value: string } }) => {
          if (settings.has(data.key)) throw new Error("unique violation");
          settings.set(data.key, data.value);
          return data;
        },
        updateMany: async ({
          where,
          data,
        }: {
          where: { key: string; value: string };
          data: { value: string };
        }) => {
          if (settings.get(where.key) !== where.value) return { count: 0 };
          settings.set(where.key, data.value);
          return { count: 1 };
        },
        upsert: async ({ where, create }: { where: { key: string }; create: { key: string; value: string } }) => {
          settings.set(where.key, create.value);
          return create;
        },
        deleteMany: async ({ where }: { where: { key: string } }) => {
          settings.delete(where.key);
          return { count: 1 };
        },
      },
      auditEvent: { create: async () => ({}) },
    } as unknown as PrismaClient,
  };
}

const service = (
  prisma: PrismaClient,
  contents: GithubContentsClient,
  overrides: Partial<MapSyncConfig> = {},
  now = () => Date.parse("2026-08-05T00:00:00Z"),
) =>
  new MapSyncService(
    {
      enabled: true,
      intervalHours: 168,
      owner: "publoader",
      apiUrl: "https://api.github.com",
      token: "gh-token",
      repos: ["publoader-extensions"],
      ...overrides,
    },
    {
      prisma,
      log,
      audit: new AuditLog(prisma),
      settings: new SettingsStore(prisma),
      contents,
      now,
    },
  );

describe("MapSyncService.sync", () => {
  it("commits the database's map into the extension's existing file", async () => {
    const { client, writes } = fakeGithub({
      "publoader-extensions": {
        dirs: ["mangaplus", "viz"],
        files: new Map([["src/mangaplus/manga_id_map.json", `{"${MD_A}": ["100001"]}`]]),
      },
    });
    const { prisma } = fakePrisma({
      tracked: [
        { extension: "mangaplus", namespace: "", mangaId: "100001", mdMangaId: MD_A },
        { extension: "mangaplus", namespace: "", mangaId: "100002", mdMangaId: MD_B },
      ],
    });

    const report = await service(prisma, client).sync();
    expect(report.written).toBe(1);
    expect(report.outcomes[0]).toMatchObject({
      extension: "mangaplus",
      status: "write",
      repo: "publoader-extensions",
      path: "src/mangaplus/manga_id_map.json",
      added: 1,
      removed: 0,
    });
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!.text)).toEqual({ [MD_A]: ["100001"], [MD_B]: ["100002"] });
    // The marker is what stops this commit from triggering a republish.
    expect(writes[0]!.message).toContain(MAP_SYNC_COMMIT_MARKER);
    expect(writes[0]!.sha).toBe("sha-src/mangaplus/manga_id_map.json");
  });

  it("makes no commit at all when the file already matches", async () => {
    const canonical = renderMapFile([{ namespace: "", mangaId: "100001", mdMangaId: MD_A }]);
    const { client, writes } = fakeGithub({
      "publoader-extensions": {
        dirs: ["mangaplus"],
        files: new Map([["src/mangaplus/manga_id_map.json", canonical]]),
      },
    });
    const { prisma } = fakePrisma({
      tracked: [{ extension: "mangaplus", namespace: "", mangaId: "100001", mdMangaId: MD_A }],
    });

    const report = await service(prisma, client).sync();
    expect(report.outcomes[0]!.status).toBe("unchanged");
    expect(writes).toHaveLength(0);
  });

  it("uses the path the manifest names for its map", async () => {
    const { client, writes } = fakeGithub({
      "publoader-extensions": {
        dirs: ["viz"],
        files: new Map([["src/viz/data/ids.json", `{"vizmanga": {"1": "${MD_C}"}}`]]),
      },
    });
    const { prisma } = fakePrisma({
      tracked: [{ extension: "viz", namespace: "vizmanga", mangaId: "709", mdMangaId: MD_A }],
      bundles: [
        {
          extension: "viz",
          manifest: {
            name: "viz",
            version: "1.0.0",
            publoader_api: "^2.0.0",
            runtime: "node",
            entrypoint: "index.mjs",
            mangadex_group_id: "dddddddd-0000-4000-8000-000000000004",
            languages: ["en"],
            allowed_hosts: ["www.viz.com"],
            data_files: { manga_id_map: "data/ids.json" },
          },
        },
      ],
    });

    const report = await service(prisma, client).sync();
    expect(report.outcomes[0]).toMatchObject({ status: "write", path: "src/viz/data/ids.json" });
    // viz's file is nested+forward, and stays that way.
    expect(JSON.parse(writes[0]!.text)).toEqual({ vizmanga: { "709": MD_A } });
  });

  it("writes nothing on a dry run but reports what it would do", async () => {
    const { client, writes } = fakeGithub({
      "publoader-extensions": {
        dirs: ["mangaplus"],
        files: new Map([["src/mangaplus/manga_id_map.json", "{}"]]),
      },
    });
    const { prisma } = fakePrisma({
      tracked: [{ extension: "mangaplus", namespace: "", mangaId: "1", mdMangaId: MD_A }],
    });

    const report = await service(prisma, client).sync({ dryRun: true });
    expect(report.outcomes[0]).toMatchObject({ status: "write", detail: "would write" });
    expect(writes).toHaveLength(0);
  });

  it("refuses to guess when two repos both have the extension", async () => {
    const { client, writes } = fakeGithub({
      "publoader-extensions": {
        dirs: ["mangaplus"],
        files: new Map([["src/mangaplus/manga_id_map.json", "{}"]]),
      },
      "publoader-extensions-private": {
        dirs: ["mangaplus"],
        files: new Map([["src/mangaplus/manga_id_map.json", "{}"]]),
      },
    });
    const { prisma } = fakePrisma({
      tracked: [{ extension: "mangaplus", namespace: "", mangaId: "1", mdMangaId: MD_A }],
    });

    const report = await service(prisma, client, {
      repos: ["publoader-extensions", "publoader-extensions-private"],
    }).sync();
    expect(report.outcomes[0]!.status).toBe("skipped");
    expect(report.outcomes[0]!.detail).toMatch(/more than one repo/);
    expect(writes).toHaveLength(0);
  });

  it("keeps going when one extension's file cannot be read", async () => {
    const { client, writes } = fakeGithub({
      "publoader-extensions": {
        dirs: ["broken", "mangaplus"],
        files: new Map([["src/mangaplus/manga_id_map.json", "{}"]]),
      },
    });
    const failing: GithubContentsClient = {
      ...client,
      getFile: async (cfg, repo, path) => {
        if (path.startsWith("src/broken/")) throw new Error("GitHub is having a day");
        return client.getFile(cfg, repo, path);
      },
    };
    const { prisma } = fakePrisma({
      tracked: [
        { extension: "broken", namespace: "", mangaId: "1", mdMangaId: MD_A },
        { extension: "mangaplus", namespace: "", mangaId: "2", mdMangaId: MD_B },
      ],
    });

    const report = await service(prisma, failing).sync();
    expect(report.failed).toBe(1);
    expect(report.written).toBe(1);
    expect(writes.map((w) => w.path)).toEqual(["src/mangaplus/manga_id_map.json"]);
  });

  it("does nothing when it has no token to write with", async () => {
    const { client, writes } = fakeGithub({
      "publoader-extensions": { dirs: ["mangaplus"], files: new Map() },
    });
    const { prisma } = fakePrisma({
      tracked: [{ extension: "mangaplus", namespace: "", mangaId: "1", mdMangaId: MD_A }],
    });
    const svc = service(prisma, client, { token: undefined });

    expect(svc.unavailableReason()).toMatch(/GITHUB_TOKEN/);
    const report = await svc.sync();
    expect(report.skippedReason).toMatch(/GITHUB_TOKEN/);
    expect(writes).toHaveLength(0);
  });
});

describe("MapSyncService.runIfDue", () => {
  const github = () =>
    fakeGithub({
      "publoader-extensions": {
        dirs: ["mangaplus"],
        files: new Map([["src/mangaplus/manga_id_map.json", "{}"]]),
      },
    });
  const tracked = [{ extension: "mangaplus", namespace: "", mangaId: "1", mdMangaId: MD_A }];
  const T0 = Date.parse("2026-08-05T00:00:00Z");

  it("arms itself on the first run and syncs nothing, so a deploy makes no commits", async () => {
    const { client, writes } = github();
    const { prisma, settings } = fakePrisma({ tracked });

    expect(await service(prisma, client, {}, () => T0).runIfDue()).toBeNull();
    expect(writes).toHaveLength(0);
    expect(settings.get(MAP_SYNC_LAST_RUN_KEY)).toBe(new Date(T0).toISOString());
  });

  it("stays quiet until the interval has passed, then syncs", async () => {
    const { client, writes } = github();
    const { prisma, settings } = fakePrisma({
      tracked,
      settings: { [MAP_SYNC_LAST_RUN_KEY]: new Date(T0).toISOString() },
    });

    const sixDays = T0 + 6 * 86_400_000;
    expect(await service(prisma, client, {}, () => sixDays).runIfDue()).toBeNull();
    expect(writes).toHaveLength(0);

    const eightDays = T0 + 8 * 86_400_000;
    const report = await service(prisma, client, {}, () => eightDays).runIfDue();
    expect(report?.written).toBe(1);
    expect(settings.get(MAP_SYNC_LAST_RUN_KEY)).toBe(new Date(eightDays).toISOString());
  });

  it("lets only one replica run: the slot is claimed before the work", async () => {
    const { client, writes } = github();
    const { prisma } = fakePrisma({
      tracked,
      settings: { [MAP_SYNC_LAST_RUN_KEY]: new Date(T0).toISOString() },
    });
    const due = T0 + 8 * 86_400_000;

    const [a, b] = await Promise.all([
      service(prisma, client, {}, () => due).runIfDue(),
      service(prisma, client, {}, () => due).runIfDue(),
    ]);
    expect([a, b].filter((r) => r !== null)).toHaveLength(1);
    expect(writes).toHaveLength(1);
  });

  it("does not sync while the platform is paused", async () => {
    const { client, writes } = github();
    const { prisma } = fakePrisma({
      tracked,
      settings: {
        [MAP_SYNC_LAST_RUN_KEY]: new Date(T0).toISOString(),
        pause_until: "inf",
      },
    });

    expect(await service(prisma, client, {}, () => T0 + 8 * 86_400_000).runIfDue()).toBeNull();
    expect(writes).toHaveLength(0);
  });
});

const byId = (a: { mangaId: string }, b: { mangaId: string }) => (a.mangaId < b.mangaId ? -1 : 1);
