import { Prisma, type PrismaClient } from "@prisma/client";

/**
 * Keeps log lines so the dashboard can show them.
 *
 * Logs went to stdout and nowhere else, which made `docker compose logs` on the
 * host the only way to read them. Anything a run reported — why a chapter was
 * skipped, what a check concluded — was unreadable to an operator and to the
 * admin API, and gone entirely once the container restarted.
 *
 * Three properties matter more than completeness here:
 *
 *  - Logging must never block. Every write lands in memory and returns; the
 *    database is touched on a timer, off the caller's path. A slow or missing
 *    database changes throughput, not behaviour.
 *  - The buffer must never grow without bound. A database outage is exactly
 *    when logging gets loud, so the buffer is capped and drops the OLDEST lines
 *    first: during an incident the newest lines are the ones being read.
 *  - A failed flush must not cascade. Losing diagnostic lines is a nuisance;
 *    an exception thrown out of a log call would take down whatever was being
 *    logged about.
 */

interface PendingLog {
  level: number;
  service: string;
  component: string | null;
  runId: string | null;
  jobId: string | null;
  msg: string;
  fields: Record<string, unknown> | null;
  createdAt: Date;
}

/**
 * How many lines may wait in memory, and how often they are written.
 *
 * A second of buffering is short enough that the page feels live and long
 * enough that a busy run inserts in batches of hundreds rather than one
 * statement per line.
 */
const MAX_BUFFERED = 5_000;
const FLUSH_INTERVAL_MS = 1_000;
const MAX_BATCH = 500;

/** Fields pino puts on every line, which have their own columns. */
const OWN_COLUMNS = new Set(["level", "time", "service", "component", "runId", "jobId", "msg", "pid", "hostname"]);

class LogSink {
  private buffer: PendingLog[] = [];
  private prisma: PrismaClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  private dropped = 0;

  /**
   * Start writing to the database.
   *
   * Called by the core services once they have a Prisma client. Worker agents
   * never call it — they have no database by design — so on a worker the sink
   * stays a bounded in-memory ring that costs a few hundred kilobytes and is
   * never read.
   */
  enable(prisma: PrismaClient): void {
    this.prisma = prisma;
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    // Never hold the process open for the sake of log flushing.
    this.timer.unref();
  }

  /** One serialised pino line. Never throws: a bad line is dropped. */
  write(line: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!OWN_COLUMNS.has(key)) fields[key] = value;
    }

    const time = parsed["time"];
    const entry: PendingLog = {
      level: typeof parsed["level"] === "number" ? (parsed["level"] as number) : 30,
      service: asString(parsed["service"]) ?? "unknown",
      component: asString(parsed["component"]),
      runId: asString(parsed["runId"]),
      jobId: asString(parsed["jobId"]),
      msg: asString(parsed["msg"]) ?? "",
      fields: Object.keys(fields).length > 0 ? fields : null,
      createdAt: typeof time === "string" || typeof time === "number" ? new Date(time) : new Date(),
    };

    if (this.buffer.length >= MAX_BUFFERED) {
      // Oldest first: during an outage the newest lines are what anyone reads.
      this.buffer.shift();
      this.dropped += 1;
    }
    this.buffer.push(entry);
  }

  /**
   * Write what is buffered. Safe to call concurrently; overlapping calls return
   * immediately rather than double-inserting.
   */
  async flush(): Promise<void> {
    if (this.flushing || this.prisma === null || this.buffer.length === 0) return;
    this.flushing = true;
    try {
      const batch = this.buffer.splice(0, MAX_BATCH);
      if (this.dropped > 0) {
        // Recorded in-band so a gap in the page is visible rather than implied.
        batch.unshift({
          level: 40,
          service: "core",
          component: "logSink",
          runId: null,
          jobId: null,
          msg: `log buffer overflowed; ${this.dropped} line(s) dropped`,
          fields: { dropped: this.dropped },
          createdAt: new Date(),
        });
        this.dropped = 0;
      }
      await this.prisma.logEvent.createMany({
        // Prisma distinguishes "SQL NULL" from "JSON null" for a nullable Json
        // column, so an absent `fields` has to say which it means.
        data: batch.map((row) => ({
          ...row,
          fields: row.fields === null ? Prisma.JsonNull : (row.fields as Prisma.InputJsonValue),
        })),
      });
    } catch {
      // Deliberately silent: reporting a logging failure through the logger is
      // how a database outage becomes an infinite loop.
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Delete lines older than `days`.
   *
   * Diagnostic volume, not an audit trail: `audit_events` records decisions and
   * is kept indefinitely, while this table would grow without limit for no
   * lasting benefit.
   */
  async prune(days: number): Promise<number> {
    if (this.prisma === null) return 0;
    const before = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    try {
      const { count } = await this.prisma.logEvent.deleteMany({
        where: { createdAt: { lt: before } },
      });
      return count;
    } catch {
      return 0;
    }
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Process-wide, because pino is configured once at startup and the services
 * each build several child loggers from it.
 */
export const logSink = new LogSink();
