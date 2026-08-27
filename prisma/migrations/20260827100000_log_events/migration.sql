-- Structured log lines, so the dashboard can show what happened without shell
-- access to the host. Diagnostic volume, pruned on a retention window; audit
-- decisions live in audit_events and are kept indefinitely.
CREATE TABLE "log_events" (
    "id" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "service" TEXT NOT NULL,
    "component" TEXT,
    "run_id" TEXT,
    "job_id" TEXT,
    "msg" TEXT NOT NULL,
    "fields" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "log_events_pkey" PRIMARY KEY ("id")
);

-- Newest-first paging is the default read, and pruning deletes by age.
CREATE INDEX "log_events_created_at_idx" ON "log_events"("created_at");
-- "at least warn, newest first" as a range scan rather than set membership.
CREATE INDEX "log_events_level_created_at_idx" ON "log_events"("level", "created_at");
CREATE INDEX "log_events_service_created_at_idx" ON "log_events"("service", "created_at");
-- "everything from this run" is the question an operator actually asks.
CREATE INDEX "log_events_run_id_idx" ON "log_events"("run_id");
CREATE INDEX "log_events_job_id_idx" ON "log_events"("job_id");
