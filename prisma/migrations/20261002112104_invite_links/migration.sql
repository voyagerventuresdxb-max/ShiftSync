-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'INVITE_LINK_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'INVITE_LINK_REVOKED';

-- AlterTable
ALTER TABLE "locations" ADD COLUMN     "legacy_join_links_until" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "invite_links" (
    "id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "max_uses" INTEGER,
    "use_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "invite_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invite_links_token_key" ON "invite_links"("token");

-- CreateIndex
CREATE INDEX "invite_links_location_id_idx" ON "invite_links"("location_id");

-- AddForeignKey
ALTER TABLE "invite_links" ADD CONSTRAINT "invite_links_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite_links" ADD CONSTRAINT "invite_links_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: every venue that exists when this migration runs keeps accepting
-- its old `/join?location=<id>` links for 7 days from that moment (so the
-- window starts when `prisma migrate deploy` applies this in each
-- environment). Venues created later stay NULL and never accept them.
-- Columns are UTC `timestamp without time zone`, hence AT TIME ZONE 'UTC'.
UPDATE "locations" SET "legacy_join_links_until" = (NOW() AT TIME ZONE 'UTC') + INTERVAL '7 days';
