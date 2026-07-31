import { pino, type Logger } from "pino";

/**
 * Structured JSON logs. Every log line in job-processing paths should carry
 * the correlation fields via child loggers: runId, jobId, attempt, workerId.
 */
export function createLogger(service: string, level = "info"): Logger {
  return pino({
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type { Logger };
