import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROLE_SCOPES,
  SCOPES,
  SCOPE_DESCRIPTIONS,
  TUNABLE_ROLES,
  effectiveScopes,
  expandScopes,
  hasScope,
  isTunableRole,
  scopesForRole,
  type Principal,
} from "../../src/core/api/scopes.js";

const principal = (scopes: string[]): Principal => ({
  kind: "session",
  name: "user:test",
  scopes,
});

describe("expandScopes", () => {
  it("materialises the wildcard into the whole taxonomy", () => {
    expect(expandScopes(["*"]).sort()).toEqual([...SCOPES].sort());
  });

  it("carries the implied read along with a write", () => {
    expect(expandScopes(["runs:write"]).sort()).toEqual(["runs:read", "runs:write"]);
  });

  it("expands append into its read, and write into both", () => {
    expect(expandScopes(["tracked:append"]).sort()).toEqual(["tracked:append", "tracked:read"]);
    expect(expandScopes(["tracked:write"]).sort()).toEqual([
      "tracked:append",
      "tracked:read",
      "tracked:write",
    ]);
  });

  it("drops unknown strings rather than inventing scopes", () => {
    expect(expandScopes(["nonsense", "run:write"])).toEqual([]);
  });
});

describe("effectiveScopes", () => {
  it("is the baseline when nothing is tuned", () => {
    expect(effectiveScopes(["runs:write"])).toEqual(["runs:write"]);
  });

  it("keeps the wildcard intact when nothing is denied", () => {
    // Not expanded: an owner must keep holding scopes that do not exist yet.
    expect(effectiveScopes(["*"], [], [])).toEqual(["*"]);
  });

  it("widens the baseline with per-account grants", () => {
    const p = principal(effectiveScopes(scopesForRole("CONTRIBUTOR"), ["runs:read"]));
    expect(hasScope(p, "runs:read")).toBe(true);
    expect(hasScope(p, "runs:write")).toBe(false);
    expect(hasScope(p, "tracked:append")).toBe(true);
  });

  it("lets a denial override the role — an ADMIN who may not publish bundles", () => {
    const p = principal(effectiveScopes(scopesForRole("ADMIN"), [], ["bundles:write"]));
    expect(hasScope(p, "bundles:write")).toBe(false);
    // Everything else the role carries survives.
    expect(hasScope(p, "runs:write")).toBe(true);
    expect(hasScope(p, "bundles:read")).toBe(true);
  });

  it("takes the write away with the read, since a write implies the read", () => {
    // Denial closes upward. Leaving `runs:write` standing would hand the read
    // straight back through `hasScope`, so the denial would mean nothing.
    const p = principal(effectiveScopes(["runs:write"], [], ["runs:read"]));
    expect(hasScope(p, "runs:read")).toBe(false);
    expect(hasScope(p, "runs:write")).toBe(false);
  });

  it("does not take the read away with the write — watch but not touch", () => {
    const p = principal(effectiveScopes(["tracked:write"], [], ["tracked:write"]));
    expect(hasScope(p, "tracked:write")).toBe(false);
    expect(hasScope(p, "tracked:append")).toBe(true);
    expect(hasScope(p, "tracked:read")).toBe(true);
  });

  it("removes the write when the append is denied", () => {
    const p = principal(effectiveScopes(["tracked:write"], [], ["tracked:append"]));
    expect(hasScope(p, "tracked:append")).toBe(false);
    expect(hasScope(p, "tracked:write")).toBe(false);
    expect(hasScope(p, "tracked:read")).toBe(true);
  });

  it("narrows the wildcard once anything is denied", () => {
    const scopes = effectiveScopes(["*"], [], ["users:admin"]);
    expect(scopes).not.toContain("*");
    expect(scopes).not.toContain("users:admin");
    const p = principal(scopes);
    expect(hasScope(p, "users:admin")).toBe(false);
    expect(hasScope(p, "bundles:write")).toBe(true);
  });

  it("lets denial win over an explicit grant of the same scope", () => {
    const p = principal(effectiveScopes([], ["runs:write"], ["runs:write"]));
    expect(hasScope(p, "runs:write")).toBe(false);
  });

  it("de-duplicates rather than repeating a scope held twice", () => {
    expect(effectiveScopes(["runs:read"], ["runs:read"])).toEqual(["runs:read"]);
  });

  it("can leave an account holding nothing at all", () => {
    const p = principal(effectiveScopes(scopesForRole("CONTRIBUTOR"), [], ["*"]));
    for (const scope of SCOPES) expect(hasScope(p, scope)).toBe(false);
  });
});

describe("role defaults", () => {
  it("still gives owners the wildcard", () => {
    expect(DEFAULT_ROLE_SCOPES.OWNER).toEqual(["*"]);
    expect(scopesForRole("OWNER")).toEqual(["*"]);
  });

  it("hands back a copy, so a caller cannot mutate the shipped default", () => {
    const first = scopesForRole("CONTRIBUTOR");
    first.push("bundles:write");
    expect(scopesForRole("CONTRIBUTOR")).not.toContain("bundles:write");
  });

  it("refuses to treat OWNER as tunable", () => {
    expect(isTunableRole("OWNER")).toBe(false);
    expect(TUNABLE_ROLES).not.toContain("OWNER");
    expect(isTunableRole("ADMIN")).toBe(true);
    expect(isTunableRole("CONTRIBUTOR")).toBe(true);
    expect(isTunableRole("nonsense")).toBe(false);
  });
});

describe("scope descriptions", () => {
  it("describes every scope, so no editor renders a bare checkbox", () => {
    for (const scope of SCOPES) {
      expect(SCOPE_DESCRIPTIONS[scope], scope).toBeTruthy();
    }
    expect(Object.keys(SCOPE_DESCRIPTIONS).sort()).toEqual([...SCOPES].sort());
  });
});
