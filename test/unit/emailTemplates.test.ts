import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  linkEmail,
  passwordChangedEmail,
  signupPendingEmail,
} from "../../src/core/email/templates.js";

/**
 * The messages themselves.
 *
 * These are not cosmetic assertions. The link is sometimes the only way into an
 * account, so it has to survive a plaintext-only client (hence the text part),
 * and it has to be escaped, because everything interpolated into these bodies,
 * the recipient's address, the URL, the role, is attacker-influenced somewhere
 * upstream.
 */

const url = "https://publoader.example/#token=abc123";

describe("linkEmail", () => {
  it("puts the URL in both the HTML and the plaintext part", () => {
    const mail = linkEmail({
      purpose: "LOGIN",
      to: "ops@example.com",
      url,
      ttlSeconds: 900,
      needsPassword: false,
    });
    expect(mail.html).toContain(escapeHtml(url));
    // Plaintext readers, link-rewriting scanners and copy-paste all have to work.
    expect(mail.text).toContain(url);
    expect(mail.to).toBe("ops@example.com");
  });

  it("names the lifetime in human units", () => {
    expect(linkEmail({ purpose: "LOGIN", to: "a@b.co", url, ttlSeconds: 900, needsPassword: false }).text).toContain(
      "15 minutes",
    );
    expect(linkEmail({ purpose: "INVITE", to: "a@b.co", url, ttlSeconds: 259_200, needsPassword: true }).text).toContain(
      "3 days",
    );
    expect(linkEmail({ purpose: "LOGIN", to: "a@b.co", url, ttlSeconds: 3600, needsPassword: false }).text).toContain(
      "1 hour",
    );
  });

  it("uses a different subject per purpose", () => {
    const subjects = (["LOGIN", "INVITE", "WELCOME"] as const).map(
      (purpose) => linkEmail({ purpose, to: "a@b.co", url, ttlSeconds: 900, needsPassword: true }).subject,
    );
    expect(new Set(subjects).size).toBe(3);
    expect(subjects[1]).toMatch(/invited/i);
    expect(subjects[2]).toMatch(/ready/i);
  });

  it("tells an account with no password that the link is its only key", () => {
    const needs = linkEmail({ purpose: "INVITE", to: "a@b.co", url, ttlSeconds: 900, needsPassword: true });
    expect(needs.text).toMatch(/set a password/i);

    const has = linkEmail({ purpose: "LOGIN", to: "a@b.co", url, ttlSeconds: 900, needsPassword: false });
    expect(has.text).not.toMatch(/set a password/i);
  });

  it("names the role when one is given", () => {
    const mail = linkEmail({
      purpose: "INVITE",
      to: "a@b.co",
      url,
      ttlSeconds: 900,
      role: "CONTRIBUTOR",
      needsPassword: true,
    });
    expect(mail.text).toContain("CONTRIBUTOR");
  });

  it("escapes interpolated values into the HTML body", () => {
    const mail = linkEmail({
      purpose: "LOGIN",
      to: '"><script>alert(1)</script>@example.com',
      url,
      ttlSeconds: 900,
      needsPassword: false,
    });
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&#60;script&#62;");
  });
});

describe("notices", () => {
  it("acknowledges a pending signup without offering a way in", () => {
    const mail = signupPendingEmail("new@example.com", "https://publoader.example");
    expect(mail.subject).toMatch(/awaiting approval/i);
    expect(mail.text).toMatch(/approve/i);
    // No token: there is nothing to sign in to yet.
    expect(mail.text).not.toContain("#token=");
  });

  it("tells an account holder their password changed", () => {
    const mail = passwordChangedEmail("ops@example.com", "https://publoader.example");
    expect(mail.subject).toMatch(/password was changed/i);
    expect(mail.text).toMatch(/not you/i);
  });
});

describe("escapeHtml", () => {
  it("neutralises every character that could break out of markup", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&#60;&#62;&#38;&#34;&#39;");
  });
});
