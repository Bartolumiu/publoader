-- Announce a run's "Found N chapters" summary once.
--
-- Processing is not resumable: an interrupted run stays in INGESTING and the
-- next tick starts it again from the top, re-sending whatever it had already
-- sent. A container restart mid-run is ordinary -- watchtower does one on every
-- deploy -- and a single clean run announced itself four times in an evening.
ALTER TABLE "runs" ADD COLUMN "summary_notified_at" TIMESTAMP(3);
