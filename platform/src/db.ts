import { PrismaClient } from "@prisma/client";

let prisma: PrismaClient | undefined;

export function getPrisma(databaseUrl?: string): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient(
      databaseUrl ? { datasources: { db: { url: databaseUrl } } } : undefined,
    );
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
