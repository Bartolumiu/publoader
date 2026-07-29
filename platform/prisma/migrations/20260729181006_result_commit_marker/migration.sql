-- Exactly-once commit marker: at most one COMMITTED result submission per job.
-- Duplicate, late, or malicious re-submissions lose this index race and are
-- recorded as SUPERSEDED instead of ingesting twice.
CREATE UNIQUE INDEX "result_committed_one_per_job"
  ON "result_submissions" ("job_id")
  WHERE state = 'COMMITTED';
