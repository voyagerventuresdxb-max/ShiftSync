-- Additive: separate daily call counters for roster vision and voice, next to the existing total.
-- AlterTable
ALTER TABLE "ai_call_days" ADD COLUMN     "vision_calls" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "voice_calls" INTEGER NOT NULL DEFAULT 0;
