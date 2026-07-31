-- When a job was most recently claimed.
--
-- Needed for the claim's fairness rule, which has to know who claimed LAST and
-- how long ago. `lease_expires_at` almost answers that — it is the claim time
-- plus the TTL — but only while the TTL never changes, and a deployment that
-- raised LEASE_TTL_SECONDS would silently reorder history. An explicit column
-- cannot drift.
--
-- Nullable with no default and no backfill: NULL means "never claimed", which is
-- the correct reading for every row that predates this column.
ALTER TABLE "jobs" ADD COLUMN "leased_at" TIMESTAMP(3);

-- The fairness rule reads the single most recent claim on every poll, so it must
-- not be a sequential scan over the job table.
CREATE INDEX "jobs_leased_at_idx" ON "jobs" ("leased_at" DESC) WHERE "leased_at" IS NOT NULL;
