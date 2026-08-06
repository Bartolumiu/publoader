import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

/**
 * Whitespace around the secrets that are compared byte-for-byte.
 *
 * These three values are typed or pasted into a `.env` by hand on every install,
 * and they are the only config this system compares for exact equality; so they
 * are the only ones where a stray newline is a login failure rather than a
 * cosmetic difference. It reached production once as "invalid admin token"
 * against a token that was correct, which reads as a rotation problem and sends
 * the operator to re-issue a credential that was never wrong.
 *
 * `env()` already trims when a value arrives via the `_FILE` Docker-secrets
 * convention; `cat`-ing a secret file is the obvious way to get a trailing
 * newline. These tests cover the plain-variable path, which did not.
 */
describe("secret trimming", () => {
  const TOKEN = "0123456789abcdef0123456789abcdef";

  it("trims the admin token, however it was pasted", () => {
    for (const raw of [`${TOKEN}\n`, ` ${TOKEN} `, `${TOKEN}\r\n`, `\t${TOKEN}`]) {
      expect(loadConfig({ ADMIN_TOKEN: raw }).adminToken, JSON.stringify(raw)).toBe(TOKEN);
    }
  });

  it("trims the worker and enrolment tokens", () => {
    const cfg = loadConfig({ WORKER_TOKEN: ` wt_abc\n`, ENROLL_TOKEN: `pe_xyz\n` });
    expect(cfg.workerToken).toBe("wt_abc");
    expect(cfg.enrollToken).toBe("pe_xyz");
  });

  it("measures the token's length after trimming, not before", () => {
    // The 16-character floor is a real check, and padding must not be able to
    // carry a short token over it; nor to push a valid one out of range.
    expect(() => loadConfig({ ADMIN_TOKEN: `short           \n` })).toThrow();
    expect(loadConfig({ ADMIN_TOKEN: `  ${TOKEN}  ` }).adminToken).toBe(TOKEN);
  });

  it("leaves whitespace inside a value alone", () => {
    // Only the ends are trimmed. A passphrase-style token with real spaces in
    // it must survive intact, or trimming would silently change the credential.
    const spaced = "correct horse battery staple";
    expect(loadConfig({ ADMIN_TOKEN: `\n${spaced}\n` }).adminToken).toBe(spaced);
  });

  it("treats an all-whitespace token as unset rather than as a value", () => {
    // `get()` maps "" to undefined; "   " is the same intent and must not become
    // a 3-character credential that something could match against.
    expect(() => loadConfig({ ADMIN_TOKEN: "     " })).toThrow();
  });

  it("does not trim secrets that are used as keys rather than compared", () => {
    // Deliberate scope limit: the session secret is fed to HKDF, so its exact
    // bytes only need to be stable, and silently changing them would invalidate
    // every in-flight cookie on upgrade.
    const secret = `${"k".repeat(32)}\n`;
    expect(loadConfig({ SESSION_SECRET: secret }).sessionSecret).toBe(secret);
  });
});
