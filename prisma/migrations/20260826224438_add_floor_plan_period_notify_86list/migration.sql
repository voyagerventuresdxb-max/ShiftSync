-- CreateEnum
CREATE TYPE "AssignmentPeriod" AS ENUM ('AM', 'PM');

-- CreateEnum
CREATE TYPE "EightySixStatus" AS ENUM ('EIGHTY_SIXED', 'BACK_ON');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'ASSIGNMENT_NOTIFIED';
ALTER TYPE "AuditAction" ADD VALUE 'ITEM_86D';
ALTER TYPE "AuditAction" ADD VALUE 'ITEM_BACK_ON';

-- DropIndex
DROP INDEX "section_assignments_section_id_staff_id_shift_date_key";

-- AlterTable
ALTER TABLE "section_assignments" ADD COLUMN     "notified_at" TIMESTAMP(3),
ADD COLUMN     "period" "AssignmentPeriod" NOT NULL DEFAULT 'AM';

-- CreateTable
CREATE TABLE "eighty_six_items" (
    "id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "item_name" TEXT NOT NULL,
    "station" TEXT NOT NULL,
    "status" "EightySixStatus" NOT NULL DEFAULT 'EIGHTY_SIXED',
    "note" TEXT,
    "created_by_id" TEXT,
    "back_on_by_id" TEXT,
    "eighty_sixed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "back_on_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "eighty_six_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "eighty_six_items_location_id_status_idx" ON "eighty_six_items"("location_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "section_assignments_section_id_staff_id_shift_date_period_key" ON "section_assignments"("section_id", "staff_id", "shift_date", "period");

-- AddForeignKey
ALTER TABLE "eighty_six_items" ADD CONSTRAINT "eighty_six_items_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eighty_six_items" ADD CONSTRAINT "eighty_six_items_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eighty_six_items" ADD CONSTRAINT "eighty_six_items_back_on_by_id_fkey" FOREIGN KEY ("back_on_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

