import { pino, multistream, type Logger } from "pino";
import { Writable } from "node:stream";
import { logSink } from "./core/observability/logSink.js";

/**
 * Structured JSON logs. Every log line in job-processing paths should carry
 * the correlation fields via child loggers: runId, jobId, attempt, workerId.
 *
 * Lines go to stdout as they always have, and also to `logSink`, which the core
 * services persist so the dashboard can show them. stdout is kept because it is
 * what `docker compose logs` reads and what a crash loop leaves behind — the
 * database copy is the convenient one, not the authoritative one.
 */
export function createLogger(service: string, level = "info"): Logger {
  const toSink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      // Never let persistence fail a log call; the sink swallows its own
      // errors, and this guards the parse/serialise path around it.
      try {
        logSink.write(chunk.toString("utf8"));
      } catch {
        /* ignore */
      }
      callback();
    },
  });

  return pino(
    {
      level,
      base: { service },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    multistream([{ stream: process.stdout }, { stream: toSink }]),
  );
}

export type { Logger };
