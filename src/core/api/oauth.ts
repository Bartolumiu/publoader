import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AdminUser } from "@prisma/client";
import { z } from "zod";
import type { AppContext } from "./context.js";
import {
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  cleanActor,
  cookieHeader,
  isSecureRequest,
  readCookie,
  sessionAuthenticator,
  signValue,
  unsignValue,
} from "./session.js";

/**
 * "Login with Discord" for the operator dashboard.
 *
 * No Discord library: two fetches and a redirect. All state lives in Postgres
 * or in a signed, short-lived cookie; nothing is held in process memory, so
 * this works with more than one core-api replica.
 *
 * Nothing from Discord is persisted beyond id, username and email, and neither
 * the code nor the access token is ever logged: the access token is used once,
 * inside the callback, and discarded.
 */

const STATE_TTL_SECONDS = 600;
const DISCORD_AUTHORIZE = "https://discord.com/oauth2/authorize";
const DISCORD_TOKEN = "https://discord.com/api/oauth2/token";
const DISCORD_ME = "https://discord.com/api/users/@me";

/** Only the fields we are willing to act on. */
export const DiscordIdentity = z.object({
  id: z.string().min(1).max(64),
  username: z.string().min(1).max(190),
  email: z.string().email().max(320).nullish(),
  verified: z.boolean().nullish(),
});
export type DiscordIdentity = z.infer<typeof DiscordIdentity>;

export type DiscordMatch =
  | { outcome: "login"; user: AdminUser; linked: boolean }
  | { outcome: "pending"; user: AdminUser }
  | { outcome: "signups-disabled" }
  | { outcome: "no-email" };

/**
 * Decide what a Discord identity means, with every side effect behind an
 * injected port so the decision table can be unit-tested without a database.
 *
 * Order matters and is deliberate:
 *  1. A linked discordId is the account; email changes on Discord's side
 *     must not silently repoint the login.
 *  2. Otherwise a *verified* email matching an existing account links it.
 *     Unverified email is attacker-choosable, so it can never match.
 *  3. Otherwise it is a signup, which is gated and always lands unapproved.
 */
export async function matchDiscordIdentity(
  identity: DiscordIdentity,
  deps: {
    byDiscordId: (discordId: string) => Promise<AdminUser | null>;
    byEmail: (email: string) => Promise<AdminUser | null>;
    linkDiscord: (userId: string, discordId: string, username: string) => Promise<AdminUser>;
    createFromDiscord: (opts: {
      email: string;
      discordId: string;
      discordUsername: string;
    }) => Promise<AdminUser>;
    signupsEnabled: () => Promise<boolean>;
  },
): Promise<DiscordMatch> {
  const linked = await deps.byDiscordId(identity.id);
  if (linked) {
    const refreshed =
      linked.discordUsername === identity.username
        ? linked
        : await deps.linkDiscord(linked.id, identity.id, identity.username);
    return linked.approved
      ? { outcome: "login", user: refreshed, linked: false }
      : { outcome: "pending", user: refreshed };
  }

  const email = identity.verified ? identity.email : null;
  if (!email) return { outcome: "no-email" };

  const byEmail = await deps.byEmail(email);
  if (byEmail) {
    // Claiming an existing account requires that account's email to be the
    // verified one on the Discord side, which is the whole check.
    const user = await deps.linkDiscord(byEmail.id, identity.id, identity.username);
    return byEmail.approved
      ? { outcome: "login", user, linked: true }
      : { outcome: "pending", user };
  }

  if (!(await deps.signupsEnabled())) return { outcome: "signups-disabled" };
  const created = await deps.createFromDiscord({
    email,
    discordId: identity.id,
    discordUsername: identity.username,
  });
  return { outcome: "pending", user: created };
}

/**
 * The OAuth state cookie has to carry *why* we sent the operator to Discord,
 * because the two reasons end in opposite places: a login mints a session for
 * whoever comes back, a link attaches that identity to a session that already
 * exists. Encoded into the signed value rather than a second cookie so the
 * HMAC covers the intent too; otherwise a login round-trip could be replayed
 * as a link, or the reverse.
 */
export type OAuthIntent = { mode: "login" } | { mode: "link"; userId: string };

export function encodeState(intent: OAuthIntent, nonce: string): string {
  return intent.mode === "link" ? `link.${intent.userId}.${nonce}` : `login.${nonce}`;
}

export function decodeState(value: string): { intent: OAuthIntent; nonce: string } | null {
  const parts = value.split(".");
  if (parts[0] === "login" && parts.length === 2 && parts[1]) {
    return { intent: { mode: "login" }, nonce: parts[1] };
  }
  if (parts[0] === "link" && parts.length === 3 && parts[1] && parts[2]) {
    return { intent: { mode: "link", userId: parts[1] }, nonce: parts[2] };
  }
  return null;
}

