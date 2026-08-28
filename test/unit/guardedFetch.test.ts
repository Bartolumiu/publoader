import { describe, expect, it } from "vitest";
import {
  createGuardedFetch,
  HostNotAllowedError,
  parseRetryAfter,
} from "../../src/extsdk/guardedFetch.js";

/** Records every URL the wrapper actually tried to reach. */
function recorder(handler: (url: string, init: RequestInit) => Response) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push(url);
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function redirectTo(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

/** No politeness delay and no real sleeping; these tests assert policy, not timing. */
const instant = {
  minIntervalMs: 0,
  sleep: async () => {},
};

describe("guardedFetch host allowlist", () => {
  it("allows an exact host match", async () => {
    const { calls, fetchImpl } = recorder(() => new Response("ok"));
    const fetchGuarded = createGuardedFetch({
      allowedHosts: ["example.com"],
      fetchImpl,
      ...instant,
    });
    const res = await fetchGuarded("https://example.com/a");
    expect(res.status).toBe(200);
    expect(calls).toEqual(["https://example.com/a"]);
  });

  it("allows a subdomain of an allowed host", async () => {
    const { fetchImpl } = recorder(() => new Response("ok"));
    const fetchGuarded = createGuardedFetch({
      allowedHosts: ["example.com"],
      fetchImpl,
      ...instant,
    });
    await expect(fetchGuarded("https://api.cdn.example.com/a")).resolves.toBeInstanceOf(Response);
  });

  it("rejects a host that merely ends with the allowed string", async () => {
    // The classic suffix bug: "evilexample.com".endsWith("example.com") is
    // true, but it is a different registrable domain and must not pass.
    const { calls, fetchImpl } = recorder(() => new Response("ok"));
    const fetchGuarded = createGuardedFetch({
      allowedHosts: ["example.com"],
      fetchImpl,
      ...instant,
    });
    await expect(fetchGuarded("https://evilexample.com/a")).rejects.toThrow(HostNotAllowedError);
    expect(calls).toEqual([]);
  });

  it("rejects an unrelated host without connecting", async () => {
    const { calls, fetchImpl } = recorder(() => new Response("ok"));
    const fetchGuarded = createGuardedFetch({
      allowedHosts: ["example.com"],
      fetchImpl,
      ...instant,
    });
    await expect(fetchGuarded("https://attacker.test/a")).rejects.toThrow(HostNotAllowedError);
    expect(calls).toEqual([]);
  });

  it("rejects non-http schemes", async () => {
    const { calls, fetchImpl } = recorder(() => new Response("ok"));
    const fetchGuarded = createGuardedFetch({
      allowedHosts: ["example.com"],
      fetchImpl,
      ...instant,
    });
    await expect(fetchGuarded("file:///etc/passwd")).rejects.toThrow(HostNotAllowedError);
    await expect(fetchGuarded("not-a-url")).rejects.toThrow(HostNotAllowedError);
    expect(calls).toEqual([]);
  });

  it("blocks everything when the allowlist is empty", async () => {
    const { fetchImpl } = recorder(() => new Response("ok"));
    const fetchGuarded = createGuardedFetch({ allowedHosts: [], fetchImpl, ...instant });
    await expect(fetchGuarded("https://example.com/")).rejects.toThrow(HostNotAllowedError);
  });

  it("matches hosts case-insensitively", async () => {
    const { fetchImpl } = recorder(() => new Response("ok"));
    const fetchGuarded = createGuardedFetch({
      allowedHosts: ["Example.COM"],
      fetchImpl,
      ...instant,
    });
    await expect(fetchGuarded("https://API.example.com/")).resolves.toBeInstanceOf(Response);
  });
});

describe("guardedFetch redirects", () => {
  it("follows a redirect that stays inside the allowlist", async () => {
    const { calls, fetchImpl } = recorder((url) =>
      url.endsWith("/start") ? redirectTo("https://cdn.example.com/final") : new Response("body"),
    );
    const fetchGuarded = createGuardedFetch({
      allowedHosts: ["example.com"],
      fetchImpl,
      ...instant,
    });
    const res = await fetchGuarded("https://example.com/start");
    expect(await res.text()).toBe("body");
    expect(calls).toEqual(["https://example.com/start", "https://cdn.example.com/final"]);
  });

  it("refuses a redirect to a host outside the allowlist", async () => {
    // The reason redirect: "manual" exists. An allowlisted origin must not be
    // able to launder a request to somewhere the manifest never permitted.
    const { calls, fetchImpl } = recorder((url) =>
      url.endsWith("/start") ? redirectTo("https://attacker.test/steal") : new Response("body"),
    );
    const fetchGuarded = createGuardedFetch({
      allowedHosts: ["example.com"],
      fetchImpl,
      ...instant,
    });
    await expect(fetchGuarded("https://example.com/start")).rejects.toThrow(HostNotAllowedError);
    expect(calls).toEqual(["https://example.com/start"]);
  });

  it("resolves a relative Location against the current URL", async () => {
    const { calls, fetchImpl } = recorder((url) =>
      url.endsWith("/a/start") ? redirectTo("../b/final") : new Response("body"),
    );
    const fetchGuarded = createGuardedFetch({
      allowedHosts: ["example.com"],
      fetchImpl,
      ...instant,
    });
    await fetchGuarded("https://example.com/a/start");
    expect(calls[1]).toBe("https://example.com/b/final");
  });

  it("gives up after too many hops", async () => {
    const { fetchImpl } = recorder(() => redirectTo("https://example.com/loop"));
    const fetchGuarded = createGuardedFetch({
      allowedHosts: ["example.com"],
      fetchImpl,
      maxRedirects: 3,
      ...instant,
    });
    await expect(fetchGuarded("https://example.com/loop")).rejects.toThrow(/too many redirects/);
  });

  it("downgrades POST to GET on a 303", async () => {
    const seen: RequestInit[] = [];
    const { fetchImpl } = recorder((url, init) => {
      seen.push(init);
      return url.endsWith("/submit") ? redirectTo("https://example.com/done", 303) : new Response("k");
    });
    const fetchGuarded = createGuardedFetch({
      allowedHosts: ["example.com"],
      fetchImpl,
      ...instant,
    });
    await fetchGuarded("https://example.com/submit", { method: "POST", body: "x=1" });
    expect(seen[0]?.method).toBe("POST");
    expect(seen[1]?.method).toBe("GET");
    expect(seen[1]?.body).toBeNull();
  });
});

describe("guardedFetch retries", () => {
  it("retries a 500 and returns the eventual success", async () => {
    let attempts = 0;
    const { fetchImpl } = recorder(() => {
      attempts += 1;
      return attempts < 3 ? new Response("nope", { status: 500 }) : new Response("yes");
    });
    const fetchGuarded = createGuardedFetch({
      allowedHosts: ["example.com"],
      fetchImpl,
      ...instant,
    });
    const res = await fetchGuarded("https://example.com/flaky");
    expect(await res.text()).toBe("yes");
    expect(attempts).toBe(3);
  });

  it("stops retrying a 500 once the budget is spent", async () => {
    let attempts = 0;
    const { fetchImpl } = recorder(() => {
      attempts += 1;
      return new Response("nope", { status: 503 });
    });
    const fetchGuarded = createGuardedFetch({
      allowedHosts: ["example.com"],
      fetchImpl,
      maxRetries: 2,
      ...instant,
    });
    const res = await fetchGuarded("https://example.com/down");
    expect(res.status).toBe(503);
    expect(attempts).toBe(3); // first attempt + 2 retries
  });

  it("does not retry a 4xx", async () => {
    let attempts = 0;
    const { fetchImpl } = recorder(() => {
      attempts += 1;
      return new Response("gone", { status: 404 });
    });
    const fetchGuarded = createGuardedFetch({
      allowedHosts: ["example.com"],
      fetchImpl,
      ...instant,
    });
    expect((await fetchGuarded("https://example.com/missing")).status).toBe(404);
    expect(attempts).toBe(1);
  });

  it("honours Retry-After on a 429", async () => {
    const slept: number[] = [];
    let attempts = 0;
    const { fetchImpl } = recorder(() => {
      attempts += 1;
      return attempts === 1
        ? new Response(null, { status: 429, headers: { "retry-after": "7" } })
        : new Response("ok");
    });
    const fetchGuarded = createGuardedFetch({
      allowedHosts: ["example.com"],
      fetchImpl,
      minIntervalMs: 0,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    await fetchGuarded("https://example.com/limited");
    expect(slept).toContain(7000);
  });

  it("caps an outrageous Retry-After", async () => {
    const slept: number[] = [];
    let attempts = 0;
    const { fetchImpl } = recorder(() => {
      attempts += 1;
      return attempts === 1
        ? new Response(null, { status: 429, headers: { "retry-after": "86400" } })
        : new Response("ok");
    });
    const fetchGuarded = createGuardedFetch({
      allowedHosts: ["example.com"],
      fetchImpl,
      minIntervalMs: 0,
      maxRetryAfterMs: 60_000,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    await fetchGuarded("https://example.com/limited");
    expect(slept).toContain(60_000);
  });

  it("retries a transport error", async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      if (attempts < 2) throw new TypeError("fetch failed");
      return new Response("recovered");
    }) as unknown as typeof fetch;
    const fetchGuarded = createGuardedFetch({
      allowedHosts: ["example.com"],
      fetchImpl,
      ...instant,
    });
    expect(await (await fetchGuarded("https://example.com/x")).text()).toBe("recovered");
    expect(attempts).toBe(2);
  });
});

describe("guardedFetch politeness", () => {
  it("spaces consecutive requests to the same host", async () => {
    const slept: number[] = [];
    let clock = 0;
    const { fetchImpl } = recorder(() => new Response("ok"));
    const fetchGuarded = createGuardedFetch({
      allowedHosts: ["example.com"],
      fetchImpl,
      minIntervalMs: 500,
      now: () => clock,
      // Jitter off: this asserts the FLOOR, which is the part that must hold
      // whatever the randomness does.
      random: () => 0,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });
    await fetchGuarded("https://example.com/1");
    await fetchGuarded("https://example.com/2");
    await fetchGuarded("https://example.com/3");
    expect(slept).toEqual([500, 500]); // the first request is free
  });

  it("does not make one host wait on another", async () => {
    const slept: number[] = [];
    const { fetchImpl } = recorder(() => new Response("ok"));
    const fetchGuarded = createGuardedFetch({
      allowedHosts: ["example.com", "other.test"],
      fetchImpl,
      minIntervalMs: 500,
      now: () => 0,
      random: () => 0,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    await fetchGuarded("https://example.com/1");
    await fetchGuarded("https://other.test/1");
    expect(slept).toEqual([]);
  });

  /**
   * A fixed gap is a fingerprint on its own.
   *
   * Requests landing exactly 500ms apart for an hour look like nothing a person
   * produces, whatever the volume, and workers handed segments of the same run
   * start within milliseconds of each other — so without jitter they march in
   * step across several addresses at once, which is the pattern most worth not
   * showing a publisher.
   *
   * The floor is the invariant: jitter may only ever ADD.
   */
  it("adds a random extra to each gap, never less than the floor", async () => {
    const slept: number[] = [];
    let clock = 0;
    const { fetchImpl } = recorder(() => new Response("ok"));
    const fetchGuarded = createGuardedFetch({
      allowedHosts: ["example.com"],
      fetchImpl,
      minIntervalMs: 500,
      jitterRatio: 0.5,
      // Maximum jitter, so the upper bound is exercised rather than averaged.
      random: () => 0.999,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });
    await fetchGuarded("https://example.com/1");
    await fetchGuarded("https://example.com/2");
    await fetchGuarded("https://example.com/3");

    // First request staggered, then gaps inside [500, 750].
    for (const wait of slept) {
      expect(wait).toBeGreaterThanOrEqual(0);
      expect(wait).toBeLessThanOrEqual(750);
    }
    const gaps = slept.slice(1);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(500);
  });

  it("staggers the first request so parallel workers do not start in lockstep", async () => {
    const slept: number[] = [];
    const { fetchImpl } = recorder(() => new Response("ok"));
    const fetchGuarded = createGuardedFetch({
      allowedHosts: ["example.com"],
      fetchImpl,
      minIntervalMs: 500,
      jitterRatio: 0.5,
      random: () => 0.5,
      now: () => 0,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    await fetchGuarded("https://example.com/1");
    // Without the stagger this is 0 for every worker at once.
    expect(slept[0]).toBe(125);
  });

  it("restores an exact interval when jitter is turned off", async () => {
    const slept: number[] = [];
    let clock = 0;
    const { fetchImpl } = recorder(() => new Response("ok"));
    const fetchGuarded = createGuardedFetch({
      allowedHosts: ["example.com"],
      fetchImpl,
      minIntervalMs: 500,
      jitterRatio: 0,
      random: () => 0.999,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });
    await fetchGuarded("https://example.com/1");
    await fetchGuarded("https://example.com/2");
    expect(slept).toEqual([500]);
  });

  it("counts every request it issues, hops included", async () => {
    const { fetchImpl } = recorder((url) =>
      url.endsWith("/start") ? redirectTo("https://example.com/final") : new Response("body"),
    );
    const fetchGuarded = createGuardedFetch({
      allowedHosts: ["example.com"],
      fetchImpl,
      ...instant,
    });
    await fetchGuarded("https://example.com/start");
    expect(fetchGuarded.requestCount).toBe(2);
  });
});

describe("parseRetryAfter", () => {
  it("reads delta-seconds", () => {
    expect(parseRetryAfter("120", 0)).toBe(120_000);
  });

  it("reads an HTTP date as a delta from now", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:30 GMT", now)).toBe(30_000);
  });

  it("never returns a negative delay for a past date", () => {
    const now = Date.parse("2026-01-01T00:01:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:00 GMT", now)).toBe(0);
  });

  it("returns null when absent or unparseable", () => {
    expect(parseRetryAfter(null, 0)).toBeNull();
    expect(parseRetryAfter("soon please", 0)).toBeNull();
  });
});
