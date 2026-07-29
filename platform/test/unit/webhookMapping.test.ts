import { describe, expect, it } from "vitest";
import {
  changedExtensions,
  roleForPush,
  type GithubWebhookConfig,
  type PushPayload,
} from "../../src/core/webhooks/github.js";
import { parseRepoList } from "../../src/core/api/routes/webhooks.js";

const cfg: GithubWebhookConfig = {
  secret: "irrelevant-here-but-realistic",
  owner: "publoader",
  extensionsRepos: ["publoader-extensions", "publoader-extensions-private"],
  coreRepo: "publoader",
};

const SHA = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";

function push(overrides: Partial<PushPayload> = {}): PushPayload {
  return {
    ref: "refs/heads/main",
    after: SHA,
    repository: {
      name: "publoader-extensions",
      full_name: "publoader/publoader-extensions",
      default_branch: "main",
    },
    ...overrides,
  };
}

describe("roleForPush", () => {
  it("maps both extensions repos to the extensions role", () => {
    for (const name of ["publoader-extensions", "publoader-extensions-private"]) {
      const decision = roleForPush(
        push({ repository: { name, full_name: `publoader/${name}`, default_branch: "main" } }),
        cfg,
      );
      expect(decision).toEqual({ role: "extensions", repo: name, after: SHA });
    }
  });

  it("maps the core repo to the core role", () => {
    const decision = roleForPush(
      push({
        repository: { name: "publoader", full_name: "publoader/publoader", default_branch: "main" },
      }),
      cfg,
    );
    expect(decision).toMatchObject({ role: "core", repo: "publoader" });
  });

  it("ignores an untracked repo and names it", () => {
    const decision = roleForPush(
      push({
        repository: { name: "dotfiles", full_name: "publoader/dotfiles", default_branch: "main" },
      }),
      cfg,
    );
    expect(decision).toEqual({ role: null, reason: "untracked repo 'dotfiles'" });
  });

  it("ignores a fork of a tracked repo (owner mismatch)", () => {
    // The whole point: a repo *named* publoader-extensions under someone else's
    // account must not be able to publish into this deployment.
    const decision = roleForPush(
      push({
        repository: {
          name: "publoader-extensions",
          full_name: "attacker/publoader-extensions",
          default_branch: "main",
        },
      }),
      cfg,
    );
    expect(decision).toEqual({ role: null, reason: "owner mismatch" });
  });

  it("compares the owner case-insensitively", () => {
    const decision = roleForPush(
      push({
        repository: {
          name: "publoader-extensions",
          full_name: "PubLoader/publoader-extensions",
          default_branch: "main",
        },
      }),
      { ...cfg, owner: "PUBLOADER" },
    );
    expect(decision).toMatchObject({ role: "extensions" });
  });

  it("ignores a push to a non-default branch", () => {
    const decision = roleForPush(push({ ref: "refs/heads/feature/wip" }), cfg);
    expect(decision).toEqual({ role: null, reason: "ignored ref refs/heads/feature/wip" });
  });

  it("ignores a tag push", () => {
    const decision = roleForPush(push({ ref: "refs/tags/v1.2.3" }), cfg);
    expect(decision).toEqual({ role: null, reason: "ignored ref refs/tags/v1.2.3" });
  });

  it("honours a repo whose default branch is not main", () => {
    const decision = roleForPush(
      push({
        ref: "refs/heads/master",
        repository: {
          name: "publoader-extensions",
          full_name: "publoader/publoader-extensions",
          default_branch: "master",
        },
      }),
      cfg,
    );
    expect(decision).toMatchObject({ role: "extensions" });
  });

  it("ignores a payload with no repository", () => {
    expect(roleForPush({ ref: "refs/heads/main", after: SHA }, cfg)).toEqual({
      role: null,
      reason: "payload has no repository.name",
    });
  });

  it("ignores a push whose commit sha is missing or malformed", () => {
    const malformed: (string | undefined)[] = [
      undefined,
      "",
      "HEAD",
      "1a2b3c4",
      `${SHA}extra`,
      SHA.toUpperCase(),
    ];
    for (const after of malformed) {
      const decision = roleForPush(push({ after }), cfg);
      expect(decision).toEqual({
        role: null,
        reason: "payload has no usable commit sha in 'after'",
      });
    }
  });

  it("treats an unset core repo as untracked rather than matching everything", () => {
    const decision = roleForPush(
      push({
        repository: { name: "publoader", full_name: "publoader/publoader", default_branch: "main" },
      }),
      { ...cfg, coreRepo: undefined },
    );
    expect(decision).toEqual({ role: null, reason: "untracked repo 'publoader'" });
  });
});

describe("changedExtensions", () => {
  it("collects extensions across multiple commits and all three change kinds", () => {
    const payload: PushPayload = push({
      commits: [
        {
          added: ["src/mangaplus/helpers.ts"],
          modified: ["README.md", ".github/workflows/ci.yml"],
          removed: [],
        },
        {
          added: [],
          modified: ["src/viz/index.ts", "src/viz/manga_id_map.json"],
          removed: ["src/mangaplus/dead_code.ts"],
        },
      ],
    });
    expect(changedExtensions(payload)).toEqual(["mangaplus", "viz"]);
  });

  it("ignores paths outside src/", () => {
    const payload = push({
      commits: [
        {
          added: ["schedule.json", "tools/sync.py", "docs/src/mangaplus/notes.md"],
          modified: ["package.json"],
          removed: ["LICENSE"],
        },
      ],
    });
    expect(changedExtensions(payload)).toEqual([]);
  });

  it("ignores a file sitting directly in src/ with no extension directory", () => {
    const payload = push({ commits: [{ modified: ["src/README.md", "src/index.ts"] }] });
    expect(changedExtensions(payload)).toEqual([]);
  });

  it("reads head_commit too, so a truncated commit list cannot hide an extension", () => {
    // GitHub caps `commits` at 20 entries on a large push but always sends
    // head_commit; missing an extension here would silently ship stale code.
    const payload = push({
      commits: [{ modified: ["src/alpha_manga/index.ts"] }],
      head_commit: { added: ["src/k_manga/index.ts"], modified: [], removed: [] },
    });
    expect(changedExtensions(payload)).toEqual(["alpha_manga", "k_manga"]);
  });

  it("deduplicates an extension touched by several commits", () => {
    const payload = push({
      commits: [
        { modified: ["src/mangaplus/a.ts"] },
        { modified: ["src/mangaplus/b.ts"] },
        { added: ["src/mangaplus/c.ts"] },
      ],
      head_commit: { modified: ["src/mangaplus/c.ts"] },
    });
    expect(changedExtensions(payload)).toEqual(["mangaplus"]);
  });

  it("rejects directory names the manifest schema would not accept", () => {
    const payload = push({
      commits: [
        { modified: ["src/Bad-Name/index.ts", "src/UPPER/index.ts", "src/ok_one/index.ts"] },
      ],
    });
    expect(changedExtensions(payload)).toEqual(["ok_one"]);
  });

  it("survives a payload with no commits at all", () => {
    expect(changedExtensions(push())).toEqual([]);
    expect(changedExtensions(push({ commits: [], head_commit: null }))).toEqual([]);
  });
});

describe("parseRepoList", () => {
  it("splits on commas and whitespace and drops blanks", () => {
    expect(parseRepoList("a,b , c\nd")).toEqual(["a", "b", "c", "d"]);
    expect(parseRepoList("")).toEqual([]);
    expect(parseRepoList("  ,, ")).toEqual([]);
  });
});
