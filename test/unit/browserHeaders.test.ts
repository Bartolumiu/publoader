import { describe, expect, it } from "vitest";
import {
  BROWSER_PROFILES,
  browserHeaders,
  withBrowserHeaders,
} from "../../src/extsdk/browserHeaders.js";

/**
 * The point of these headers is to look like a browser, so the assertions are
 * about internal consistency rather than about any particular string. A header
 * set that contradicts itself is a stronger signal than sending nothing.
 */
describe("browser profiles", () => {
  it("keeps client hints consistent with the User-Agent", () => {
    // Firefox and Safari do not send Sec-CH-UA at all. Sending it with their
    // User-Agent is a contradiction a fingerprinter checks for, and is worse
    // than sending no hints.
    for (const profile of BROWSER_PROFILES) {
      const ua = profile["User-Agent"]!;
      const hasHints = "Sec-CH-UA" in profile;
      const isChromium = ua.includes("Chrome/");
      expect(hasHints, `hints on a non-Chromium UA: ${ua}`).toBe(isChromium);
    }
  });

  it("marks the mobile profile mobile and the desktop ones not", () => {
    for (const profile of BROWSER_PROFILES) {
      if (!("Sec-CH-UA-Mobile" in profile)) continue;
      const mobile = profile["Sec-CH-UA-Mobile"] === "?1";
      expect(profile["User-Agent"]!.includes("Mobile"), profile["User-Agent"]).toBe(mobile);
    }
  });

  it("every profile carries a User-Agent", () => {
    for (const profile of BROWSER_PROFILES) expect(profile["User-Agent"]).toBeTruthy();
  });
});

describe("browserHeaders", () => {
  const first = { pick: () => 0 };

  it("asks for JSON by default and HTML for a document", () => {
    expect(browserHeaders(first).Accept).toContain("application/json");
    expect(browserHeaders({ ...first, document: true }).Accept).toContain("text/html");
  });

  it("adds the navigation Sec-Fetch set only for a document", () => {
    expect(browserHeaders(first)["Sec-Fetch-Dest"]).toBeUndefined();
    expect(browserHeaders({ ...first, document: true })["Sec-Fetch-Dest"]).toBe("document");
  });

  it("does not advertise an encoding it cannot decode", () => {
    // undici handles gzip and deflate transparently. Claiming brotli and then
    // failing to decode it is a worse tell than not claiming it.
    expect(browserHeaders(first)["Accept-Encoding"]).toBe("gzip, deflate");
  });

  it("varies the profile across requests", () => {
    // Per request, not per process: a worker that pins one User-Agent for its
    // lifetime is just as fingerprintable, only more slowly.
    const seen = new Set<string>();
    for (let i = 0; i < BROWSER_PROFILES.length; i += 1) {
      seen.add(browserHeaders({ pick: () => i })["User-Agent"]!);
    }
    expect(seen.size).toBe(BROWSER_PROFILES.length);
  });

  it("survives a picker that returns an out-of-range index", () => {
    expect(browserHeaders({ pick: () => 999 })["User-Agent"]).toBeTruthy();
  });
});

describe("withBrowserHeaders", () => {
  const first = { pick: () => 0 };

  it("keeps the caller's value and drops the default it replaces", () => {
    // Case-insensitively: two User-Agent headers differing only in casing is a
    // fingerprint of its own, so the default must be removed, not shadowed.
    const merged = withBrowserHeaders({ "user-agent": "custom/1.0" }, first);
    const uaKeys = Object.keys(merged).filter((k) => k.toLowerCase() === "user-agent");
    expect(uaKeys).toHaveLength(1);
    expect(merged[uaKeys[0]!]).toBe("custom/1.0");
  });

  it("leaves the caller's unrelated headers alone and still adds defaults", () => {
    const merged = withBrowserHeaders({ Authorization: "Bearer x" }, first);
    expect(merged["Authorization"]).toBe("Bearer x");
    expect(merged["Accept-Language"]).toBe("en-US,en;q=0.9");
  });

  it("accepts the three shapes a caller can pass headers in", () => {
    const expected = "custom/1.0";
    expect(withBrowserHeaders({ "User-Agent": expected }, first)["User-Agent"]).toBe(expected);
    expect(withBrowserHeaders([["User-Agent", expected]], first)["User-Agent"]).toBe(expected);
    const headersLike = { entries: () => [["User-Agent", expected]] as [string, string][] };
    expect(withBrowserHeaders(headersLike, first)["User-Agent"]).toBe(expected);
  });

  it("returns the defaults when the caller sets nothing", () => {
    expect(withBrowserHeaders(undefined, first)["User-Agent"]).toBe(
      BROWSER_PROFILES[0]!["User-Agent"],
    );
  });
});

describe("the runner's copy", () => {
  /**
   * `runner-node/runner.mjs` is self-contained — it imports nothing from dist/,
   * because it is copied into the worker image on its own. That means it carries
   * a second copy of these profiles, and a second copy is only safe if something
   * fails when they diverge.
   */
  it("carries the same profiles as the SDK", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const runner = readFileSync(
      fileURLToPath(new URL("../../runner-node/runner.mjs", import.meta.url)),
      "utf8",
    );

    const uas = [...runner.matchAll(/"User-Agent":\s*\n?\s*((?:"[^"]*"\s*\+?\s*)+)/g)].map((m) =>
      m[1]!.replace(/"\s*\+\s*"/g, "").replace(/"/g, "").trim(),
    );
    expect(uas.length, "no profiles found in runner.mjs").toBe(BROWSER_PROFILES.length);
    for (const profile of BROWSER_PROFILES) {
      expect(uas, `runner.mjs is missing ${profile["User-Agent"]}`).toContain(profile["User-Agent"]);
    }
  });

  it("applies them on the request, not just defines them", async () => {
    // The profiles being present proves nothing if nothing sends them. This
    // caught a real miss: the SDK's own call site was edited and the change
    // silently did not land, leaving the import unused and no headers sent.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const read = (rel: string) =>
      readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

    expect(read("../../runner-node/runner.mjs")).toContain("headers: withBrowserHeaders(init.headers");
    expect(read("../../src/extsdk/guardedFetch.ts")).toContain("headers: withBrowserHeaders(init.headers");
  });
});
