import { Prisma, type PrismaClient } from "@prisma/client";

/**
 * "What is this run doing right now?"
 *
 * INGESTING is the phase with no answer. A run in it is walking its titles one
 * at a time, a MangaDex request or two each, and the processor logs nothing for
 * a title that decided nothing — which is most of them on a clean sweep. So a
 * run over a thousand series is minutes of silence, and that silence looks
 * exactly the same whether the processor is working steadily or is wedged on
 * one request that will never return. The only recourse was `docker compose
 * logs` on the host.
 *
 * The processor now emits a heartbeat under this component. Keeping the lines
 * in `log_events` rather than in a column on `runs` is deliberate:
 *
 *   - they are already durable, already indexed by `runId`, and already
 *     readable at `GET /admin/logs?component=run-progress`, so the log page
 *     gets the history for free and no migration is needed;
 *   - progress is diagnostic, not state. A run's state is what it will be
 *     judged on; where it had got to at 14:32 is worth keeping and worth
 *     losing, which is exactly what the log store's retention already decides.
 *
 * What the API adds on top is only the last line, because that is the whole
 * question: everything before it is history the log page already serves.
 */

/** The `component` every progress line carries. One home so it cannot drift. */
export const RUN_PROGRESS_COMPONENT = "run-progress";

export interface RunProgress {
  /** The processor's own message: "still processing run", "run processed", … */
  msg: string;
  at: string;
  /** Whatever the line carried: done, total, elapsedMs, mangaId, counts. */
  fields: Record<string, unknown>;
}

interface ProgressRow {
  runId: string;
  msg: string;
  fields: Prisma.JsonValue;
  createdAt: Date;
}

/**
 * The newest progress line for each of these runs.
 *
 * One query for the whole page rather than one per run: the runs list shows 25
 * at a time and 25 round trips to render a column is how a list view becomes
 * the slowest page in the console. `DISTINCT ON` is the Postgres way to say
 * "latest per group" and reads straight off the `(run_id)` index.
 *
 * Runs with no progress line are simply absent from the map; every caller has
 * to handle that anyway, because a run that has not reached INGESTING has
 * genuinely not reported anything yet.
 */
export async function latestRunProgress(
  prisma: PrismaClient,
  runIds: readonly string[],
): Promise<Map<string, RunProgress>> {
  const ids = [...new Set(runIds)].filter(Boolean);
  if (ids.length === 0) return new Map();

  const rows = await prisma.$queryRaw<ProgressRow[]>(Prisma.sql`
    SELECT DISTINCT ON (run_id)
           run_id AS "runId", msg, fields, created_at AS "createdAt"
    FROM log_events
    WHERE run_id = ANY(${ids}::text[]) AND component = ${RUN_PROGRESS_COMPONENT}
    ORDER BY run_id, created_at DESC, id DESC
  `);

  return new Map(
    rows.map((row) => [
      row.runId,
      {
        msg: row.msg,
        at: row.createdAt.toISOString(),
        fields:
          row.fields && typeof row.fields === "object" && !Array.isArray(row.fields)
            ? (row.fields as Record<string, unknown>)
            : {},
      },
    ]),
  );
}

/** The same for one run, so a detail route does not have to build an array. */
export async function runProgressFor(
  prisma: PrismaClient,
  runId: string,
): Promise<RunProgress | null> {
  return (await latestRunProgress(prisma, [runId])).get(runId) ?? null;
}
