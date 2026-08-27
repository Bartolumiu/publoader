-- Remembered comment counts, so the duplicate scan does not ask MangaDex about
-- every candidate on every run.
--
-- Only `comments > 0` is treated as durable: it means a person has written on
-- the chapter, which no later reading can undo. A zero is re-checked, because
-- somebody can comment at any time and caching that as final is how a chapter
-- that has since been discussed would be deleted anyway.
CREATE TABLE "chapter_comment_counts" (
    "md_chapter_id" TEXT NOT NULL,
    "comments" INTEGER NOT NULL,
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chapter_comment_counts_pkey" PRIMARY KEY ("md_chapter_id")
);

-- The scan's question is "which of these already have comments".
CREATE INDEX "chapter_comment_counts_comments_idx" ON "chapter_comment_counts"("comments");
