-- CreateEnum
CREATE TYPE "LeaveType" AS ENUM ('DAY_OFF', 'ANNUAL_LEAVE', 'SICK_LEAVE', 'UNPAID_LEAVE', 'HALF_DAY');

-- CreateEnum
CREATE TYPE "RotaLeaveStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateTable
CREATE TABLE "rota_leaves" (
    "id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_by_id" TEXT,
    "date" DATE NOT NULL,
    "type" "LeaveType" NOT NULL,
    "status" "RotaLeaveStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rota_leaves_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rota_leaves_location_id_date_idx" ON "rota_leaves"("location_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "rota_leaves_user_id_date_key" ON "rota_leaves"("user_id", "date");

-- AddForeignKey
ALTER TABLE "rota_leaves" ADD CONSTRAINT "rota_leaves_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rota_leaves" ADD CONSTRAINT "rota_leaves_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rota_leaves" ADD CONSTRAINT "rota_leaves_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
