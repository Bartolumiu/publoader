import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import { MailerDisabledError, ResendMailer, createMailer } from "../../src/core/email/mailer.js";

/**
 * The Resend client, exercised with an injected fetch.
 *
 * What is worth pinning here is not "it calls an API" but the two properties a
 * sign-in link depends on: the request carries the credential and the
 * idempotency key it was given, and a failure *rejects* rather than resolving
 * quietly. A mailer that swallowed its errors would turn "your invite is on the
 * way" into a lie the sender never hears about.
 */

const log = createLogger("test-mailer", "error");

const ok = (body: unknown = { id: "msg_1" }): typeof fetch =>
  vi.fn(async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
  ) as unknown as typeof fetch;

const mailer = (fetchImpl: typeof fetch) =>
  new ResendMailer({ apiKey: "re_test_key", from: "publoader <no-reply@example.com>", fetchImpl });

const message = {
  to: "ops@example.com",
  subject: "Sign in",
  html: "<p>hi</p>",
  text: "hi",
};

/** The one request the mailer made, unpacked and asserted to exist. */
function sentRequest(fetchImpl: typeof fetch): {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
  expect(call, "the mailer should have made exactly one request").toBeDefined();
  const [url, init] = call as [string, { method: string; headers: Record<string, string>; body: string }];
  return { url, method: init.method, headers: init.headers, body: JSON.parse(init.body) };
}

describe("ResendMailer", () => {
  it("posts the message to Resend with the API key and returns the message id", async () => {
    const fetchImpl = ok();
    const id = await mailer(fetchImpl).send(message);

    expect(id).toBe("msg_1");
    const sent = sentRequest(fetchImpl);
    expect(sent.url).toBe("https://api.resend.com/emails");
    expect(sent.method).toBe("POST");
    expect(sent.headers["authorization"]).toBe("Bearer re_test_key");
    expect(sent.body["from"]).toBe("publoader <no-reply@example.com>");
    expect(sent.body["to"]).toEqual(["ops@example.com"]);
    // Both parts, always: an operator's inbox may strip the HTML one.
    expect(sent.body["html"]).toBe("<p>hi</p>");
    expect(sent.body["text"]).toBe("hi");
  });

  it("passes an idempotency key through, and omits the header when there is none", async () => {
    const withKey = ok();
    await mailer(withKey).send({ ...message, idempotencyKey: "login-link/abc" });
    expect(sentRequest(withKey).headers["idempotency-key"]).toBe("login-link/abc");

    const without = ok();
    await mailer(without).send(message);
    expect(sentRequest(without).headers["idempotency-key"]).toBeUndefined();
  });

  it("includes reply_to only when one is configured", async () => {
    const fetchImpl = ok();
    await new ResendMailer({
      apiKey: "re_test_key",
      from: "a@example.com",
      replyTo: "humans@example.com",
      fetchImpl,
    }).send(message);
    expect(sentRequest(fetchImpl).body["reply_to"]).toBe("humans@example.com");

    const plain = ok();
    await mailer(plain).send(message);
    expect(sentRequest(plain).body["reply_to"]).toBeUndefined();
  });

  it("rejects on an API error and names the status", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ name: "validation_error", message: "domain is not verified" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    await expect(mailer(fetchImpl).send(message)).rejects.toThrow(/403.*domain is not verified/);
  });

  it("rejects when the provider is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;

    await expect(mailer(fetchImpl).send(message)).rejects.toThrow(/could not reach the email provider/);
  });

  it("survives a success response with no parseable body", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 })) as unknown as typeof fetch;
    await expect(mailer(fetchImpl).send(message)).resolves.toBe("");
  });
});

describe("createMailer", () => {
  it("returns a refusing stub when no API key is configured", async () => {
    const mail = createMailer(loadConfig({ RESEND_API_KEY: "" }), log);
    expect(mail.enabled).toBe(false);
    // Refusing loudly is the point: a route checks `enabled` and degrades, and
    // anything that skipped the check gets an error rather than a silent no-op.
    await expect(mail.send(message)).rejects.toBeInstanceOf(MailerDisabledError);
  });

  it("returns a live mailer when a key is configured", () => {
    const mail = createMailer(loadConfig({ RESEND_API_KEY: "re_live", MAIL_FROM: "a@b.co" }), log);
    expect(mail.enabled).toBe(true);
  });
});
