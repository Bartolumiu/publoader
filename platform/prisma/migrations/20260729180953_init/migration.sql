-- CreateEnum
CREATE TYPE "WorkerStatus" AS ENUM ('ACTIVE', 'DRAINED', 'REVOKED');

-- CreateEnum
CREATE TYPE "TrustTier" AS ENUM ('TRUSTED', 'COMMUNITY');

-- CreateEnum
CREATE TYPE "RunKind" AS ENUM ('UPDATE', 'CLEAN', 'FORCE');

-- CreateEnum
CREATE TYPE "RunState" AS ENUM ('PENDING', 'EXECUTING', 'INGESTING', 'PROCESSED', 'FAILED', 'DEAD_LETTER', 'CANCELLED');

-- CreateEnum
CREATE TYPE "JobState" AS ENUM ('PENDING', 'LEASED', 'RUNNING', 'SUCCEEDED', 'DEAD_LETTER', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ErrorClass" AS ENUM ('TRANSIENT', 'PERMANENT', 'POLICY');

-- CreateEnum
CREATE TYPE "ResultState" AS ENUM ('RECEIVED', 'QUARANTINED', 'COMMITTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "UploadTaskKind" AS ENUM ('UPLOAD', 'EDIT', 'DELETE', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "UploadTaskState" AS ENUM ('PENDING', 'LEASED', 'DONE', 'FAILED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "UntrackedState" AS ENUM ('NEW', 'CREATING', 'CREATED', 'TRACKED', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "workers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" "WorkerStatus" NOT NULL DEFAULT 'ACTIVE',
    "trust" "TrustTier" NOT NULL DEFAULT 'COMMUNITY',
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "last_heartbeat_at" TIMESTAMP(3),
    "agent_version" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enroll_tokens" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "trust" "TrustTier" NOT NULL DEFAULT 'COMMUNITY',
    "note" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "single_use" BOOLEAN NOT NULL DEFAULT true,
    "used_by_worker_id" TEXT,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enroll_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runs" (
    "id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "extension" TEXT NOT NULL,
    "extension_version" TEXT NOT NULL,
    "bundle_sha256" TEXT NOT NULL,
    "kind" "RunKind" NOT NULL,
    "state" "RunState" NOT NULL DEFAULT 'PENDING',
    "segments_total" INTEGER NOT NULL DEFAULT 1,
    "require_all_segments" BOOLEAN NOT NULL DEFAULT true,
    "triggered_by" TEXT,
    "scheduled_for" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "extension" TEXT NOT NULL,
    "extension_version" TEXT NOT NULL,
    "bundle_sha256" TEXT NOT NULL,
    "kind" "RunKind" NOT NULL,
    "segment_index" INTEGER NOT NULL DEFAULT 0,
    "segment_total" INTEGER NOT NULL DEFAULT 1,
    "segment_key" TEXT,
    "segment_manga_ids" JSONB,
    "min_trust" "TrustTier" NOT NULL DEFAULT 'COMMUNITY',
    "state" "JobState" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "not_before" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "timeout_seconds" INTEGER NOT NULL DEFAULT 3600,
    "lease_id" TEXT,
    "lease_worker_id" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "error_class" "ErrorClass",
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "result_submissions" (
    "id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "lease_id" TEXT NOT NULL,
    "worker_id" TEXT NOT NULL,
    "envelope" JSONB NOT NULL,
    "state" "ResultState" NOT NULL DEFAULT 'RECEIVED',
    "reject_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "result_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artifacts" (
    "id" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "content_type" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "job_id" TEXT,
    "worker_id" TEXT,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bundles" (
    "id" TEXT NOT NULL,
    "extension" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "source_commit" TEXT,
    "data" BYTEA NOT NULL,
    "yanked" BOOLEAN NOT NULL DEFAULT false,
    "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bundles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upload_tasks" (
    "id" TEXT NOT NULL,
    "kind" "UploadTaskKind" NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "chapter" JSONB NOT NULL,
    "state" "UploadTaskState" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "not_before" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_id" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "upload_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "uploaded_chapters" (
    "id" TEXT NOT NULL,
    "md_chapter_id" TEXT NOT NULL,
    "extension" TEXT NOT NULL,
    "chapter_id" TEXT,
    "md_manga_id" TEXT,
    "chapter_language" TEXT,
    "chapter_number" TEXT,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "uploaded_chapters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "uploaded_ids" (
    "id" TEXT NOT NULL,
    "extension" TEXT NOT NULL,
    "chapter_id" TEXT NOT NULL,
    "md_chapter_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uploaded_ids_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edited_chapters" (
    "id" TEXT NOT NULL,
    "md_chapter_id" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "edits" JSONB NOT NULL DEFAULT '[]',
    "last_edited_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "edited_chapters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unavailable_chapters" (
    "id" TEXT NOT NULL,
    "md_chapter_id" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "unavailable_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unavailable_chapters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upload_log" (
    "id" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "md_chapter_id" TEXT,
    "outcome" TEXT NOT NULL,
    "detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "upload_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "untracked_manga" (
    "id" TEXT NOT NULL,
    "extension" TEXT NOT NULL,
    "manga_id" TEXT NOT NULL,
    "manga_name" TEXT NOT NULL,
    "manga_language" TEXT NOT NULL,
    "manga_url" TEXT NOT NULL,
    "state" "UntrackedState" NOT NULL DEFAULT 'NEW',
    "md_manga_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "untracked_manga_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracked_manga" (
    "id" TEXT NOT NULL,
    "extension" TEXT NOT NULL,
    "manga_id" TEXT NOT NULL,
    "md_manga_id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'auto',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tracked_manga_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extension_configs" (
    "extension" TEXT NOT NULL,
    "override_options" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "extension_configs_pkey" PRIMARY KEY ("extension")
);

-- CreateTable
CREATE TABLE "schedule_overrides" (
    "extension" TEXT NOT NULL,
    "hour" INTEGER NOT NULL,
    "minute" INTEGER NOT NULL,
    "day" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedule_overrides_pkey" PRIMARY KEY ("extension")
);

-- CreateTable
CREATE TABLE "disabled_extensions" (
    "extension" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "disabled_extensions_pkey" PRIMARY KEY ("extension")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "subject" TEXT,
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workers_token_hash_key" ON "workers"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "enroll_tokens_token_hash_key" ON "enroll_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "runs_idempotency_key_key" ON "runs"("idempotency_key");

-- CreateIndex
CREATE INDEX "runs_state_idx" ON "runs"("state");

-- CreateIndex
CREATE INDEX "runs_extension_created_at_idx" ON "runs"("extension", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_idempotency_key_key" ON "jobs"("idempotency_key");

-- CreateIndex
CREATE INDEX "jobs_state_not_before_idx" ON "jobs"("state", "not_before");

-- CreateIndex
CREATE INDEX "jobs_run_id_idx" ON "jobs"("run_id");

-- CreateIndex
CREATE INDEX "jobs_lease_expires_at_idx" ON "jobs"("lease_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "result_submissions_idempotency_key_key" ON "result_submissions"("idempotency_key");

-- CreateIndex
CREATE INDEX "result_submissions_job_id_idx" ON "result_submissions"("job_id");

-- CreateIndex
CREATE INDEX "artifacts_job_id_idx" ON "artifacts"("job_id");

-- CreateIndex
CREATE INDEX "artifacts_expires_at_idx" ON "artifacts"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "bundles_sha256_key" ON "bundles"("sha256");

-- CreateIndex
CREATE INDEX "bundles_extension_published_at_idx" ON "bundles"("extension", "published_at");

-- CreateIndex
CREATE UNIQUE INDEX "bundles_extension_version_key" ON "bundles"("extension", "version");

-- CreateIndex
CREATE INDEX "upload_tasks_state_not_before_idx" ON "upload_tasks"("state", "not_before");

-- CreateIndex
CREATE UNIQUE INDEX "upload_tasks_kind_dedupe_key_key" ON "upload_tasks"("kind", "dedupe_key");

-- CreateIndex
CREATE UNIQUE INDEX "uploaded_chapters_md_chapter_id_key" ON "uploaded_chapters"("md_chapter_id");

-- CreateIndex
CREATE INDEX "uploaded_chapters_extension_idx" ON "uploaded_chapters"("extension");

-- CreateIndex
CREATE INDEX "uploaded_chapters_extension_chapter_id_idx" ON "uploaded_chapters"("extension", "chapter_id");

-- CreateIndex
CREATE UNIQUE INDEX "uploaded_ids_extension_chapter_id_key" ON "uploaded_ids"("extension", "chapter_id");

-- CreateIndex
CREATE UNIQUE INDEX "edited_chapters_md_chapter_id_key" ON "edited_chapters"("md_chapter_id");

-- CreateIndex
CREATE UNIQUE INDEX "unavailable_chapters_md_chapter_id_key" ON "unavailable_chapters"("md_chapter_id");

-- CreateIndex
CREATE INDEX "upload_log_dedupe_key_idx" ON "upload_log"("dedupe_key");

-- CreateIndex
CREATE INDEX "untracked_manga_state_idx" ON "untracked_manga"("state");

-- CreateIndex
CREATE UNIQUE INDEX "untracked_manga_extension_manga_id_manga_language_key" ON "untracked_manga"("extension", "manga_id", "manga_language");

-- CreateIndex
CREATE INDEX "tracked_manga_extension_idx" ON "tracked_manga"("extension");

-- CreateIndex
CREATE UNIQUE INDEX "tracked_manga_extension_manga_id_key" ON "tracked_manga"("extension", "manga_id");

-- CreateIndex
CREATE INDEX "audit_events_created_at_idx" ON "audit_events"("created_at");

-- CreateIndex
CREATE INDEX "audit_events_action_idx" ON "audit_events"("action");

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
