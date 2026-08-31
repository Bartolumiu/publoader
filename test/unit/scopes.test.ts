import { describe, expect, it } from "vitest";
import {
  SCOPES,
  SCOPE_PRESETS,
  hasScope,
  isScope,
  parseScopes,
  scopesForRole,
  type Principal,
} from "../../src/core/api/scopes.js";

const principal = (scopes: string[]): Principal => ({
  kind: "api-token",
  name: "token:test",
  scopes,
});

describe("hasScope", () => {
  it("grants everything to the wildcard", () => {
    const root = principal(["*"]);
    for (const scope of SCOPES) expect(hasScope(root, scope)).toBe(true);
  });

  it("grants only what is held", () => {
    const p = principal(["runs:write", "stats:read"]);
    expect(hasScope(p, "runs:write")).toBe(true);
    expect(hasScope(p, "stats:read")).toBe(true);
    expect(hasScope(p, "workers:write")).toBe(false);
    expect(hasScope(p, "bundles:write")).toBe(false);
    expect(hasScope(p, "users:admin")).toBe(false);
  });

  it("lets write imply read within the same area only", () => {
    const p = principal(["runs:write"]);
    expect(hasScope(p, "runs:read")).toBe(true);
    expect(hasScope(p, "workers:read")).toBe(false);
  });

  it("does not let users:admin imply anything else", () => {
    const p = principal(["users:admin"]);
    expect(hasScope(p, "users:admin")).toBe(true);
    expect(hasScope(p, "bundles:write")).toBe(false);
    expect(hasScope(p, "runs:read")).toBe(false);
  });

  it("holds no scope when the list is empty", () => {
    const p = principal([]);
    for (const scope of SCOPES) expect(hasScope(p, scope)).toBe(false);
  });
});

describe("parseScopes", () => {
  it("rejects unknown scopes and typos rather than silently dropping them", () => {
    const { scopes, invalid } = parseScopes(["runs:write", "run:write", "nonsense"]);
    expect(scopes).toEqual(["runs:write"]);
    expect(invalid).toEqual(["run:write", "nonsense"]);
  });

  it("accepts the wildcard and de-duplicates", () => {
    expect(parseScopes(["*", "*", "runs:read"])).toEqual({
      scopes: ["*", "runs:read"],
      invalid: [],
    });
  });
});

describe("scopesForRole", () => {
  it("gives owners the wildcard", () => {
    expect(scopesForRole("OWNER")).toEqual(["*"]);
  });

  it("withholds account administration from plain admins", () => {
    const admin = principal(scopesForRole("ADMIN"));
    expect(hasScope(admin, "runs:write")).toBe(true);
    expect(hasScope(admin, "bundles:write")).toBe(true);
    expect(hasScope(admin, "users:admin")).toBe(false);
  });
});

describe("presets", () => {
  it("are all valid scopes (a bad preset would mint a broken token)", () => {
    for (const [name, scopes] of Object.entries(SCOPE_PRESETS)) {
      for (const scope of scopes) {
        expect(isScope(scope), `${name} lists invalid scope ${scope}`).toBe(true);
      }
    }
  });

  it("keep the bot away from credential and bundle management", () => {
    const bot = principal(SCOPE_PRESETS["discord-bot"]!);
    expect(hasScope(bot, "runs:write")).toBe(true);
    expect(hasScope(bot, "users:admin")).toBe(false);
    expect(hasScope(bot, "bundles:write")).toBe(false);
    expect(hasScope(bot, "workers:write")).toBe(false);
  });

  it("lets the bot curate the series map by adding, and not by repointing", () => {
    // /tracked list and /tracked set have been bot commands since it shipped;
    // a preset without these two answered 403 to both. `tracked:write` stays
    // out: adding a mapping is reversible and visible, moving one is neither.
    const bot = principal(SCOPE_PRESETS["discord-bot"]!);
    expect(hasScope(bot, "tracked:read")).toBe(true);
    expect(hasScope(bot, "tracked:append")).toBe(true);
    expect(hasScope(bot, "tracked:write")).toBe(false);
    // /untracked map needs both halves: it writes the map and closes the row.
    expect(hasScope(bot, "untracked:write")).toBe(true);
  });
});
