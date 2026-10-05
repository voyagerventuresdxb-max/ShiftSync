-- Additive: AI spend guard (deployment-wide monthly spend + daily calls) and a per-venue usage ledger.
-- Counts and amounts only; no content is ever stored.

-- CreateTable
CREATE TABLE "ai_spend_months" (
    "month" TEXT NOT NULL,
    "spent_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "reserved_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "warned_80" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_spend_months_pkey" PRIMARY KEY ("month")
);

-- CreateTable
CREATE TABLE "ai_call_days" (
    "day" TEXT NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ai_call_days_pkey" PRIMARY KEY ("day")
);

-- CreateTable
CREATE TABLE "ai_usage" (
    "id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "estimated_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_usage_location_id_feature_month_key" ON "ai_usage"("location_id", "feature", "month");

-- AddForeignKey
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
