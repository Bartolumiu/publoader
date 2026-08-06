-- Fine-grained permission tuning, at two levels.
--
-- `role_permissions` overrides a role's scope baseline for this deployment. It
-- is an override list, not the source of truth: no row means "use the shipped
-- default", so a deployment that never touches it keeps tracking the defaults
-- as releases change them. OWNER is never stored here — it is the wildcard by
-- construction, and the way back in when these tables are the problem.
--
-- The two columns on `admin_users` tune one account on top of its role: scopes
-- granted beyond the role, and scopes refused despite it. Empty arrays (the
-- default) mean the account is exactly its role, which is what every existing
-- row is.

-- CreateTable
CREATE TABLE "role_permissions" (
    "role" "AdminRole" NOT NULL,
    "scopes" TEXT[],
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role")
);

-- AlterTable
ALTER TABLE "admin_users" ADD COLUMN     "denied_scopes" TEXT[],
ADD COLUMN     "extra_scopes" TEXT[];
