import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AdminRole, AdminUser } from "@prisma/client";
import { z } from "zod";
import type { AppContext } from "./context.js";
import type { Config } from "../../config.js";
import type { Logger } from "../../logging.js";
import { constantTimeEqual } from "./auth.js";
import { verifyPassword } from "../store/adminUsers.js";

/**
 * Browser sessions for the operator dashboard.
 *
 * The dashboard cannot hold a bearer token: anything reachable from page
 * JavaScript is reachable from an XSS. Instead the operator authenticates once
 * and receives an HttpOnly, SameSite=Strict cookie.
 *
 * The cookie is `${sessionId}.${secret}` and the authority is the
 * `admin_sessions` row, not the cookie's contents — which is what makes a
 * single session revocable without signing everyone else out. Only a sha256 of
 * the secret is stored, so the table is not a credential store.
 */

export const SESSION_COOKIE = "publoader_session";
/** Short-lived cookie carrying the signed OAuth state nonce. */
export const OAUTH_STATE_COOKIE = "publoader_oauth_state";

/** Bound what we are willing to parse; a session cookie is ~90 bytes. */
const MAX_COOKIE_BYTES = 4096;

/**
 * HMAC key for short-lived signed cookies (the OAuth state nonce). Session
 * cookies no longer depend on it — they are DB rows. An explicit
 * SESSION_SECRET is preferred; otherwise derive from the admin token via HKDF
 * so the raw token is never itself an HMAC key.
 */
export function deriveSigningKey(config: Config, log: Logger): Buffer | null {
  if (config.sessionSecret) return Buffer.from(config.sessionSecret, "utf8");
  if (!config.adminToken) return null;
  log.warn(
    "SESSION_SECRET is not set: deriving the cookie signing key from ADMIN_TOKEN. " +
      "Rotating ADMIN_TOKEN will invalidate in-flight Discord logins.",
  );
  return Buffer.from(hkdfSync("sha256", config.adminToken, "publoader-session-v1", "dashboard-cookie-hmac", 32));
}

export function signValue(value: string, key: Buffer): string {
  return `${value}.${createHmac("sha256", key).update(value).digest("base64url")}`;
}

/** Returns the value only when the signature verifies. */
export function unsignValue(signed: string, key: Buffer): string | null {
  if (signed.length > MAX_COOKIE_BYTES) return null;
  const dot = signed.lastIndexOf(".");
  if (dot <= 0 || dot === signed.length - 1) return null;
  const value = signed.slice(0, dot);
  const given = signed.slice(dot + 1);
  const expected = createHmac("sha256", key).update(value).digest("base64url");
  if (given.length !== expected.length) return null;
  return timingSafeEqual(Buffer.from(given, "utf8"), Buffer.from(expected, "utf8")) ? value : null;
}

/** Read one cookie out of a raw Cookie header without pulling in a plugin. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header || header.length > MAX_COOKIE_BYTES * 4) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim() || null;
  }
  return null;
}

export interface SessionPrincipal {
  actor: string;
  role: AdminRole;
  userId: string;
  sessionId: string;
}

/**
 * Adapter handed to `adminAuthHook` so the auth layer never has to know how
 * sessions are stored (and so the two modules do not import each other).
 */
export function sessionAuthenticator(ctx: AppContext) {
  return async (req: FastifyRequest): Promise<SessionPrincipal | null> => {
    const raw = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (!raw || raw.length > MAX_COOKIE_BYTES) return null;
    const resolved = await ctx.adminUsers.resolveSession(raw);
    if (!resolved) return null;
    return {
      actor: resolved.actor,
      role: resolved.role,
      userId: resolved.userId,
      sessionId: resolved.sessionId,
    };
  };
}

/** Behind cloudflared/nginx the socket is plain HTTP; trust the proxy's scheme. */
export function isSecureRequest(req: FastifyRequest, config: Config): boolean {
  if (config.sessionCookieSecure) return true;
  const proto = req.headers["x-forwarded-proto"];
  const first = Array.isArray(proto) ? proto[0] : proto;
  return (first ?? "").split(",")[0]?.trim() === "https";
}

export function cookieHeader(
  name: string,
  value: string,
  maxAgeSeconds: number,
  secure: boolean,
  sameSite: "Strict" | "Lax" = "Strict",
): string {
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", `SameSite=${sameSite}`, `Max-Age=${maxAgeSeconds}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** Control characters would corrupt log lines and the audit table. */
export function cleanActor(raw: string): string | null {
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 64) : null;
}

const TokenLogin = z.object({
  token: z.string().min(1).max(512),
  actor: z.string().min(1).max(64).optional(),
});

const PasswordLogin = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(1024),
});

/**
 * Session endpoints. Unauthenticated by construction — POST /session *is* the
 * authentication — so they live outside the admin scope and carry their own
 * per-IP limiter.
 */
