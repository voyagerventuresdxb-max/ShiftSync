-- Additive: one kiosk link per venue. Only the sha256 of its token is stored; NULL = no kiosk link.
-- AlterTable
ALTER TABLE "locations" ADD COLUMN     "kiosk_token_created_at" TIMESTAMP(3),
ADD COLUMN     "kiosk_token_hash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "locations_kiosk_token_hash_key" ON "locations"("kiosk_token_hash");
