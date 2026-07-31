-- CreateTable
CREATE TABLE "deleted_chapters" (
    "id" TEXT NOT NULL,
    "md_chapter_id" TEXT NOT NULL,
    "extension" TEXT,
    "chapter" JSONB NOT NULL,
    "deleted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deleted_chapters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "deleted_chapters_md_chapter_id_key" ON "deleted_chapters"("md_chapter_id");

-- CreateIndex
CREATE INDEX "deleted_chapters_extension_idx" ON "deleted_chapters"("extension");
