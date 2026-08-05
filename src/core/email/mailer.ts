import type { Config } from "../../config.js";
import type { Logger } from "../../logging.js";

/**
 * Transactional email, via Resend.
 *
 * Only one thing is sent from this control plane — a sign-in link — and it is
 * a credential in transit, so this is deliberately the smallest surface that
 * works: one POST to `/emails`, no SDK, no template service, nothing about the
 * message held anywhere but the recipient's inbox. Same reasoning as the
 * Discord OAuth client next door: two HTTP calls do not need a dependency, and
 * every dependency reachable from the auth path is a supply-chain edge into
 * the thing that issues sessions.
 *
 * Email is treated as a *fallible* channel, never a silent one. A send that
 * fails is surfaced to the caller (`send` rejects) so a route can tell an
 * operator that an invite did not go out, rather than leaving them waiting on
 * a link that was never delivered.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";
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

  constructor(
    private readonly opts: {
      apiKey: string;
      /** `Name <address@domain>` or a bare address; must be a verified domain. */
      from: string;
      replyTo?: string;
      fetchImpl?: typeof fetch;
    },
  ) {}

  async send(email: OutgoingEmail): Promise<string> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.opts.apiKey}`,
      "content-type": "application/json",
    };
    if (email.idempotencyKey) headers["idempotency-key"] = email.idempotencyKey.slice(0, 256);

    let res: Response;
    try {
      res = await fetchImpl(RESEND_ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify({
          from: this.opts.from,
          to: [email.to],
          subject: email.subject,
          html: email.html,
          text: email.text,
          ...(this.opts.replyTo ? { reply_to: this.opts.replyTo } : {}),
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Network/timeout. The message may name the host but never the payload.
      throw new Error(`could not reach the email provider: ${(err as Error).message}`);
    }

    if (!res.ok) {
      // Resend answers errors as {name, message}; both are provider-authored
      // and safe to log, but neither is echoed to an unauthenticated caller —
      // the routes decide that, not this layer.
      const detail = await readErrorMessage(res);
      throw new Error(`email provider returned ${res.status}${detail ? `: ${detail}` : ""}`);
    }

    const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
    return typeof body?.id === "string" ? body.id : "";
  }
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown; name?: unknown };
    const message = typeof body.message === "string" ? body.message : "";
    const name = typeof body.name === "string" ? body.name : "";
    return (message || name).slice(0, 200);
  } catch {
    return "";
  }
}

/**
 * A mailer if this deployment can send, a refusing stub if it cannot. Missing
 * configuration is a warning rather than a boot failure: email is how invited
 * operators get in, but a deployment driven entirely by the admin token and
 * Discord login is still a valid one.
 */
export function createMailer(config: Config, log: Logger, fetchImpl?: typeof fetch): Mailer {
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
    fetchImpl,
  });
}
