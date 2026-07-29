import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { verifySignature } from "../../src/core/webhooks/github.js";

/**
 * The HMAC is the only credential on an otherwise unauthenticated endpoint that
 * can publish code, so these are the tests that carry the security claim.
 */
const SECRET = "s3cret-webhook-key-0123456789";
const body = Buffer.from('{"ref":"refs/heads/main"}', "utf8");
const sign = (secret: string, payload: Buffer): string =>
  "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");

describe("verifySignature", () => {
  it("accepts a signature computed with the configured secret", () => {
    expect(verifySignature(SECRET, body, sign(SECRET, body))).toBe(true);
  });

  it("rejects a signature computed with a different secret", () => {
    expect(verifySignature(SECRET, body, sign("not-the-secret-at-all-1234", body))).toBe(false);
  });

  it("rejects a valid signature over different bytes", () => {
    // Replay of a genuine delivery's header against a tampered body.
    const other = Buffer.from('{"ref":"refs/heads/attacker"}', "utf8");
    expect(verifySignature(SECRET, other, sign(SECRET, body))).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifySignature(SECRET, body, undefined)).toBe(false);
    expect(verifySignature(SECRET, body, "")).toBe(false);
  });

  it("refuses everything when no secret is configured", () => {
    // Fail closed: an unconfigured secret must not mean "accept anything",
    // including a signature an attacker computed over the empty secret.
    expect(verifySignature(undefined, body, sign("", body))).toBe(false);
    expect(verifySignature("", body, sign("", body))).toBe(false);
  });

  it("rejects a header that is the right digest with the wrong prefix", () => {
    const hex = createHmac("sha256", SECRET).update(body).digest("hex");
    expect(verifySignature(SECRET, body, hex)).toBe(false);
    expect(verifySignature(SECRET, body, `sha1=${hex}`)).toBe(false);
  });

  it("rejects truncated and padded headers instead of throwing", () => {
    // timingSafeEqual throws on length mismatch; the length pre-check is what
    // turns each of these into a plain `false`.
    const good = sign(SECRET, body);
    for (const bad of [good.slice(0, -1), good + "0", "sha256=", good.replace("sha256=", "")]) {
      expect(verifySignature(SECRET, body, bad)).toBe(false);
    }
  });

  it("is case-sensitive about the hex digest", () => {
    // GitHub sends lowercase hex. Accepting uppercase would mean comparing
    // something other than the bytes we computed.
    expect(verifySignature(SECRET, body, sign(SECRET, body).toUpperCase())).toBe(false);
  });

  it("verifies an empty body when that is what was signed", () => {
    const empty = Buffer.alloc(0);
    expect(verifySignature(SECRET, empty, sign(SECRET, empty))).toBe(true);
  });
});
