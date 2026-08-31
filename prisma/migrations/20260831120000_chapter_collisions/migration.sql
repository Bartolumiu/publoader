-- A chapter we uploaded whose number and language were already taken, in our
-- own group, by a chapter already on MangaDex.
--
-- Recorded, never enforced: the number is not a chapter's identity, so a match
-- is a thing for a person to look at, not a reason to drop an upload. It exists
-- because the identity check is the url, and an extension whose chapter id does
-- not appear in the MangaDex externalUrl fails that check silently and forever.
CREATE TABLE "chapter_collisions" (
    "id" TEXT NOT NULL,
    "extension" TEXT NOT NULL,
    "chapter_id" TEXT,
    "chapter_url" TEXT,
    "md_manga_id" TEXT NOT NULL,
    "manga_name" TEXT,
    "chapter_number" TEXT,
    "chapter_language" TEXT NOT NULL,
    "existing" JSONB NOT NULL DEFAULT '[]',
    "md_chapter_id" TEXT,
    "run_id" TEXT,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged_at" TIMESTAMP(3),
    "acknowledged_by" TEXT,

    CONSTRAINT "chapter_collisions_pkey" PRIMARY KEY ("id")
);

-- The dashboard's list: what has not been looked at yet, newest first.
CREATE INDEX "chapter_collisions_acknowledged_at_detected_at_idx"
    ON "chapter_collisions"("acknowledged_at", "detected_at");

CREATE INDEX "chapter_collisions_extension_detected_at_idx"
    ON "chapter_collisions"("extension", "detected_at");

-- One row per chapter, so a re-run updates rather than appends. NULLS NOT
-- DISTINCT because chapter_id and chapter_number are both nullable and two
-- nulls here mean the same chapter, not two different ones.
CREATE UNIQUE INDEX "chapter_collisions_identity"
    ON "chapter_collisions"("extension", "chapter_id", "chapter_number", "chapter_language")
    NULLS NOT DISTINCT;
