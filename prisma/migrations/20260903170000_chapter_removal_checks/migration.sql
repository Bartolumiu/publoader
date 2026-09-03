-- Absence has to be voted on, not taken on sight.
--
-- Three of the four removal passes read their evidence off what an extension
-- listed: a chapter missing from a series listing, a manga no longer tracked, a
-- tracked manga with no chapters. All three are indistinguishable from the
-- extension having been broken at the moment we asked -- a partial page, an
-- expired token, a geo-block, an upstream answering 200 with an empty body --
-- and the platform acted on the first report either way.
--
-- This table holds the tally. One row per chapter, dropped as soon as the
-- publisher lists it again.
CREATE TABLE "chapter_removal_checks" (
    "id" TEXT NOT NULL,
    "md_chapter_id" TEXT NOT NULL,
    "extension" TEXT NOT NULL,
    "md_manga_id" TEXT,
    "pass" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "misses" INTEGER NOT NULL DEFAULT 1,
    "first_missed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_missed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- The earliest a further vote counts. Without it a retry, a scoped recheck
    -- and another segment of the same run are three votes from one broken hour.
    "not_before" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chapter_removal_checks_pkey" PRIMARY KEY ("id")
);

-- One tally per chapter, whichever rule reported it, which is what makes the
-- vote an upsert rather than a read-then-write.
CREATE UNIQUE INDEX "chapter_removal_checks_md_chapter_id_key"
    ON "chapter_removal_checks"("md_chapter_id");

-- An operator clearing one publisher's tally after an outage, and the dashboard
-- listing what is currently pending confirmation.
CREATE INDEX "chapter_removal_checks_extension_last_missed_at_idx"
    ON "chapter_removal_checks"("extension", "last_missed_at");
