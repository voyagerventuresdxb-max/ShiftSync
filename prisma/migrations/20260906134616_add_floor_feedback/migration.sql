-- CreateEnum
CREATE TYPE "FloorFeedbackStatus" AS ENUM ('OPEN', 'FLAGGED', 'REVIEWED');

-- CreateTable
CREATE TABLE "floor_feedback" (
    "id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" "FloorFeedbackStatus" NOT NULL DEFAULT 'OPEN',
    "reviewed_by_id" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "floor_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "floor_feedback_location_id_status_idx" ON "floor_feedback"("location_id", "status");

-- AddForeignKey
ALTER TABLE "floor_feedback" ADD CONSTRAINT "floor_feedback_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "floor_feedback" ADD CONSTRAINT "floor_feedback_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "floor_feedback" ADD CONSTRAINT "floor_feedback_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
