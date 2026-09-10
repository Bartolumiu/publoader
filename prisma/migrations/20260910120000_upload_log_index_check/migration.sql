-- Give the not-indexed sweep somewhere durable to keep its place.
--
-- A COMMITTED row is written the instant MangaDex hands back a chapter id, and
-- that is not the same as a chapter readers can open: indexing happens after,
-- and when it does not happen nothing notices. The task is DONE, the row
-- exists, and no retry is owed, because the upload genuinely worked.
--
-- The first version of the sweep held the ids to re-check in memory, which lost
-- them on every deploy -- and a deploy is exactly the moment uploads are in
-- flight. This column moves that state into the row that already exists, so the
-- sweep costs no extra write on the upload path and survives a restart.
ALTER TABLE "upload_logs" ADD COLUMN "index_checked_at" TIMESTAMP(3);

-- Everything already committed is treated as settled.
--
-- Without this the first sweep after deploy would walk the entire upload
-- history -- every chapter this platform has ever put up -- asking MangaDex
-- about each one, to report chapters that have been live for months. The
-- backfill is a claim about the check, not about the chapter: these rows
-- predate it and will not be asked about.
UPDATE "upload_logs" SET "index_checked_at" = now() WHERE "outcome" = 'COMMITTED';

-- Partial, because the sweep's working set is tiny and always shrinking: only
-- commits nobody has asked about yet. A stamped row leaves the index rather
-- than sitting in it forever, so this stays the size of whatever is currently
-- in flight no matter how large upload_logs grows.
CREATE INDEX "upload_logs_index_check_idx"
  ON "upload_logs" ("created_at")
  WHERE "outcome" = 'COMMITTED' AND "index_checked_at" IS NULL AND "md_chapter_id" IS NOT NULL;
