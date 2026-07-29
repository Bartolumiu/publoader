import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { AdminRole, Worker } from "@prisma/client";
import type { WorkerStore } from "../store/workers.js";

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
 * a header no cross-origin form can set — SameSite=Strict is the first line of
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
    /** How the admin request authenticated; set by `adminAuthHook`. */
    adminAuth?: "bearer" | "session";
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
}

export interface AdminAuthOptions {
  adminToken: string | undefined;
  /**
   * Resolves a dashboard session from the request, or null. Injected rather
   * than imported so the auth and session modules stay acyclic.
   */
  session?: (req: FastifyRequest) => Promise<AdminPrincipal | null>;
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
      if (!constantTimeEqual(token, opts.adminToken)) {
        await reply.code(401).send({ error: "admin token required" });
        return;
      }
      req.adminAuth = "bearer";
      // The break-glass credential outranks every account by construction:
      // it is the way back in when the accounts table is the problem.
      req.adminRole = "OWNER";
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
  };
}

/**
 * Second-stage guard for the operations that manage *who else* has access —
 * accounts, roles, the signup gate, and force-logout. Register it after
 * `adminAuthHook`, which is what populates `adminRole`.
 */
export async function requireOwner(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.adminRole !== "OWNER") {
    await reply.code(403).send({ error: "owner role required" });
  }
}
