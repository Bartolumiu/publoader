import { execFileSync } from "node:child_process";

/**
 * Integration tests need a real PostgreSQL (SKIP LOCKED and partial unique
 * indexes are the system under test — mocks would prove nothing).
 *
 * TEST_DATABASE_URL selects the server; defaults to the local dev container
 * (docker run -d -p 55432:5432 -e POSTGRES_PASSWORD=devpass postgres:16-alpine).
 * A dedicated `publoader_test` database is created and migrated here. Unit
 * tests never touch the DB; if the server is unreachable, integration files
 * skip themselves (see test/integration/db.ts).
 */
export default async function setup(): Promise<void> {
  const base =
    process.env.TEST_DATABASE_URL ??
    "postgresql://postgres:devpass@localhost:55432/publoader_test";
  process.env.TEST_DATABASE_URL = base;

  try {
    const url = new URL(base);
    const dbName = url.pathname.slice(1);
    const adminUrl = new URL(base);
    adminUrl.pathname = "/postgres";
    const { Client } = await import("pg").catch(() => ({ Client: null as never }));
    if (Client) {
      const client = new Client({ connectionString: adminUrl.toString() });
      await client.connect();
      const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
      if (exists.rowCount === 0) await client.query(`CREATE DATABASE "${dbName}"`);
      await client.end();
    }
  } catch {
    // No pg driver or no server — prisma migrate below will tell us.
  }

  try {
    // Static argv (no shell, no interpolation).
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, DATABASE_URL: base },
      stdio: "pipe",
    });
    process.env.TEST_DB_READY = "1";
  } catch (err) {
    process.env.TEST_DB_READY = "";
    console.warn(
      `[globalSetup] test database not available (${(err as Error).message.split("\n")[0]}); integration tests will be skipped`,
    );
  }
}
