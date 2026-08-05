import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AdminUser, LoginTokenPurpose } from "@prisma/client";
import { z } from "zod";
import type { AppContext } from "./context.js";
import type { Config } from "../../config.js";
import type { Logger } from "../../logging.js";
import type { Mailer } from "../email/mailer.js";
import { linkEmail, passwordChangedEmail, signupPendingEmail } from "../email/templates.js";
import type { LoginTokenStore } from "../store/loginTokens.js";
import { SESSION_COOKIE, cleanActor, cookieHeader, isSecureRequest } from "./session.js";

/**
 * Email sign-in links.
 *
 * The reason this exists: an invited account has no password and no Discord
 * linkage, so before this it could not sign in at all — an owner had to choose
 * a password *for* somebody else and send it over some other channel. A link
 * mailed to the address that defines the account replaces that, and stays the
 * account's credential until its holder sets a password of their own.
 *
 * The link is delivered in the URL *fragment*, not the query string:
 *
 *   https://publoader.example/#token=<secret>
 *
 * A fragment is never sent to a server, so the secret cannot land in this
 * process's request log, in a proxy's access log, or in a Referer header — and
 * a mail-scanner that fetches the URL cannot burn a single-use token before
 * its owner clicks it, which is the usual way magic links fail in practice.
 * The dashboard reads the fragment and posts it back. The cost is that a mail
 * gateway which rewrites links and drops fragments makes the link useless; an
 * owner setting a password directly is the way out of that.
 */

/** How long a link lives, by why it was sent. */
export function ttlSecondsFor(purpose: LoginTokenPurpose, config: Config): number {
  // A LOGIN link was asked for by somebody at the keyboard: minutes. An INVITE
  // or WELCOME link has to survive a weekend and a spam folder: days.
  return purpose === "LOGIN" ? config.magicLinkTtlMinutes * 60 : config.inviteTtlHours * 3600;
}

export class MagicLinkService {
  constructor(
    private readonly deps: {
      loginTokens: LoginTokenStore;
      mailer: Mailer;
      config: Config;
      log: Logger;
    },
  ) {}

  /** Whether this deployment can send at all. */
  get enabled(): boolean {
    return this.deps.mailer.enabled;
  }

  private urlFor(secret: string): string {
    return `${this.deps.config.dashPublicUrl.replace(/\/+$/, "")}/#token=${secret}`;
  }

  /**
   * Issue a link and mail it. Rejects when the send fails, so that an owner
   * clicking "invite" is told the invite did not go out rather than being left
   * to wonder — the account still exists, and the link can be re-sent.
   */
  async send(
    user: AdminUser,
    purpose: LoginTokenPurpose,
    opts: { requestedIp?: string | null } = {},
  ): Promise<{ expiresAt: Date }> {
    const ttlSeconds = ttlSecondsFor(purpose, this.deps.config);
    const issued = await this.deps.loginTokens.issue({
      user,
      purpose,
      ttlSeconds,
      requestedIp: opts.requestedIp,
    });
    const email = linkEmail({
      purpose,
      to: user.email,
      url: this.urlFor(issued.secret),
      ttlSeconds,
      role: user.role,
      needsPassword: user.passwordHash === null,
    });
    try {
      await this.deps.mailer.send({
        ...email,
        // Keyed on the token, not the user: two deliberate "send me another
        // link" clicks are two different mails and both have to arrive.
        idempotencyKey: `login-link/${issued.id}`,
      });
    } catch (err) {
      // The link is now unreachable, so retire it rather than leaving a live
      // credential behind for a mail that may yet be delivered by a retry.
      await this.deps.loginTokens.revokeOutstanding(user.id);
      this.deps.log.error(
        { stage: "magic-link", purpose, userId: user.id, reason: (err as Error).message },
        "could not send sign-in link",
      );
      throw err;
    }
    this.deps.log.info({ stage: "magic-link", purpose, userId: user.id }, "sign-in link sent");
    return { expiresAt: issued.expiresAt };
  }

  /** Best-effort notices. A failed notice must never fail the action it reports. */
  async notify(kind: "signup-pending" | "password-changed", to: string): Promise<void> {
    if (!this.enabled) return;
    const dashUrl = this.deps.config.dashPublicUrl.replace(/\/+$/, "");
    const email =
      kind === "signup-pending" ? signupPendingEmail(to, dashUrl) : passwordChangedEmail(to, dashUrl);
    try {
      await this.deps.mailer.send(email);
    } catch (err) {
      this.deps.log.warn(
        { stage: "magic-link", kind, reason: (err as Error).message },
        "could not send notification email",
      );
    }
  }
}

/**
 * What a "email me a sign-in link" request for `email` should do.
 *
 * Pulled out as a pure decision with injected side effects — same shape as
 * `matchDiscordIdentity` — because this is the policy that matters and it must
 * be assertable without a database, a mailer or an HTTP server.
 *
 * The caller answers 202 for every outcome including "ignore": the endpoint is
 * unauthenticated, so distinguishing them in the response would turn it into
 * an account-enumeration oracle.
 */
export type LinkRequestOutcome =
  | { kind: "send"; user: AdminUser }
  | { kind: "pending"; user: AdminUser; created: boolean }
  | { kind: "ignore"; reason: "unknown-email" | "signups-disabled" };

