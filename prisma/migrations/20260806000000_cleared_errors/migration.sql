-- Acknowledgements for the merged error feed.
--
-- The feed at `/api/v1/admin/errors` merges dead-lettered jobs, failed upload
-- tasks and quarantined submissions. It was read-only, so a failure that had
-- been read and fixed stayed at the top of the triage list forever and the list
-- stopped being a to-do. One row here means "an operator dealt with this".
--
-- Deliberately a side table rather than columns on the three sources: those
-- rows carry `updated_at` maintained by Prisma's @updatedAt, and writing the
-- acknowledgement onto the row would move the timestamp the acknowledgement is
-- compared against.

-- CreateEnum
CREATE TYPE "ErrorSource" AS ENUM ('JOB', 'UPLOAD_TASK', 'SUBMISSION');

-- CreateTable
CREATE TABLE "cleared_errors" (
    "id" TEXT NOT NULL,
    "source" "ErrorSource" NOT NULL,
    "subject_id" TEXT NOT NULL,
    -- The feed timestamp at the moment of clearing. A later failure on the same
    -- row moves that row's own timestamp past this one and the entry returns to
    -- the feed, so clearing acknowledges one failure rather than muting a row.
    "error_at" TIMESTAMP(3) NOT NULL,
    "cleared_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cleared_by" TEXT NOT NULL,
    "note" TEXT,

    CONSTRAINT "cleared_errors_pkey" PRIMARY KEY ("id")
);

-- One acknowledgement per subject: this is both the lookup the feed filter uses
-- and what makes clearing the same entry twice an update instead of a duplicate.
-- No foreign keys — `subject_id` names a row in one of three tables, and a
-- stranded acknowledgement matches nothing and is swept by the pruning query.
CREATE UNIQUE INDEX "cleared_errors_source_subject_id_key" ON "cleared_errors"("source", "subject_id");

-- "What has been cleared lately", newest first, for the dashboard's cleared view.
CREATE INDEX "cleared_errors_cleared_at_idx" ON "cleared_errors"("cleared_at");
