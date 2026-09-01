import { describe, expect, it, vi } from "vitest";
import type { AdminUser } from "@prisma/client";
import { loadConfig } from "../../src/config.js";
import { resolveLinkRequest, ttlSecondsFor } from "../../src/core/api/magicLink.js";
import { decodeState, encodeState } from "../../src/core/api/oauth.js";

/**
 * The "email me a sign-in link" decision table, without a database or a mailer.
 *
 * The property that matters: an unauthenticated caller supplies the address, so
 * no outcome may depend on knowing whether that address has an account (the
 * route answers 202 for all of them), and creating an account from a bare
 * address must stay behind the signups gate; otherwise the endpoint is a way
 * to write rows into `admin_users` and mail strangers.
 */

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

const deps = (over: Partial<Parameters<typeof resolveLinkRequest>[1]> = {}) => ({
  byEmail: vi.fn(async () => null),
  signupsEnabled: vi.fn(async () => false),
  createPending: vi.fn(async (email: string) => user({ id: "new", email, approved: false })),
  ...over,
});

describe("resolveLinkRequest", () => {
  it("sends a link to an approved account", async () => {
    const d = deps({ byEmail: vi.fn(async () => user()) });
    const outcome = await resolveLinkRequest("ops@example.com", d);
    expect(outcome).toEqual({ kind: "send", user: expect.objectContaining({ id: "u1" }) });
    expect(d.createPending).not.toHaveBeenCalled();
  });

  it("sends a link to an approved account that has no password; this is the whole point", async () => {
    const d = deps({ byEmail: vi.fn(async () => user({ passwordHash: null })) });
    await expect(resolveLinkRequest("ops@example.com", d)).resolves.toMatchObject({ kind: "send" });
  });

  it("withholds the link from an account still awaiting approval", async () => {
    const d = deps({ byEmail: vi.fn(async () => user({ approved: false })) });
    const outcome = await resolveLinkRequest("ops@example.com", d);
    // A link would sign them in to nothing; they get a notice instead.
    expect(outcome).toMatchObject({ kind: "pending", created: false });
  });

  it("ignores an unknown address while signups are closed", async () => {
    const d = deps();
    const outcome = await resolveLinkRequest("stranger@example.com", d);
    expect(outcome).toEqual({ kind: "ignore", reason: "signups-disabled" });
    expect(d.createPending).not.toHaveBeenCalled();
  });

  it("creates an unapproved account for an unknown address once signups are open", async () => {
    const d = deps({ signupsEnabled: vi.fn(async () => true) });
    const outcome = await resolveLinkRequest("stranger@example.com", d);
    expect(outcome).toMatchObject({ kind: "pending", created: true });
    expect(d.createPending).toHaveBeenCalledWith("stranger@example.com");
    // Never a link, and never approved: mailbox control is evidence of an
    // address, not of authorisation.
    expect(outcome).not.toMatchObject({ kind: "send" });
  });

  it("checks the account before the signups gate, so an existing account is unaffected by it", async () => {
    const d = deps({ byEmail: vi.fn(async () => user()), signupsEnabled: vi.fn(async () => true) });
    await expect(resolveLinkRequest("ops@example.com", d)).resolves.toMatchObject({ kind: "send" });
    expect(d.signupsEnabled).not.toHaveBeenCalled();
  });
});

describe("ttlSecondsFor", () => {
  const config = loadConfig({ MAGIC_LINK_TTL_MINUTES: "15", INVITE_TTL_HOURS: "72" });

  it("gives a requested login link minutes and an invite days", () => {
    expect(ttlSecondsFor("LOGIN", config)).toBe(900);
    // Nobody is waiting at the keyboard for an invite: it has to survive a
    // weekend and a spam folder.
    expect(ttlSecondsFor("INVITE", config)).toBe(259_200);
    expect(ttlSecondsFor("WELCOME", config)).toBe(259_200);
  });
});

/**
 * The OAuth state now carries *why* the operator was sent to Discord. It is
 * covered by the same HMAC as the nonce, so a login round-trip cannot be
 * replayed as a link (which would attach an identity to the wrong account) or
 * the reverse (which would mint a session from a linking flow).
 */
describe("OAuth state intent", () => {
  it("round-trips a login intent", () => {
    const encoded = encodeState({ mode: "login" }, "nonce-1");
    expect(decodeState(encoded)).toEqual({ intent: { mode: "login" }, nonce: "nonce-1" });
  });

  it("round-trips a link intent with the account and session it belongs to", () => {
    const encoded = encodeState({ mode: "link", userId: "u1", sessionId: "s1" }, "nonce-2");
    expect(decodeState(encoded)).toEqual({
      intent: { mode: "link", userId: "u1", sessionId: "s1" },
      nonce: "nonce-2",
    });
  });

  it("rejects anything malformed rather than guessing an intent", () => {
    for (const bad of [
      "",
      "login",
      "link.u1",
      "login.a.b",
      "other.nonce",
      "link..nonce",
      // The pre-session-id link shape. It has no session to check, so it must
      // not decode: otherwise an old signed cookie would skip the liveness
      // check the session id is there to make possible.
      "link.u1.nonce",
      "link.u1.s1.n.x",
    ]) {
      expect(decodeState(bad)).toBeNull();
    }
  });
});
