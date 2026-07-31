-- Name/type optimisation, written to be SAFE ON A POPULATED DATABASE.
--
-- `prisma migrate dev` generated drop-and-add for all of this, which would have
-- silently discarded every bundle archive, chapter snapshot and upload-log row.
-- Renames and in-place type conversions carry the data across instead, so this
-- migration is replayable against a database that has already been imported
-- into (see docs/migration-guide.md — the Mongo import may run before or after
-- this migration).

-- Blob and document columns: clearer names, same bytes.
ALTER TABLE "artifacts" RENAME COLUMN "data" TO "content";
ALTER TABLE "bundles" RENAME COLUMN "data" TO "archive";
ALTER TABLE "uploaded_chapters" RENAME COLUMN "data" TO "chapter";
ALTER TABLE "edited_chapters" RENAME COLUMN "data" TO "chapter";
ALTER TABLE "unavailable_chapters" RENAME COLUMN "data" TO "chapter";

-- jsonb array -> text[]: same contents, now typed and indexable.
--
-- Done as add-column / UPDATE / swap rather than ALTER COLUMN … USING, because
-- unnesting a jsonb array needs a subquery and Postgres rejects subqueries in a
-- USING transform ("cannot use subquery in transform expression").
-- The jsonb_typeof guard on each of these three UPDATEs is load-bearing:
-- jsonb_array_elements_text() raises on a non-array, which would abort the whole
-- migration rather than leaving one odd row with an empty array.
ALTER TABLE "api_tokens" ADD COLUMN "scopes_arr" TEXT[] DEFAULT ARRAY[]::TEXT[];
UPDATE "api_tokens"
  SET "scopes_arr" = COALESCE(
    (SELECT array_agg(value) FROM jsonb_array_elements_text("scopes") AS value),
    '{}'::TEXT[]
  )
  WHERE jsonb_typeof("scopes") = 'array';
ALTER TABLE "api_tokens" DROP COLUMN "scopes";
ALTER TABLE "api_tokens" RENAME COLUMN "scopes_arr" TO "scopes";
ALTER TABLE "api_tokens" ALTER COLUMN "scopes" SET NOT NULL;
ALTER TABLE "api_tokens" ALTER COLUMN "scopes" DROP DEFAULT;

ALTER TABLE "jobs" ADD COLUMN "segment_manga_ids_arr" TEXT[] DEFAULT ARRAY[]::TEXT[];
UPDATE "jobs"
  SET "segment_manga_ids_arr" = COALESCE(
    (SELECT array_agg(value) FROM jsonb_array_elements_text("segment_manga_ids") AS value),
    '{}'::TEXT[]
  )
  WHERE jsonb_typeof("segment_manga_ids") = 'array';
ALTER TABLE "jobs" DROP COLUMN "segment_manga_ids";
ALTER TABLE "jobs" RENAME COLUMN "segment_manga_ids_arr" TO "segment_manga_ids";
ALTER TABLE "jobs" ALTER COLUMN "segment_manga_ids" SET NOT NULL;

-- workers.capabilities was {"extensions": [...]} — lift the one field that was
-- ever populated into a typed column and drop the envelope.
ALTER TABLE "workers" ADD COLUMN "extensions" TEXT[] DEFAULT ARRAY[]::TEXT[];
UPDATE "workers"
  SET "extensions" = COALESCE(
    (SELECT array_agg(value)
       FROM jsonb_array_elements_text("capabilities" -> 'extensions') AS value),
    '{}'::TEXT[]
  )
  WHERE jsonb_typeof("capabilities" -> 'extensions') = 'array';
ALTER TABLE "workers" ALTER COLUMN "extensions" SET NOT NULL;
ALTER TABLE "workers" DROP COLUMN "capabilities";

-- upload_log -> upload_logs, and its free-text outcome becomes an enum. The old
-- values were lowercase, so upper() is the conversion.
CREATE TYPE "UploadOutcome" AS ENUM ('COMMITTING', 'COMMITTED', 'FAILED');

ALTER TABLE "upload_log" RENAME TO "upload_logs";
ALTER TABLE "upload_logs" RENAME CONSTRAINT "upload_log_pkey" TO "upload_logs_pkey";
ALTER INDEX "upload_log_dedupe_key_idx" RENAME TO "upload_logs_dedupe_key_idx";

-- Any row whose outcome predates the enum and does not map is not worth failing
-- the migration over: it is advisory telemetry, so unknown values become FAILED
-- (the conservative reading — "this upload did not demonstrably succeed").
UPDATE "upload_logs"
  SET "outcome" = 'FAILED'
  WHERE upper("outcome") NOT IN ('COMMITTING', 'COMMITTED', 'FAILED');

ALTER TABLE "upload_logs"
  ALTER COLUMN "outcome" TYPE "UploadOutcome"
  USING upper("outcome")::"UploadOutcome";
