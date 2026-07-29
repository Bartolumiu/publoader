#!/usr/bin/env node
/**
 * Import the legacy SQLite state store (`resources/publoader.db`) into Postgres.
 *
 *   schedule_overrides  -> schedule_overrides (upsert, extension is the key)
 *   disabled_extensions -> disabled_extensions (insert-if-absent)
 *   settings            -> settings, for the two keys the platform still honours:
 *                          chapter_removal_mode, pause_until
 *
 * `run_history` is deliberately not imported: the platform's `runs` table is
 * keyed by an idempotency key and carries jobs, bundle pins, and segment state
 * that the legacy rows cannot supply. Keep the SQLite file as the historical
 * record; the count is reported so the number is not lost.
 *
 * Usage: import-sqlite [path/to/publoader.db]   (default ../resources/publoader.db)
 * Environment: DATABASE_URL.
 */
// node:sqlite is a Node 24 built-in and still flagged experimental upstream;
// it is used here in place of a native dependency because this script only
// ever performs a handful of read-only SELECTs against a small local file.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

const DEFAULT_DB = "../resources/publoader.db";
const IMPORTED_SETTING_KEYS = ["chapter_removal_mode", "pause_until"] as const;

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function asInt(value: unknown): number | null {
  if (typeof value === "number") return Math.trunc(value);
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Math.trunc(Number(value));
  }
  return null;
}

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return String(value);
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return row !== undefined;
}

async function main(): Promise<void> {
  if (!process.env["DATABASE_URL"]) {
    console.error("error: DATABASE_URL is not set");
    process.exit(1);
  }
  const dbPath = resolve(process.argv[2] ?? DEFAULT_DB);
  if (!existsSync(dbPath)) {
    console.error(`error: ${dbPath} does not exist`);
    console.error("pass the path explicitly: import-sqlite /path/to/publoader.db");
    process.exit(1);
  }

  const sqlite = new DatabaseSync(dbPath, { readOnly: true });
  const prisma = new PrismaClient();
  const summary: Record<string, string> = {};

  try {
    log(`reading ${dbPath}`);

    // ---- schedule overrides ----
    if (tableExists(sqlite, "schedule_overrides")) {
      const rows = sqlite
        .prepare("SELECT extension, hour, minute, day FROM schedule_overrides")
        .all();
      let written = 0;
      let rejected = 0;
      for (const row of rows) {
        const extension = asText(row["extension"]);
        const hour = asInt(row["hour"]);
        const minute = asInt(row["minute"]);
        const day = asInt(row["day"]);
        if (
          !extension ||
          hour === null ||
          minute === null ||
          hour < 0 ||
          hour > 23 ||
          minute < 0 ||
          minute > 59
        ) {
          console.warn(`  warn: skipping unusable schedule row ${JSON.stringify(row)}`);
          rejected += 1;
          continue;
        }
        await prisma.scheduleOverride.upsert({
          where: { extension },
          create: { extension, hour, minute, day },
          update: { hour, minute, day },
        });
        written += 1;
      }
      summary["schedule_overrides"] = `${written} imported, ${rejected} rejected`;
      log(`schedule_overrides: ${written} imported`);
    } else {
      summary["schedule_overrides"] = "table absent";
    }

    // ---- disabled extensions ----
    if (tableExists(sqlite, "disabled_extensions")) {
      const rows = sqlite.prepare("SELECT extension FROM disabled_extensions").all();
      const names = rows.map((r) => asText(r["extension"])).filter((n): n is string => !!n);
      const res = await prisma.disabledExtension.createMany({
        data: names.map((extension) => ({ extension })),
        skipDuplicates: true,
      });
      summary["disabled_extensions"] = `${res.count} imported, ${names.length - res.count} already present`;
      log(`disabled_extensions: ${res.count} imported (${names.length} in source)`);
    } else {
      summary["disabled_extensions"] = "table absent";
    }

    // ---- settings ----
    if (tableExists(sqlite, "settings")) {
      let written = 0;
      const ignored: string[] = [];
      const rows = sqlite.prepare("SELECT key, value FROM settings").all();
      for (const row of rows) {
        const key = asText(row["key"]);
        const value = asText(row["value"]);
        if (!key || value === null) continue;
        if (!(IMPORTED_SETTING_KEYS as readonly string[]).includes(key)) {
          ignored.push(key);
          continue;
        }
        await prisma.setting.upsert({
          where: { key },
          create: { key, value },
          update: { value },
        });
        written += 1;
        log(`settings: ${key} = ${value}`);
      }
      summary["settings"] =
        `${written} imported` + (ignored.length ? `, ignored: ${ignored.join(", ")}` : "");
    } else {
      summary["settings"] = "table absent";
    }

    // ---- run history (reported, not imported) ----
    if (tableExists(sqlite, "run_history")) {
      const row = sqlite.prepare("SELECT count(*) AS n FROM run_history").get();
      const n = asInt(row?.["n"]) ?? 0;
      summary["run_history"] = `${n} rows left in SQLite (not imported by design)`;
    } else {
      summary["run_history"] = "table absent";
    }

    console.log("");
    console.log("import summary");
    const width = Math.max(...Object.keys(summary).map((k) => k.length));
    for (const [key, value] of Object.entries(summary)) {
      console.log(`  ${key.padEnd(width)}  ${value}`);
    }
    console.log("");
    console.log("import complete");
  } finally {
    sqlite.close();
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().catch((err: unknown) => {
  console.error(`import failed: ${(err as Error).stack ?? String(err)}`);
  process.exit(1);
});
