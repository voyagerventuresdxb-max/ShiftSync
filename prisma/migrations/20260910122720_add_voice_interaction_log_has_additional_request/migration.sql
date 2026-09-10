/*
  Warnings:

  - You are about to drop the column `last_vision_fallback_used_at` on the `locations` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "locations" DROP COLUMN "last_vision_fallback_used_at";

-- AlterTable
ALTER TABLE "voice_interaction_logs" ADD COLUMN     "has_additional_request" BOOLEAN NOT NULL DEFAULT false;
