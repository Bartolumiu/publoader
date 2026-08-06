-- Multiple schedule slots per extension.
--
-- `schedule_overrides` was keyed by extension, so an extension had exactly one
-- override: one time, and at most one weekday. That made the two schedules an
-- operator actually wants, a daily update AND a weekly CLEAN, mutually
-- exclusive. `schedule_entries` is keyed by row instead, carries a weekday SET
-- rather than a single optional day, and carries the run kind, so "Wednesday
-- 01:00, clean" and "every day 15:00, update" are two rows that do not compete.

-- CreateTable
CREATE TABLE "schedule_entries" (
    "id" TEXT NOT NULL,
    "extension" TEXT NOT NULL,
    "hour" INTEGER NOT NULL,
    "minute" INTEGER NOT NULL,
    -- Monday=0 .. Sunday=6 (Python weekday()). Empty array = every day, which
    -- is the default an operator gets by not answering the question.
    "days" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "kind" "RunKind" NOT NULL DEFAULT 'UPDATE',
    "label" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedule_entries_pkey" PRIMARY KEY ("id")
);

-- Every read is "the schedule for this extension".
CREATE INDEX "schedule_entries_extension_idx" ON "schedule_entries"("extension");

-- Carry the existing overrides across. Each old row becomes exactly one entry:
-- same time, same kind the scheduler always used (UPDATE), and its single
-- optional `day` becomes a one-element weekday set. gen_random_uuid() is in
-- core Postgres from 13 onward, which the init migration already assumes.
INSERT INTO "schedule_entries" ("id", "extension", "hour", "minute", "days", "kind", "enabled", "created_at", "updated_at")
SELECT
    gen_random_uuid()::text,
    "extension",
    "hour",
    "minute",
    CASE WHEN "day" IS NULL THEN ARRAY[]::INTEGER[] ELSE ARRAY["day"] END,
    'UPDATE'::"RunKind",
    true,
    CURRENT_TIMESTAMP,
    "updated_at"
FROM "schedule_overrides";

-- DropTable
DROP TABLE "schedule_overrides";