export function registerSessionRoutes(app: FastifyInstance, ctx: AppContext): void {
  const ttlSeconds = ctx.config.sessionTtlMinutes * 60;
  const authenticate = sessionAuthenticator(ctx);

  const issue = async (
    reply: FastifyReply,
    req: FastifyRequest,
    user: AdminUser,
    actor: string,
  ) => {
    const cookie = await ctx.adminUsers.createSession(user, actor, ttlSeconds);
    await ctx.audit.record(`admin:${actor}`, "session.login", user.id, { ip: req.ip, email: user.email });
    return reply
      .header(
        "set-cookie",
        cookieHeader(SESSION_COOKIE, cookie, ttlSeconds, isSecureRequest(req, ctx.config)),
      )
      .send({
        ok: true,
        actor,
        role: user.role,
        email: user.email,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      });
  };

  /**
   * Which login methods to render. Unauthenticated on purpose: it exposes only
   * whether OAuth is configured and whether signups are open, both of which
   * are visible from the login page anyway.
   */
  app.get("/api/v1/admin/session/methods", async () => ({
    discord: Boolean(ctx.config.discordClientId && ctx.config.discordClientSecret),
    signups: await ctx.settings.getSignupsEnabled(),
    password: true,
    // Whether "email me a sign-in link" is offered. This is also the only way
    // into an invited account that has not set a password yet, so a deployment
    // with it off has to bootstrap those accounts by hand.
    magicLink: ctx.magicLinks.enabled,
  }));

  app.post("/api/v1/admin/session", async (req: FastifyRequest, reply: FastifyReply) => {
    // Rate limit before any comparison so neither path is a timing oracle for
    // an attacker willing to spend attempts.
    if (!ctx.sessionLimiter.allow(req.ip)) {
      return reply.code(429).send({ error: "too many login attempts" });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;

    // --- break-glass: the admin token, attached to the seeded owner ---
    if (typeof body["token"] === "string") {
      if (!ctx.config.adminToken) {
        return reply.code(503).send({ error: "admin API disabled: ADMIN_TOKEN not configured" });
      }
      const parsed = TokenLogin.safeParse(body);
      if (!parsed.success) return reply.code(400).send({ error: "token is required" });
      const actor = cleanActor(parsed.data.actor ?? "token") ?? "token";
      if (!constantTimeEqual(parsed.data.token, ctx.config.adminToken)) {
        await ctx.audit.record(`ip:${req.ip}`, "session.login.rejected", undefined, { method: "token", actor });
        return reply.code(401).send({ error: "invalid admin token" });
      }
      // The token is owner-equivalent, so its session hangs off the seeded
      // owner account — that is what makes it the way to bootstrap a password.
      const owner = await ctx.adminUsers.ensureOwner(ctx.config.dashOwnerEmail);
      return issue(reply, req, owner, actor);
    }

    // --- normal path: email + password ---
    const parsed = PasswordLogin.safeParse(body);
    if (!parsed.success) return reply.code(400).send({ error: "email and password are required" });
    const user = await ctx.adminUsers.byEmail(parsed.data.email);
    const ok = await verifyPassword(parsed.data.password, user?.passwordHash ?? null);
    if (!user || !ok) {
      await ctx.audit.record(`ip:${req.ip}`, "session.login.rejected", undefined, {
        method: "password",
        email: parsed.data.email.slice(0, 320),
      });
      // One message for "no such account" and "wrong password" alike.
      return reply.code(401).send({ error: "invalid email or password" });
    }
    if (!user.approved) {
      await ctx.audit.record(`ip:${req.ip}`, "session.login.unapproved", user.id);
      return reply.code(403).send({ error: "account is awaiting approval" });
    }
    return issue(reply, req, user, cleanActor(user.displayName ?? user.email) ?? user.email);
  });

  /**
   * Who am I? The cookie is HttpOnly, so a reloaded page cannot read its own
   * actor back out — it has to ask. Safe to leave unauthenticated: it reports
   * only what the caller's own session already grants.
   */
  app.get("/api/v1/admin/session", async (req: FastifyRequest, reply: FastifyReply) => {
    const session = await authenticate(req);
    if (!session) return reply.code(401).send({ error: "no active session" });
    const user = await ctx.adminUsers.byId(session.userId);
    return {
      actor: session.actor,
      role: session.role,
      userId: session.userId,
      email: user?.email ?? null,
      hasPassword: Boolean(user?.passwordHash),
      // Which credentials this account actually has, so the page can offer the
      // missing ones rather than guessing from the role.
      discordUsername: user?.discordUsername ?? null,
      discordLinked: Boolean(user?.discordId),
      magicLink: ctx.magicLinks.enabled,
      discordAvailable: Boolean(ctx.config.discordClientId && ctx.config.discordClientSecret),
    };
  });

  app.delete("/api/v1/admin/session", async (req: FastifyRequest, reply: FastifyReply) => {
    const session = await authenticate(req);
    if (session) {
      await ctx.adminUsers.revokeSession(session.sessionId);
      await ctx.audit.record(`admin:${session.actor}`, "session.logout", session.sessionId);
    }
    return reply
      .header("set-cookie", cookieHeader(SESSION_COOKIE, "", 0, isSecureRequest(req, ctx.config)))
      .send({ ok: true });
  });
}
