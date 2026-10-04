-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'LOGIN_LINK_ISSUED';
ALTER TYPE "AuditAction" ADD VALUE 'LOGIN_LINK_REDEEMED';
ALTER TYPE "AuditAction" ADD VALUE 'LOGIN_LINK_REVOKED';
ALTER TYPE "AuditAction" ADD VALUE 'LOGIN_LINK_REJECTED';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "is_platform_admin" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "login_links" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "issued_by_id" TEXT,
    "location_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "redeemed_ip" TEXT,
    "redeemed_user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "login_links_token_hash_key" ON "login_links"("token_hash");

-- CreateIndex
CREATE INDEX "login_links_user_id_consumed_at_idx" ON "login_links"("user_id", "consumed_at");

-- CreateIndex
CREATE INDEX "login_links_issued_by_id_idx" ON "login_links"("issued_by_id");

-- AddForeignKey
ALTER TABLE "login_links" ADD CONSTRAINT "login_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_links" ADD CONSTRAINT "login_links_issued_by_id_fkey" FOREIGN KEY ("issued_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
