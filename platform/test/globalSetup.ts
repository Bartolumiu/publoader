import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

/**
 * Integration tests need a real PostgreSQL (SKIP LOCKED and partial unique
 * indexes are the system under test — mocks would prove nothing).
 *
 * `TEST_DATABASE_URL` selects the SERVER; the database itself is created fresh
 * per run with a unique name, migrated, and dropped afterwards.
 *
 * Why per-run and not one shared `publoader_test`: `resetDb()` TRUNCATEs every
 * table between tests, so two runs against one database silently wreck each
 * other's rows — and the failures that come out are plausible-looking count
 * mismatches rather than anything that says "something else is writing here".
 * That cost real debugging time. A run now owns its database outright, which
 * also means several suites (or several people) can run at once.
 *
 * Set `TEST_DATABASE_REUSE=1` to keep using the database named in the URL
 * instead — useful when inspecting leftover state after a failure.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const base =
    process.env.TEST_DATABASE_URL ??
    "postgresql://postgres:devpass@localhost:55432/publoader_test";

  const reuse = process.env.TEST_DATABASE_REUSE === "1";
  const url = new URL(base);
  const requested = url.pathname.slice(1) || "publoader_test";
  // Postgres identifiers cap at 63 bytes; keep the suffix short and the prefix
  // recognisable so a stray database is obviously a test artefact.
  const dbName = reuse ? requested : `${requested.slice(0, 40)}_${randomBytes(4).toString("hex")}`;
  url.pathname = `/${dbName}`;
  const databaseUrl = url.toString();
  process.env.TEST_DATABASE_URL = databaseUrl;

  const adminUrl = new URL(base);
  adminUrl.pathname = "/postgres";

  const { Client } = await import("pg").catch(() => ({ Client: null as never }));
  let created = false;

  if (Client) {
    try {
      const client = new Client({ connectionString: adminUrl.toString() });
      await client.connect();
      try {
        const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
        if (exists.rowCount === 0) {
          // Identifier cannot be parameterised; dbName is ours, not input.
          await client.query(`CREATE DATABASE "${dbName}"`);
          created = !reuse;
        }
      } finally {
        await client.end();
      }
    } catch {
      // No server, or no permission to create: `migrate deploy` below reports it.
    }
  }

  try {
    // Static argv (no shell, no interpolation).
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "pipe",
    });
    process.env.TEST_DB_READY = "1";
  } catch (err) {
    process.env.TEST_DB_READY = "";
    console.warn(
      `[globalSetup] test database not available (${(err as Error).message.split("\n")[0]}); integration tests will be skipped`,
    );
  }

  return async function teardown(): Promise<void> {
    if (!created || !Client) return;
    try {
      const client = new Client({ connectionString: adminUrl.toString() });
      await client.connect();
      try {
        // Prisma's pool may still be draining; FORCE rather than fail the run
        // on a leftover connection, since the database is disposable anyway.
        await client.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      } finally {
        await client.end();
      }
    } catch (err) {
      // A leftover test database is untidy, not broken. Say so and move on:
      // failing teardown would turn a green run red for no useful reason.
      console.warn(
        `[globalSetup] could not drop ${dbName} (${(err as Error).message.split("\n")[0]}); drop it by hand if it accumulates`,
      );
    }
  };
}
