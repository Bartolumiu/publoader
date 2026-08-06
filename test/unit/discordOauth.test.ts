import { describe, expect, it, vi } from "vitest";
import type { AdminUser } from "@prisma/client";
import { exchangeDiscordCode, matchDiscordIdentity } from "../../src/core/api/oauth.js";

/**
 * The Discord callback's decision table, exercised without a database. The
 * property that matters most is that an *unverified* Discord email can never
 * claim an existing account; that would make account takeover a matter of
 * setting an email address on a throwaway Discord account.
 */
describe("matchDiscordIdentity", () => {
  const user = (over: Partial<AdminUser> = {}): AdminUser =>
    ({
      id: "u1",
      email: "ops@example.com",
      displayName: null,
      role: "ADMIN",
      approved: true,
      passwordHash: null,
      discordId: null,
      discordUsername: null,
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    }) as AdminUser;

  const deps = (over: Partial<Parameters<typeof matchDiscordIdentity>[1]> = {}) => ({
    byDiscordId: vi.fn(async () => null),
    byEmail: vi.fn(async () => null),
    linkDiscord: vi.fn(async (id: string, discordId: string, username: string) =>
      user({ id, discordId, discordUsername: username }),
    ),
    createFromDiscord: vi.fn(async (opts: { email: string; discordId: string; discordUsername: string }) =>
      user({ id: "new", email: opts.email, discordId: opts.discordId, approved: false }),
    ),
    signupsEnabled: vi.fn(async () => false),
    ...over,
  });

  const identity = { id: "42", username: "ardax", email: "ops@example.com", verified: true };

  it("logs in an already-linked account without touching email", async () => {
    const d = deps({ byDiscordId: vi.fn(async () => user({ discordId: "42", discordUsername: "ardax" })) });
    const result = await matchDiscordIdentity(identity, d);
    expect(result.outcome).toBe("login");
    expect(d.byEmail).not.toHaveBeenCalled();
  });

  it("refreshes a stale Discord username on login", async () => {
    const d = deps({ byDiscordId: vi.fn(async () => user({ discordId: "42", discordUsername: "old-name" })) });
    const result = await matchDiscordIdentity(identity, d);
    expect(result.outcome).toBe("login");
    expect(d.linkDiscord).toHaveBeenCalledWith("u1", "42", "ardax");
  });

  it("holds a linked but unapproved account at pending", async () => {
    const d = deps({
      byDiscordId: vi.fn(async () => user({ discordId: "42", discordUsername: "ardax", approved: false })),
    });
    expect((await matchDiscordIdentity(identity, d)).outcome).toBe("pending");
  });

  it("links a verified email to an existing account and logs in", async () => {
    const d = deps({ byEmail: vi.fn(async () => user()) });
    const result = await matchDiscordIdentity(identity, d);
    expect(result.outcome).toBe("login");
    expect(result).toMatchObject({ linked: true });
    expect(d.linkDiscord).toHaveBeenCalledWith("u1", "42", "ardax");
  });

  it("refuses to match an unverified email to an existing account", async () => {
    const d = deps({ byEmail: vi.fn(async () => user()) });
    const result = await matchDiscordIdentity({ ...identity, verified: false }, d);
    expect(result.outcome).toBe("no-email");
    expect(d.byEmail).not.toHaveBeenCalled();
    expect(d.linkDiscord).not.toHaveBeenCalled();
  });

  it("treats a missing email as unmatched rather than a signup", async () => {
    const d = deps({ signupsEnabled: vi.fn(async () => true) });
    const result = await matchDiscordIdentity({ ...identity, email: null }, d);
    expect(result.outcome).toBe("no-email");
    expect(d.createFromDiscord).not.toHaveBeenCalled();
  });

  it("refuses to create an account when signups are disabled", async () => {
    const d = deps();
    expect((await matchDiscordIdentity(identity, d)).outcome).toBe("signups-disabled");
    expect(d.createFromDiscord).not.toHaveBeenCalled();
  });

  it("creates an unapproved account when signups are enabled", async () => {
    const d = deps({ signupsEnabled: vi.fn(async () => true) });
    const result = await matchDiscordIdentity(identity, d);
    expect(result.outcome).toBe("pending");
    expect(d.createFromDiscord).toHaveBeenCalledWith({
      email: "ops@example.com",
      discordId: "42",
      discordUsername: "ardax",
    });
  });
});

describe("exchangeDiscordCode", () => {
  const opts = { clientId: "cid", clientSecret: "secret", redirectUri: "https://x/cb" };

  const jsonResponse = (body: unknown, ok = true, status = 200) =>
    ({ ok, status, json: async () => body }) as Response;

  it("exchanges a code and returns the identity", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "at", token_type: "Bearer" }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "42", username: "ardax", email: "ops@example.com", verified: true }),
      );

    const identity = await exchangeDiscordCode("code123", opts, fetchImpl as unknown as typeof fetch);
    expect(identity).toMatchObject({ id: "42", username: "ardax", verified: true });

    // The client secret goes in the body, never a query string or a header.
    const [, tokenInit] = fetchImpl.mock.calls[0]!;
    expect(String(tokenInit.body)).toContain("client_secret=secret");
    const [, meInit] = fetchImpl.mock.calls[1]!;
    expect(meInit.headers.authorization).toBe("Bearer at");
  });

  it("throws without echoing the code when the token endpoint fails", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ error: "bad" }, false, 400));
    await expect(exchangeDiscordCode("secret-code", opts, fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      /token endpoint returned 400/,
    );
    await expect(
      exchangeDiscordCode("secret-code", opts, fetchImpl as unknown as typeof fetch),
    ).rejects.not.toThrow(/secret-code/);
  });

  it("rejects an identity payload that does not match the expected shape", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "at" }))
      .mockResolvedValueOnce(jsonResponse({ username: "no-id" }));
    await expect(exchangeDiscordCode("c", opts, fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      /unexpected body/,
    );
  });
});
