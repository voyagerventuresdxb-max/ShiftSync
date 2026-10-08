-- CreateTable
CREATE TABLE "voice_confirmations" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voice_confirmations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "voice_confirmations_key_idx" ON "voice_confirmations"("key");

-- CreateIndex
CREATE INDEX "voice_confirmations_expires_at_idx" ON "voice_confirmations"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "voice_confirmations_location_id_user_id_key_key" ON "voice_confirmations"("location_id", "user_id", "key");
