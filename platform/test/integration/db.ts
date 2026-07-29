import { PrismaClient } from "@prisma/client";

/** Shared integration-test DB access. Files call `skipIfNoDb()` first. */

export const dbReady = (): boolean => process.env.TEST_DB_READY === "1";

let client: PrismaClient | undefined;

export function testPrisma(): PrismaClient {
  if (!client) {
    client = new PrismaClient({
      datasources: { db: { url: process.env.TEST_DATABASE_URL } },
    });
  }
  return client;
}

/** Wipe all platform tables between tests (order-independent via TRUNCATE CASCADE). */
export async function resetDb(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      result_submissions, jobs, runs, artifacts, bundles, upload_tasks,
      uploaded_chapters, uploaded_ids, edited_chapters, unavailable_chapters,
      upload_log, schedule_overrides, disabled_extensions, settings,
      audit_events, workers, enroll_tokens, untracked_manga, tracked_manga,
      extension_configs, admin_sessions, admin_users
    CASCADE
  `);
}

export async function closeDb(): Promise<void> {
  await client?.$disconnect();
  client = undefined;
}
