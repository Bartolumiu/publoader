/*
  Warnings:

  - The `scopes` column on the `api_tokens` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the column `data` on the `artifacts` table. All the data in the column will be lost.
  - You are about to drop the column `data` on the `bundles` table. All the data in the column will be lost.
  - You are about to drop the column `data` on the `edited_chapters` table. All the data in the column will be lost.
  - The `segment_manga_ids` column on the `jobs` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the column `data` on the `unavailable_chapters` table. All the data in the column will be lost.
  - You are about to drop the column `data` on the `uploaded_chapters` table. All the data in the column will be lost.
  - You are about to drop the column `capabilities` on the `workers` table. All the data in the column will be lost.
  - You are about to drop the `upload_log` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `content` to the `artifacts` table without a default value. This is not possible if the table is not empty.
  - Added the required column `archive` to the `bundles` table without a default value. This is not possible if the table is not empty.
  - Added the required column `chapter` to the `edited_chapters` table without a default value. This is not possible if the table is not empty.
  - Added the required column `chapter` to the `unavailable_chapters` table without a default value. This is not possible if the table is not empty.
  - Added the required column `chapter` to the `uploaded_chapters` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "UploadOutcome" AS ENUM ('COMMITTING', 'COMMITTED', 'FAILED');

-- AlterTable
ALTER TABLE "api_tokens" DROP COLUMN "scopes",
ADD COLUMN     "scopes" TEXT[];

-- AlterTable
ALTER TABLE "artifacts" DROP COLUMN "data",
ADD COLUMN     "content" BYTEA NOT NULL;

-- AlterTable
ALTER TABLE "bundles" DROP COLUMN "data",
ADD COLUMN     "archive" BYTEA NOT NULL;

-- AlterTable
ALTER TABLE "edited_chapters" DROP COLUMN "data",
ADD COLUMN     "chapter" JSONB NOT NULL;

-- AlterTable
ALTER TABLE "jobs" DROP COLUMN "segment_manga_ids",
ADD COLUMN     "segment_manga_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "unavailable_chapters" DROP COLUMN "data",
ADD COLUMN     "chapter" JSONB NOT NULL;

-- AlterTable
ALTER TABLE "uploaded_chapters" DROP COLUMN "data",
ADD COLUMN     "chapter" JSONB NOT NULL;

-- AlterTable
ALTER TABLE "workers" DROP COLUMN "capabilities",
ADD COLUMN     "extensions" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- DropTable
DROP TABLE "upload_log";

-- CreateTable
CREATE TABLE "upload_logs" (
    "id" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "md_chapter_id" TEXT,
    "outcome" "UploadOutcome" NOT NULL,
    "detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "upload_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "upload_logs_dedupe_key_idx" ON "upload_logs"("dedupe_key");