export async function resolveLinkRequest(
  email: string,
  deps: {
    byEmail: (email: string) => Promise<AdminUser | null>;
    signupsEnabled: () => Promise<boolean>;
    createPending: (email: string) => Promise<AdminUser>;
  },
): Promise<LinkRequestOutcome> {
  const existing = await deps.byEmail(email);
  if (existing) {
    // An account that exists but has not been approved gets a notice, not a
    // link: there is nothing yet for the link to sign it in to.
    return existing.approved
      ? { kind: "send", user: existing }
      : { kind: "pending", user: existing, created: false };
  }
  // Signup by email address alone is off unless an owner turned it on: this
  // endpoint takes an arbitrary address from an unauthenticated caller, so
  // with it open, every request is both a row in `admin_users` and a mail to
  // somebody who did not ask for one.
  if (!(await deps.signupsEnabled())) return { kind: "ignore", reason: "signups-disabled" };
  return { kind: "pending", user: await deps.createPending(email), created: true };
}

const LinkRequest = z.object({ email: z.string().email().max(320) });
const LinkRedeem = z.object({ token: z.string().min(1).max(512) });

/** Why a redemption failed, in words an operator can act on. */
const REDEEM_MESSAGE: Record<string, string> = {
  unknown: "this sign-in link is not valid — request a new one",
  used: "this sign-in link has already been used — request a new one",
  expired: "this sign-in link has expired — request a new one",
  revoked: "this sign-in link was replaced by a newer one",
  unapproved: "your account is awaiting approval",
};

/**
 * Unauthenticated by construction — redeeming a link *is* the authentication —
 * so these register outside the admin scope and carry their own limiters.
 */
export function registerMagicLinkRoutes(app: FastifyInstance, ctx: AppContext): void {
  const sessionTtlSeconds = ctx.config.sessionTtlMinutes * 60;

  app.post("/api/v1/admin/session/magic-link/request", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.magicLinks.enabled) {
      return reply.code(503).send({ error: "email sign-in links are not configured on this deployment" });
    }
    if (!ctx.magicLinkLimiter.allow(req.ip)) {
      return reply.code(429).send({ error: "too many requests — try again in a minute" });
    }
    const parsed = LinkRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "a valid email address is required" });
    const email = parsed.data.email.trim().toLowerCase();

    // Second bucket, keyed on the address: the per-IP limit alone lets a
    // distributed caller mailbomb one known inbox.
    if (!ctx.magicLinkEmailLimiter.allow(email)) {
      return reply.code(429).send({ error: "too many requests — try again in a minute" });
    }

    const outcome = await resolveLinkRequest(email, {
      byEmail: (value) => ctx.adminUsers.byEmail(value),
      signupsEnabled: () => ctx.settings.getSignupsEnabled(),
      createPending: (value) => ctx.adminUsers.createPendingSignup(value),
    });

    // One response for every outcome. Whether an address has an account is not
    // something an unauthenticated caller gets to learn.
    const accepted = {
      ok: true,
      message: "If that address has an account, a sign-in link is on its way.",
    };

    if (outcome.kind === "ignore") {
      await ctx.audit.record(`ip:${req.ip}`, "session.magic_link.ignored", undefined, {
        reason: outcome.reason,
      });
      return reply.code(202).send(accepted);
    }

    if (outcome.kind === "pending") {
      await ctx.audit.record(
        `ip:${req.ip}`,
        outcome.created ? "session.signup.pending" : "session.magic_link.unapproved",
        outcome.user.id,
        { email: outcome.user.email },
      );
      await ctx.magicLinks.notify("signup-pending", outcome.user.email);
      return reply.code(202).send(accepted);
    }

    try {
      await ctx.magicLinks.send(outcome.user, "LOGIN", { requestedIp: req.ip });
      await ctx.audit.record(`ip:${req.ip}`, "session.magic_link.sent", outcome.user.id, {
        email: outcome.user.email,
      });
    } catch {
      // The provider failed. Still 202: the alternative reveals that the
      // address has an account. The failure is in the log and the audit trail.
      await ctx.audit.record(`ip:${req.ip}`, "session.magic_link.failed", outcome.user.id);
    }
    return reply.code(202).send(accepted);
  });

  /**
   * Redeem. A POST, not the GET the email links to, because the secret travels
   * in a fragment the dashboard reads and posts back — see the note at the top
   * of this file.
   */
  app.post("/api/v1/admin/session/magic-link", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.magicLinkLimiter.allow(req.ip)) {
      return reply.code(429).send({ error: "too many attempts — try again in a minute" });
    }
    const parsed = LinkRedeem.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "a sign-in link token is required" });

    const result = await ctx.loginTokens.consume(parsed.data.token);
    if (!result.ok) {
      await ctx.audit.record(`ip:${req.ip}`, "session.magic_link.rejected", undefined, {
        reason: result.reason,
      });
      return reply
        .code(result.reason === "unapproved" ? 403 : 401)
        .send({ error: REDEEM_MESSAGE[result.reason] ?? REDEEM_MESSAGE["unknown"] });
    }

    const { user, token } = result;
    const actor = cleanActor(user.displayName ?? user.email) ?? user.email;
    const cookie = await ctx.adminUsers.createSession(user, actor, sessionTtlSeconds);
    await ctx.audit.record(`admin:${actor}`, "session.login", user.id, {
      method: "magic-link",
      purpose: token.purpose,
      ip: req.ip,
    });
    return reply
      .header(
        "set-cookie",
        cookieHeader(SESSION_COOKIE, cookie, sessionTtlSeconds, isSecureRequest(req, ctx.config)),
      )
      .send({
        ok: true,
        actor,
        role: user.role,
        email: user.email,
        userId: user.id,
        // The signal the dashboard needs to push a first-run password prompt:
        // while this is false, an emailed link is the account's only key.
        // Named to match GET /session so a reload reaches the same conclusion.
        hasPassword: user.passwordHash !== null,
        expiresAt: new Date(Date.now() + sessionTtlSeconds * 1000).toISOString(),
      });
  });
}
