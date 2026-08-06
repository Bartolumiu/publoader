import { describe, expect, it, vi } from "vitest";
import type { CreateEmailResponse } from "resend";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import {
  MailerDisabledError,
  ResendMailer,
  createMailer,
  type EmailSender,
} from "../../src/core/email/mailer.js";

/**
 * The Resend client, exercised through an injected sender.
 *
 * The property worth pinning is not "it calls the SDK" but the one the SDK
 * makes easy to get wrong: **an API error is a resolved promise carrying
 * `error`, not a rejection**. A mailer that only handled thrown errors would
 * report every rejected send as a success, and an owner would be told an invite
 * went out when it did not. Everything else here; payload shape, idempotency
 * key, reply-to; is checked because the whole message is a credential in
 * transit and it has to arrive intact.
 */

const log = createLogger("test-mailer", "error");

/** A sender that always succeeds, recording what it was asked to send. */
const okSender = (id = "msg_1") => {
  const send = vi.fn(
    async (): Promise<CreateEmailResponse> => ({ data: { id }, error: null, headers: null }),
  );
  return { send } as unknown as EmailSender & { send: ReturnType<typeof vi.fn> };
};

const mailer = (sender: EmailSender) =>
  new ResendMailer({ apiKey: "re_test_key", from: "publoader <no-reply@example.com>", sender });

const message = {
  to: "ops@example.com",
  subject: "Sign in",
  html: "<p>hi</p>",
  text: "hi",
};

/** The one send the mailer made, unpacked and asserted to exist. */
function sentCall(sender: { send: ReturnType<typeof vi.fn> }): {
  payload: Record<string, unknown>;
  options: { idempotencyKey?: string } | undefined;
} {
  const call = sender.send.mock.calls[0];
  expect(call, "the mailer should have made exactly one send").toBeDefined();
  const [payload, options] = call as [Record<string, unknown>, { idempotencyKey?: string } | undefined];
  return { payload, options };
}

describe("ResendMailer", () => {
  it("hands Resend the message and returns the id it minted", async () => {
    const sender = okSender("msg_abc");
    const id = await mailer(sender).send(message);

    expect(id).toBe("msg_abc");
    const { payload } = sentCall(sender);
    expect(payload["from"]).toBe("publoader <no-reply@example.com>");
    expect(payload["to"]).toEqual(["ops@example.com"]);
    expect(payload["subject"]).toBe("Sign in");
    // Both parts, always: an operator's inbox may strip the HTML one.
    expect(payload["html"]).toBe("<p>hi</p>");
    expect(payload["text"]).toBe("hi");
  });

  it("passes an idempotency key through, and omits the options entirely when there is none", async () => {
    const withKey = okSender();
    await mailer(withKey).send({ ...message, idempotencyKey: "login-link/abc" });
    expect(sentCall(withKey).options?.idempotencyKey).toBe("login-link/abc");

    const without = okSender();
    await mailer(without).send(message);
    expect(sentCall(without).options).toBeUndefined();
  });

  it("includes replyTo only when one is configured", async () => {
    const configured = okSender();
    await new ResendMailer({
      apiKey: "re_test_key",
      from: "a@example.com",
      replyTo: "humans@example.com",
      sender: configured,
    }).send(message);
    expect(sentCall(configured).payload["replyTo"]).toBe("humans@example.com");

    const plain = okSender();
    await mailer(plain).send(message);
    expect(sentCall(plain).payload).not.toHaveProperty("replyTo");
  });

  it("rejects when the SDK RESOLVES with an error; the whole point of this module", async () => {
    const sender = {
      send: vi.fn(
        async (): Promise<CreateEmailResponse> => ({
          data: null,
          error: { name: "validation_error", message: "domain is not verified", statusCode: 403 },
          headers: null,
        }),
      ),
    } as unknown as EmailSender;

    await expect(mailer(sender).send(message)).rejects.toThrow(/403.*domain is not verified/);
  });

  it("rejects when the SDK itself throws", async () => {
    const sender = {
      send: vi.fn(async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      }),
    } as unknown as EmailSender;

    await expect(mailer(sender).send(message)).rejects.toThrow(/could not reach the email provider/);
  });

  it("does not wait forever on a send that never settles", async () => {
    vi.useFakeTimers();
    try {
      const sender = { send: vi.fn(() => new Promise<never>(() => {})) } as unknown as EmailSender;
      const pending = mailer(sender).send(message);
      const assertion = expect(pending).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
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

  it("returns a live mailer when a key is configured", async () => {
    const sender = okSender();
    const mail = createMailer(
      loadConfig({ RESEND_API_KEY: "re_live", MAIL_FROM: "a@b.co" }),
      log,
      sender,
    );
    expect(mail.enabled).toBe(true);
    await mail.send(message);
    expect(sentCall(sender).payload["from"]).toBe("a@b.co");
  });
});
