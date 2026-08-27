import { PrismaClient } from "@prisma/client";
import { logSink } from "./core/observability/logSink.js";

let prisma: PrismaClient | undefined;

export function getPrisma(databaseUrl?: string): PrismaClient {
  if (!prisma && databaseUrl !== undefined && databaseUrl === "") {
    throw new Error("DATABASE_URL is required for core services (never set it on workers)");
  }
  if (!prisma) {
    prisma = new PrismaClient(
      databaseUrl ? { datasources: { db: { url: databaseUrl } } } : undefined,
    );
    // Start persisting logs here rather than in each service, so a service
    // cannot be added later and quietly not appear in the log page. Worker
    // agents never reach this — they have no DATABASE_URL by design — so the
    // sink stays an unread in-memory buffer there.
    logSink.enable(prisma);
  }
  return prisma;
}

/** For tests: inject a client (e.g. pointed at a scratch schema). */
export function setPrisma(client: PrismaClient): void {
  prisma = client;
}

export async function disconnect(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = undefined;
  }
}
