-- The chapter as the publisher first described it. Written once, never updated.
--
-- A chapter rebuilt from a MangaDex record takes its url from `externalUrl`,
-- and on a carded chapter that is the REPLACEMENT link. Archiving one that way
-- loses the publisher's real link with nothing left holding it. This row is
-- written at first sight and never touched again.
CREATE TABLE "chapter_origins" (
    "md_chapter_id" TEXT NOT NULL,
    "extension" TEXT NOT NULL,
    "chapter_id" TEXT,
    "chapter_url" TEXT,
    "manga_id" TEXT,
    "md_manga_id" TEXT,
    "manga_name" TEXT,
    "chapter_number" TEXT,
    "chapter_volume" TEXT,
    "chapter_title" TEXT,
    "chapter_language" TEXT,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chapter_origins_pkey" PRIMARY KEY ("md_chapter_id")
);

CREATE INDEX "chapter_origins_extension_chapter_id_idx" ON "chapter_origins"("extension", "chapter_id");
CREATE INDEX "chapter_origins_md_manga_id_idx" ON "chapter_origins"("md_manga_id");

-- Backfill from what the live archives still hold. Both are written from the
-- extension's own payload, so their urls are the genuine source links today --
-- capture them before any further transition degrades them. `uploaded` wins
-- over `unavailable` on conflict only because it is the earlier state; the two
-- are disjoint in practice.
INSERT INTO "chapter_origins" (
    "md_chapter_id", "extension", "chapter_id", "chapter_url", "manga_id",
    "md_manga_id", "manga_name", "chapter_number", "chapter_volume",
    "chapter_title", "chapter_language", "first_seen_at"
)
SELECT
    md_chapter_id, COALESCE(extension, 'unknown'), chapter_id, chapter_url,
    manga_id, md_manga_id, manga_name, chapter_number, chapter_volume,
    chapter_title, chapter_language, CURRENT_TIMESTAMP
FROM "uploaded_chapters"
WHERE md_chapter_id IS NOT NULL
ON CONFLICT ("md_chapter_id") DO NOTHING;

INSERT INTO "chapter_origins" (
    "md_chapter_id", "extension", "chapter_id", "chapter_url", "manga_id",
    "md_manga_id", "manga_name", "chapter_number", "chapter_volume",
    "chapter_title", "chapter_language", "first_seen_at"
)
SELECT
    md_chapter_id, COALESCE(extension, 'unknown'), chapter_id, chapter_url,
    manga_id, md_manga_id, manga_name, chapter_number, chapter_volume,
    chapter_title, chapter_language, CURRENT_TIMESTAMP
FROM "unavailable_chapters"
WHERE md_chapter_id IS NOT NULL
ON CONFLICT ("md_chapter_id") DO NOTHING;
