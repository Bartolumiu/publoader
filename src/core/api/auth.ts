import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { AdminRole, Worker } from "@prisma/client";
import type { WorkerStore } from "../store/workers.js";
import type { ApiTokenStore } from "../store/apiTokens.js";
import {
  hasScope,
  intersectScopes,
  scopesForRole,
  WILDCARD,
  type Principal,
  type Scope,
} from "./scopes.js";

/**
 * Two strictly separated token audiences:
 *  - worker tokens (`pw_…`, hashed at rest) authorize ONLY /api/v1/worker/*;
 *  - the admin token authorizes ONLY /api/v1/admin/*.
 * A worker token can never call admin routes and vice versa. Comparisons are
 * constant-time.
 *
 * Admin routes additionally accept a dashboard session cookie, which is the
 * same audience by another carrier (see `session.ts`). Because a cookie is
 * attached by the browser automatically, cookie-authed writes must also carry
 * a header no cross-origin form can set; SameSite=Strict is the first line of
 * CSRF defence, this is the second.
 */

export const CSRF_HEADER = "x-requested-with";
export const CSRF_VALUE = "publoader-dash";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so length is the only observable difference.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
}

declare module "fastify" {
  interface FastifyRequest {
    worker?: Worker;
    /** Who is calling and what they may do; set by `adminAuthHook`. */
    principal?: Principal;
    /** How the admin request authenticated; set by `adminAuthHook`. */
    adminAuth?: "bearer" | "api-token" | "session";
    /** Logged-in operator name, for cookie sessions only. */
    adminActor?: string;
    /** Effective role. The bearer token is owner-equivalent by definition. */
    adminRole?: AdminRole;
    /** Account and session behind a cookie-authenticated request. */
    adminUserId?: string;
    adminSessionId?: string;
  }
}

export function workerAuthHook(workers: WorkerStore) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = bearerToken(req);
    if (!token || !token.startsWith("pw_")) {
      await reply.code(401).send({ error: "worker token required" });
      return;
    }
    const worker = await workers.authenticate(token);
    if (!worker) {
      await reply.code(401).send({ error: "invalid or revoked worker token" });
      return;
    }
    req.worker = worker;
  };
}

export interface AdminPrincipal {
  actor: string;
  role: AdminRole;
  userId: string;
  sessionId: string;
  /**
   * The account's effective scope set, already tuned. Optional so a caller
   * that has no permission store to consult still gets the shipped defaults
   * for the role rather than nothing.
   */
  scopes?: readonly string[];
}

export interface AdminAuthOptions {
  adminToken: string | undefined;
  /**
   * Resolves a dashboard session from the request, or null. Injected rather
   * than imported so the auth and session modules stay acyclic.
   */
  session?: (req: FastifyRequest) => Promise<AdminPrincipal | null>;
  /** Scoped per-client `pa_…` tokens. */
  apiTokens?: ApiTokenStore;
  /**
   * Resolves a Discord user id to the dashboard account linked to it, or null.
   * Injected for the same reason `session` is: keeps this module acyclic.
   *
   * Absent means the deployment does not support acting-on-behalf-of, and any
   * request asking for it is refused rather than quietly run as the token.
   */
  impersonation?: (discordId: string) => Promise<ImpersonatedUser | null>;
}

/** The dashboard account a request is being made on behalf of. */
export interface ImpersonatedUser {
  userId: string;
  role: AdminRole;
  email: string;
  /** That account's effective scopes, already resolved from role and tuning. */
  scopes: string[];
}

/**
 * Names the Discord user a bot command came from, so the request runs with that
 * person's dashboard permissions rather than the bot's blanket ones.
 */
export const ON_BEHALF_OF_HEADER = "x-on-behalf-of-discord";

function onBehalfOf(req: FastifyRequest): string | null {
  const raw = req.headers[ON_BEHALF_OF_HEADER];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
  // A snowflake is always numeric; anything else is a caller error, not an id.
  return /^\d{5,25}$/.test(value) ? value : null;
}

