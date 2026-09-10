-- CreateEnum
CREATE TYPE "VoiceInteractionOutcome" AS ENUM ('PENDING_CONFIRMATION', 'LOW_CONFIDENCE', 'UNRECOGNIZED', 'EXECUTED', 'REJECTED_VALIDATION', 'REJECTED_PERMISSION', 'ERROR');

-- CreateTable
CREATE TABLE "voice_interaction_logs" (
    "id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "transcript" TEXT NOT NULL,
    "resolved_intent" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "outcome" "VoiceInteractionOutcome" NOT NULL,
    "decline_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voice_interaction_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "voice_interaction_logs_location_id_created_at_idx" ON "voice_interaction_logs"("location_id", "created_at");

-- AddForeignKey
ALTER TABLE "voice_interaction_logs" ADD CONSTRAINT "voice_interaction_logs_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_interaction_logs" ADD CONSTRAINT "voice_interaction_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
