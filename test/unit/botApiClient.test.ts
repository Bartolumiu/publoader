import { describe, expect, it, vi } from "vitest";
import {
  AdminApiClient,
  AdminApiError,
  AdminNetworkError,
  describeApiError,
} from "../../src/bot/apiClient.js";

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/**
 * A fetch double that records the request and returns a canned response.
 * Everything about the client that matters is in the request it builds and the
 * error it raises, so this is the whole test surface.
 */
function stubFetch(response: { status?: number; body?: string; headers?: Record<string, string> }) {
  const calls: Captured[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const status = response.status ?? 200;
    return new Response(response.body ?? "{}", {
      status,
      headers: { "content-type": "application/json", ...response.headers },
    });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function client(response: Parameters<typeof stubFetch>[0], token = "pa_scoped_token_value") {
  const { impl, calls } = stubFetch(response);
  return {
    api: new AdminApiClient({ baseUrl: "https://core.example/", token, fetchImpl: impl }),
    calls,
  };
}

describe("AdminApiClient request construction", () => {
  it("sends the bearer token and attributes the action to the human", async () => {
    const { api, calls } = client({ body: JSON.stringify({ paused: false }) });
    await api.stats("discord:ardax");
    expect(calls[0]?.headers["authorization"]).toBe("Bearer pa_scoped_token_value");
    // Without x-actor every bot action would be one anonymous robot in the audit log.
    expect(calls[0]?.headers["x-actor"]).toBe("discord:ardax");
  });

  it("strips a trailing slash from the base URL rather than doubling it", async () => {
    const { api, calls } = client({});
    await api.stats("discord:ardax");
    expect(calls[0]?.url).toBe("https://core.example/api/v1/admin/stats");
  });

  it("puts list parameters in the query string and omits undefined ones", async () => {
    const { api, calls } = client({ body: JSON.stringify({ runs: [] }) });
    await api.listRuns("discord:ardax", { limit: 5 });
    expect(calls[0]?.url).toBe("https://core.example/api/v1/admin/runs?limit=5");

    const withExt = client({ body: JSON.stringify({ runs: [] }) });
    await withExt.api.listRuns("discord:ardax", { limit: 5, extension: "mangaplus" });
    expect(withExt.calls[0]?.url).toContain("extension=mangaplus");
  });

  it("percent-encodes path parameters so an id cannot escape its segment", async () => {
    const { api, calls } = client({});
    await api.cancelJob("discord:ardax", "a/../b");
    expect(calls[0]?.url).toBe("https://core.example/api/v1/admin/jobs/a%2F..%2Fb/cancel");
  });

  it("sends null minutes for an indefinite pause", async () => {
    const { api, calls } = client({ body: JSON.stringify({ paused: true, indefinite: true }) });
    await api.pause("discord:ardax", null);
    expect(calls[0]?.body).toBe(JSON.stringify({ minutes: null }));
  });

  it("maps enable/disable onto the right endpoint", async () => {
    const enabled = client({});
    await enabled.api.setExtensionEnabled("discord:ardax", "mangaplus", true);
    expect(enabled.calls[0]?.url).toContain("/extensions/mangaplus/enable");

    const disabled = client({});
    await disabled.api.setExtensionEnabled("discord:ardax", "mangaplus", false);
    expect(disabled.calls[0]?.url).toContain("/extensions/mangaplus/disable");
  });

  it("returns an empty object for an empty 2xx body instead of throwing on JSON.parse", async () => {
    const { api } = client({ status: 200, body: "" });
    await expect(api.resume("discord:ardax")).resolves.toEqual({});
  });
});

describe("AdminApiClient error mapping", () => {
  it("raises AdminApiError carrying the status, the API's message and the needed scope", async () => {
    const { api } = client({ status: 403, body: JSON.stringify({ error: "token lacks runs:write" }) });
    const err = await api
      .triggerRun("discord:ardax", { extension: "mangaplus", kind: "FORCE" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdminApiError);
    expect((err as AdminApiError).status).toBe(403);
    expect((err as AdminApiError).detail).toBe("token lacks runs:write");
    expect((err as AdminApiError).scope).toBe("runs:write");
    expect((err as AdminApiError).isAuth).toBe(true);
  });

  it("keeps a non-JSON error body as the detail; proxies return HTML", async () => {
    const { api } = client({ status: 502, body: "<html>Bad Gateway</html>" });
    const err = (await api.stats("discord:ardax").catch((e: unknown) => e)) as AdminApiError;
    expect(err.detail).toContain("Bad Gateway");
    expect(err.isAuth).toBe(false);
  });

  it("reads Retry-After off a 429", async () => {
    const { api } = client({ status: 429, body: JSON.stringify({ error: "rate limited" }), headers: { "retry-after": "12" } });
    const err = (await api.stats("discord:ardax").catch((e: unknown) => e)) as AdminApiError;
    expect(err.retryAfterSeconds).toBe(12);
    expect(describeApiError(err)).toContain("Wait 12s");
  });

  it("wraps a transport failure as AdminNetworkError, not an API error", async () => {
    const impl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const api = new AdminApiClient({ baseUrl: "https://core.example", token: "pa_x", fetchImpl: impl });
    const err = await api.stats("discord:ardax").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdminNetworkError);
    expect(describeApiError(err)).toContain("Could not reach the core API");
  });

  it("treats a 200 with a non-JSON body as a transport problem", async () => {
    const { api } = client({ status: 200, body: "not json at all" });
    await expect(api.stats("discord:ardax")).rejects.toBeInstanceOf(AdminNetworkError);
  });
});

describe("tokenSelf", () => {
  it("returns null on 404, because introspection does not exist until scoped tokens land", async () => {
    const { api } = client({ status: 404, body: JSON.stringify({ error: "Not Found" }) });
    await expect(api.tokenSelf("discord:ardax")).resolves.toBeNull();
  });

  it("returns scopes when the deployment does expose them", async () => {
    const { api } = client({ body: JSON.stringify({ scopes: ["runs:write", "stats:read"] }) });
    await expect(api.tokenSelf("discord:ardax")).resolves.toEqual({
      scopes: ["runs:write", "stats:read"],
    });
  });

  it("propagates a real failure instead of swallowing it as unsupported", async () => {
    const { api } = client({ status: 401, body: JSON.stringify({ error: "admin token required" }) });
    await expect(api.tokenSelf("discord:ardax")).rejects.toBeInstanceOf(AdminApiError);
  });
});

describe("token presentation", () => {
  it("masks the token so it can be printed in a reply", () => {
    const { api } = client({}, "pa_abcdefghijklmnop");
    expect(api.tokenFingerprint).toBe("pa_a…mnop (19 chars)");
    expect(api.tokenFingerprint).not.toContain("efghijkl");
  });

  it("masks a short token completely", () => {
    const { api } = client({}, "short");
    expect(api.tokenFingerprint).toBe("*****");
  });

  it("recognises a scoped token and flags anything else", () => {
    expect(client({}, "pa_something").api.looksScoped).toBe(true);
    // The root ADMIN_TOKEN is base64 from `openssl rand`, so it never has the prefix.
    expect(client({}, "K3RtYWlu…").api.looksScoped).toBe(false);
  });
});

describe("describeApiError", () => {
  const make = (status: number, detail: string) =>
    new AdminApiError({ status, detail, scope: "runs:write", method: "POST", path: "/x" });

  it("names the missing scope on a 403", () => {
    expect(describeApiError(make(403, "forbidden"))).toContain("lacks the `runs:write` scope");
  });

  it("points at BOT_API_TOKEN on a 401", () => {
    expect(describeApiError(make(401, "admin token required"))).toContain("BOT_API_TOKEN");
  });

  it("passes the API's own text through on a 409; that is the actionable part", () => {
    expect(describeApiError(make(409, "platform is paused"))).toContain("platform is paused");
  });

  it("does not pretend to understand an unknown error", () => {
    expect(describeApiError(new Error("boom"))).toContain("boom");
  });
});