export function adminAuthHook(opts: AdminAuthOptions) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!opts.adminToken) {
      await reply.code(503).send({ error: "admin API disabled: ADMIN_TOKEN not configured" });
      return;
    }
    // A presented bearer token is judged on its own: falling through to the
    // cookie on a bad token would let a stale CLI credential ride a browser
    // session it never authenticated.
    const token = bearerToken(req);
    if (token) {
      // Scoped per-client credential: authority comes from its stored scopes,
      // so a leak is confined to that client's area.
      if (token.startsWith("pa_")) {
        const row = await opts.apiTokens?.authenticate(token);
        if (!row) {
          await reply.code(401).send({ error: "invalid, revoked, or expired api token" });
          return;
        }
        opts.apiTokens?.touch(row.id);
        req.adminAuth = "api-token";
        req.principal = {
          kind: "api-token",
          name: `token:${row.name}`,
          scopes: row.scopes,
          tokenId: row.id,
        };
        // Scoped tokens are never owner-equivalent, whatever they hold:
        // account administration requires `users:admin`, checked per route.
        req.adminRole = "ADMIN";

        const actingFor = onBehalfOf(req);
        if (actingFor !== null) {
          if (!opts.impersonation) {
            await reply.code(403).send({ error: `${ON_BEHALF_OF_HEADER} is not accepted by this endpoint` });
            return;
          }
          const user = await opts.impersonation(actingFor);
          if (!user) {
            // Said plainly, because this reaches a human in Discord: the fix is
            // to link an account, not to widen a token.
            await reply.code(403).send({
              error: "no approved dashboard account is linked to that Discord account",
              detail:
                "Sign in to the dashboard and link Discord, or ask an owner to approve the account, then try again.",
            });
            return;
          }
          // The intersection is the whole security property: acting for someone
          // can only narrow what this token could already do. A read-only
          // account stays read-only however broadly the bot is scoped, and a
          // compromised bot gains nothing by naming an owner.
          req.principal = {
            kind: "api-token",
            name: `${row.name} as ${user.email}`,
            scopes: intersectScopes(row.scopes, user.scopes),
            tokenId: row.id,
          };
          req.adminUserId = user.userId;
          // Deliberately capped: OWNER is the role that edits permissions and
          // accounts, and `requireOwner` exists to keep tokens out of those
          // routes. Letting impersonation reach it would hand a bot the one
          // thing no token is allowed to have.
          req.adminRole = user.role === "OWNER" ? "ADMIN" : user.role;
        }
        return;
      }
      if (!constantTimeEqual(token, opts.adminToken)) {
        await reply.code(401).send({ error: "admin token required" });
        return;
      }
      req.adminAuth = "bearer";
      // The break-glass credential outranks every account by construction:
      // it is the way back in when the accounts table is the problem.
      req.adminRole = "OWNER";
      req.principal = { kind: "root", name: "root", scopes: [WILDCARD] };
      return;
    }

    const session = (await opts.session?.(req)) ?? null;
    if (!session) {
      await reply.code(401).send({ error: "admin token required" });
      return;
    }
    if (!SAFE_METHODS.has(req.method) && req.headers[CSRF_HEADER] !== CSRF_VALUE) {
      await reply.code(403).send({ error: `cookie-authenticated writes require ${CSRF_HEADER}: ${CSRF_VALUE}` });
      return;
    }
    req.adminAuth = "session";
    req.adminActor = session.actor;
    req.adminRole = session.role;
    req.adminUserId = session.userId;
    req.adminSessionId = session.sessionId;
    req.principal = {
      kind: "session",
      // Kind-prefixed to match the rest of the audit log (worker:…, token:…,
      // ip:…), so an actor string always says what sort of thing acted.
      name: `user:${session.actor}`,
      // Already tuned by the session resolver; the role default is the floor
      // for a caller that supplied no store to tune against.
      scopes: session.scopes ?? scopesForRole(session.role),
    };
  };
}

/**
 * Per-route scope guard. Register after `adminAuthHook`, which populates the
 * principal.
 *
 * The 403 names the missing scope deliberately: the caller already proved it
 * holds a valid credential, and "which scope do I need?" is the only useful
 * next question; leaving them to guess is how over-granted tokens happen.
 */
export function requireScope(required: Scope) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const principal = req.principal;
    if (!principal) {
      await reply.code(401).send({ error: "unauthenticated" });
      return;
    }
    if (!hasScope(principal, required)) {
      await reply.code(403).send({
        error: `missing scope: ${required}`,
        held: principal.scopes,
      });
    }
  };
}

/**
 * Second-stage guard for the operations that manage *who else* has access;
 * accounts, roles, the signup gate, and force-logout. Register it after
 * `adminAuthHook`, which is what populates `adminRole`.
 */
export async function requireOwner(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.adminRole !== "OWNER") {
    await reply.code(403).send({ error: "owner role required" });
  }
}
