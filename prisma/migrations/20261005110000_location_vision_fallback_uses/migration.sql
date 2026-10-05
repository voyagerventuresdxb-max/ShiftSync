-- Additive: the venue's recent AI roster reads, for AI_VISION_WEEKLY_LIMIT (rolling 7 days).
-- AlterTable
ALTER TABLE "locations" ADD COLUMN     "vision_fallback_uses" TIMESTAMP(3)[] DEFAULT ARRAY[]::TIMESTAMP(3)[];

-- Carry over each venue's last read so the current week's allowance is unchanged by this deploy.
UPDATE "locations" SET "vision_fallback_uses" = ARRAY["last_vision_fallback_used_at"] WHERE "last_vision_fallback_used_at" IS NOT NULL;
