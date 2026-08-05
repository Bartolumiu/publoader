import { Resend } from "resend";
import type { Config } from "../../config.js";
import type { Logger } from "../../logging.js";

/**
 * Transactional email, via the Resend SDK.
 *
 * Only one thing is sent from this control plane — a sign-in link — and it is a
 * credential in transit, so this module stays deliberately thin: one call, no
 * template service, nothing about the message held anywhere but the recipient's
 * inbox.
 *
 * Email is treated as a *fallible* channel, never a silent one. The SDK does
 * not throw on an API error — it resolves `{data, error}` — so the single most
 * important thing here is that `error` is checked and turned into a rejection.
 * A mailer that returned normally on a failed send would make "your invite is
 * on the way" a lie the sender never hears about.
 */

/**
 * How long we are willing to wait. The SDK exposes no timeout and Node's fetch
 * imposes no response deadline, so without this an invite request could hang on
 * a stalled connection for as long as the socket stays open. Racing does not
 * cancel the underlying request — it frees the *caller*, which is what an owner
 * clicking "invite" actually needs.
 */
const REQUEST_TIMEOUT_MS = 15_000;

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  /** Always send a plaintext part: some operator inboxes strip HTML entirely. */
  text: string;
  /**
   * Retry-dedupe key, honoured by Resend for 24h. Shaped `<event>/<entity>`.
   * Note that it must vary per *token*, not per user — two deliberate "resend
   * my link" clicks are two different emails and both must arrive.
   */
  idempotencyKey?: string;
}

export interface Mailer {
  /** False when no provider is configured; routes degrade instead of 500ing. */
  readonly enabled: boolean;
  /** Resolves to the provider message id. Rejects with a non-sensitive message. */
  send(email: OutgoingEmail): Promise<string>;
}

/**
 * The one SDK surface this module uses. Narrowed to a structural type so a test
 * can supply a stand-in without a network, an API key, or module mocking —
 * and so anything else the SDK grows stays out of the auth path.
 */
export type EmailSender = Pick<Resend["emails"], "send">;

/** Thrown by `send` on a deployment with no RESEND_API_KEY. */
export class MailerDisabledError extends Error {
  constructor() {
    super("email is not configured on this deployment");
    this.name = "MailerDisabledError";
  }
}

class DisabledMailer implements Mailer {
  readonly enabled = false;
  send(): Promise<string> {
    return Promise.reject(new MailerDisabledError());
  }
}

export class ResendMailer implements Mailer {
  readonly enabled = true;
  private readonly emails: EmailSender;

  constructor(
    private readonly opts: {
      apiKey: string;
      /** `Name <address@domain>` or a bare address; must be a verified domain. */
      from: string;
      replyTo?: string;
      /** Test seam; defaults to a real client built from `apiKey`. */
      sender?: EmailSender;
    },
  ) {
    this.emails = opts.sender ?? new Resend(opts.apiKey).emails;
  }

  async send(email: OutgoingEmail): Promise<string> {
    const sent = this.emails.send(
      {
        from: this.opts.from,
        to: [email.to],
        subject: email.subject,
        html: email.html,
        text: email.text,
        ...(this.opts.replyTo ? { replyTo: this.opts.replyTo } : {}),
      },
      // The SDK sends this as the `Idempotency-Key` header. Omitted entirely
      // when we have none, rather than passed as undefined.
      email.idempotencyKey ? { idempotencyKey: email.idempotencyKey.slice(0, 256) } : undefined,
    );

    let result: Awaited<typeof sent>;
    try {
      result = await withTimeout(sent, REQUEST_TIMEOUT_MS);
    } catch (err) {
      // Network, timeout, or a genuine SDK throw. The message may name the
      // host or the deadline but never the payload.
      throw new Error(`could not reach the email provider: ${(err as Error).message}`);
    }

    // The gotcha this whole module exists to get right: an API error is a
    // resolved promise carrying `error`, not a rejection.
    if (result.error) {
      // Resend's `name` and `message` are provider-authored and safe to log,
      // but neither is echoed to an unauthenticated caller — the routes decide
      // that, not this layer.
      const { name, message, statusCode } = result.error;
      throw new Error(
        `email provider rejected the send${statusCode ? ` (${statusCode})` : ""}: ${message || name}`,
      );
    }

    // The SDK's response is a discriminated union, so ruling out `error` above
    // is what makes `data` present here — no defensive fallback needed.
    return result.data.id;
  }
}

/** Reject if `promise` has not settled in time. Does not cancel it. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    // Do not hold the process open for a send that nobody is waiting on.
    timer.unref?.();
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/**
 * A mailer if this deployment can send, a refusing stub if it cannot. Missing
 * configuration is a warning rather than a boot failure: email is how invited
 * operators get in, but a deployment driven entirely by the admin token and
 * Discord login is still a valid one.
 */
export function createMailer(config: Config, log: Logger, sender?: EmailSender): Mailer {
  if (!config.resendApiKey) {
    log.warn(
      "RESEND_API_KEY is not set: email sign-in links are disabled. Invited accounts " +
        "will have no way in until an owner sets a password for them.",
    );
    return new DisabledMailer();
  }
  return new ResendMailer({
    apiKey: config.resendApiKey,
    from: config.mailFrom,
    replyTo: config.mailReplyTo,
    sender,
  });
}
