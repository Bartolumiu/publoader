import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { Worker } from "@prisma/client";
import type { WorkerStore } from "../store/workers.js";

/**
 * Two strictly separated token audiences:
 *  - worker tokens (`pw_…`, hashed at rest) authorize ONLY /api/v1/worker/*;
 *  - the admin token authorizes ONLY /api/v1/admin/*.
 * A worker token can never call admin routes and vice versa; there is no
 * shared "session". Comparisons are constant-time.
 */

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

export function adminAuthHook(adminToken: string | undefined) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!adminToken) {
      await reply.code(503).send({ error: "admin API disabled: ADMIN_TOKEN not configured" });
      return;
    }
    const token = bearerToken(req);
    if (!token || !constantTimeEqual(token, adminToken)) {
      await reply.code(401).send({ error: "admin token required" });
      return;
    }
  };
}