/** Small self-contained result page; the SPA is not involved in the redirect. */
function notice(title: string, message: string, linkLabel = "Back to sign in"): string {
  const escape = (text: string) =>
    text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · publoader</title>
<link rel="stylesheet" href="/dash/style.css"></head>
<body><main><div class="card"><h2>${escape(title)}</h2>
<p>${escape(message)}</p><p><a href="/">${escape(linkLabel)}</a></p></div></main></body></html>`;
}

export function registerOAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const configured = (): boolean =>
    Boolean(ctx.config.discordClientId && ctx.config.discordClientSecret && ctx.signingKey);
  const redirectUri = `${ctx.config.dashPublicUrl.replace(/\/+$/, "")}/api/v1/admin/oauth/discord/callback`;
  const authenticate = sessionAuthenticator(ctx);

  const html = (reply: FastifyReply, code: number, title: string, message: string) =>
    reply.code(code).type("text/html; charset=utf-8").send(notice(title, message));

  /** Both entry points differ only in the intent baked into the state cookie. */
  const begin = (req: FastifyRequest, reply: FastifyReply, intent: OAuthIntent) => {
    const nonce = randomBytes(24).toString("base64url");
    const params = new URLSearchParams({
      client_id: ctx.config.discordClientId!,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "identify email",
      state: nonce,
      // Linking is a deliberate act on an account that is already signed in;
      // silently reusing whichever Discord session the browser happens to hold
      // is how the wrong identity gets attached. Make Discord ask.
      ...(intent.mode === "link" ? { prompt: "consent" } : { prompt: "none" }),
    });
    return reply
      // Lax, not Strict: the cookie has to survive Discord's cross-site
      // redirect back to us, which a Strict cookie would not be sent on.
      .header(
        "set-cookie",
        cookieHeader(
          OAUTH_STATE_COOKIE,
          signValue(encodeState(intent, nonce), ctx.signingKey!),
          STATE_TTL_SECONDS,
          isSecureRequest(req, ctx.config),
          "Lax",
        ),
      )
      .redirect(`${DISCORD_AUTHORIZE}?${params.toString()}`, 302);
  };

  app.get("/api/v1/admin/oauth/discord/start", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!configured()) return html(reply, 503, "Discord login unavailable", "This deployment has no Discord OAuth application configured.");
    if (!ctx.sessionLimiter.allow(req.ip)) {
      return html(reply, 429, "Slow down", "Too many login attempts from this address. Try again in a minute.");
    }
    return begin(req, reply, { mode: "login" });
  });

  /**
   * Attach a Discord identity to the account that is already signed in.
   *
   * This is the direction the login flow cannot cover: it matches an existing
   * account only when Discord's *verified* email happens to equal the account
   * email. Somebody whose Discord address differs from their operator address
   * has no way to end up with both credentials on one account; this is it.
   * Here the session is the authorisation, so the emails need not match.
   */
  app.get("/api/v1/admin/oauth/discord/link", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!configured()) return html(reply, 503, "Discord login unavailable", "This deployment has no Discord OAuth application configured.");
    const session = await authenticate(req);
    if (!session) {
      return html(reply, 401, "Sign in first", "Linking Discord attaches it to the account you are signed in as, so you have to be signed in.");
    }
    if (!ctx.sessionLimiter.allow(req.ip)) {
      return html(reply, 429, "Slow down", "Too many attempts from this address. Try again in a minute.");
    }
    return begin(req, reply, { mode: "link", userId: session.userId });
  });

  app.get("/api/v1/admin/oauth/discord/callback", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!configured()) return html(reply, 503, "Discord login unavailable", "This deployment has no Discord OAuth application configured.");

    const query = z
      .object({ code: z.string().min(1).max(512).optional(), state: z.string().min(1).max(256).optional() })
      .safeParse(req.query ?? {});
    const stateCookie = readCookie(req.headers.cookie, OAUTH_STATE_COOKIE);
    const signed = stateCookie ? unsignValue(stateCookie, ctx.signingKey!) : null;
    const state = signed ? decodeState(signed) : null;

    const clearState = cookieHeader(OAUTH_STATE_COOKIE, "", 0, isSecureRequest(req, ctx.config), "Lax");
    const fail = (code: number, title: string, message: string) =>
      reply.header("set-cookie", clearState).code(code).type("text/html; charset=utf-8").send(notice(title, message));

    if (!query.success || !query.data.code || !query.data.state) {
      return fail(400, "Login failed", "Discord did not return an authorisation code.");
    }
    // Constant-time is unnecessary here: the nonce is single-use and both
    // sides are attacker-visible. What matters is that it must match at all.
    if (!state || state.nonce !== query.data.state) {
      return fail(400, "Login failed", "The login link expired or was replayed. Start again from the sign-in page.");
    }

    let identity: DiscordIdentity;
    try {
      identity = await exchangeDiscordCode(query.data.code, {
        clientId: ctx.config.discordClientId!,
        clientSecret: ctx.config.discordClientSecret!,
        redirectUri,
      });
    } catch (err) {
      // Never log err verbatim: a token exchange failure body can echo the code.
      ctx.log.warn({ stage: "discord-oauth", reason: (err as Error).message }, "discord login failed");
      return fail(502, "Login failed", "Could not complete the exchange with Discord. Try again.");
    }

    // ---- linking an identity onto the session that started the round-trip ----
    if (state.intent.mode === "link") {
      // The signed state says which account asked. The live session says who
      // is actually here. Both must agree: a signed-out or switched browser
      // must not be able to finish somebody else's linking round-trip.
      const session = await authenticate(req);
      if (!session || session.userId !== state.intent.userId) {
        return fail(401, "Linking failed", "Your session ended before Discord came back. Sign in and try again.");
      }
      const linked = await ctx.adminUsers.byDiscordId(identity.id);
      if (linked && linked.id !== session.userId) {
        await ctx.audit.record(`admin:${session.actor}`, "admin_user.discord_link.rejected", session.userId, {
          reason: "already linked to another account",
        });
        return fail(
          409,
          "Already linked",
          "That Discord account is already attached to a different operator account. Unlink it there first.",
        );
      }
      await ctx.adminUsers.linkDiscord(session.userId, identity.id, identity.username);
      await ctx.audit.record(`admin:${session.actor}`, "admin_user.discord_link", session.userId, {
        discordUsername: identity.username,
      });
      return reply
        .header("set-cookie", clearState)
        .code(200)
        .type("text/html; charset=utf-8")
        .send(
          notice(
            "Discord linked",
            `${identity.username} is now attached to your account. You can sign in with either Discord or your email.`,
            "Back to the dashboard",
          ),
        );
    }

    const match = await matchDiscordIdentity(identity, {
      byDiscordId: (id) => ctx.adminUsers.byDiscordId(id),
      byEmail: (email) => ctx.adminUsers.byEmail(email),
      linkDiscord: (userId, discordId, username) => ctx.adminUsers.linkDiscord(userId, discordId, username),
      createFromDiscord: (opts) => ctx.adminUsers.createFromDiscord(opts),
      signupsEnabled: () => ctx.settings.getSignupsEnabled(),
    });

    if (match.outcome === "no-email") {
      return fail(403, "Login failed", "Your Discord account has no verified email address, so it cannot be matched to an operator account.");
    }
    if (match.outcome === "signups-disabled") {
      await ctx.audit.record(`discord:${identity.id}`, "session.signup.rejected", undefined, { reason: "signups disabled" });
      return fail(403, "Signups are closed", "This dashboard is not accepting new accounts. Ask an owner to invite your email address.");
    }
    if (match.outcome === "pending") {
      await ctx.audit.record(`discord:${identity.id}`, "session.signup.pending", match.user.id, {
        email: match.user.email,
      });
      return reply
        .header("set-cookie", clearState)
        .code(200)
        .type("text/html; charset=utf-8")
        .send(notice("Awaiting approval", "Your account exists but has not been approved yet. An owner has to approve it before you can sign in."));
    }

    const actor = cleanActor(match.user.displayName ?? identity.username) ?? match.user.email;
    const cookie = await ctx.adminUsers.createSession(match.user, actor, ctx.config.sessionTtlMinutes * 60);
    await ctx.audit.record(`admin:${actor}`, "session.login", match.user.id, {
      method: "discord",
      ip: req.ip,
      linked: match.linked,
    });
    return reply
      .header("set-cookie", clearState)
      .header(
        "set-cookie",
        cookieHeader(SESSION_COOKIE, cookie, ctx.config.sessionTtlMinutes * 60, isSecureRequest(req, ctx.config)),
      )
      .redirect("/", 302);
  });
}

/**
 * Code → access token → identity. Separated so the route body stays about
 * policy; throws with a non-sensitive message on every failure.
 */
export async function exchangeDiscordCode(
  code: string,
  opts: { clientId: string; clientSecret: string; redirectUri: string },
  fetchImpl: typeof fetch = fetch,
): Promise<DiscordIdentity> {
  const tokenRes = await fetchImpl(DISCORD_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: opts.redirectUri,
    }),
  });
  if (!tokenRes.ok) throw new Error(`token endpoint returned ${tokenRes.status}`);
  const token = z
    .object({ access_token: z.string().min(1), token_type: z.string().optional() })
    .safeParse(await tokenRes.json());
  if (!token.success) throw new Error("token endpoint returned an unexpected body");

  const meRes = await fetchImpl(DISCORD_ME, {
    headers: { authorization: `Bearer ${token.data.access_token}` },
  });
  if (!meRes.ok) throw new Error(`identity endpoint returned ${meRes.status}`);
  const identity = DiscordIdentity.safeParse(await meRes.json());
  if (!identity.success) throw new Error("identity endpoint returned an unexpected body");
  return identity.data;
}
