-- Email sign-in links ("magic links").
--
-- An invited account has no password and no Discord linkage, so until it sets
-- one it has no way in at all. A single-use emailed link is that way in, which
-- makes this table a credential store's neighbour: it holds only sha256 of the
-- secret half, exactly like `admin_sessions`.

-- CreateEnum
CREATE TYPE "LoginTokenPurpose" AS ENUM ('LOGIN', 'INVITE', 'WELCOME');

-- CreateTable
CREATE TABLE "login_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "purpose" "LoginTokenPurpose" NOT NULL,
    "email" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "requested_ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_tokens_pkey" PRIMARY KEY ("id")
);

-- The hash is the lookup key on redemption, and uniqueness is what makes a
-- token single-use even under two concurrent clicks.
CREATE UNIQUE INDEX "login_tokens_token_hash_key" ON "login_tokens"("token_hash");

-- Retiring a user's other outstanding links on use, and the expiry sweep.
CREATE INDEX "login_tokens_user_id_idx" ON "login_tokens"("user_id");
CREATE INDEX "login_tokens_expires_at_idx" ON "login_tokens"("expires_at");

-- Deleting an account must take its pending links with it: otherwise a link
-- mailed minutes before a revocation would outlive the revocation.
ALTER TABLE "login_tokens" ADD CONSTRAINT "login_tokens_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
