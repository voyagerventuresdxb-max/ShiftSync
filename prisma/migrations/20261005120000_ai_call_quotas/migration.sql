-- Additive: per-venue and per-person daily AI call counters.
-- CreateTable
CREATE TABLE "ai_call_quotas" (
    "day" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scope_id" TEXT NOT NULL,
    "feature_group" TEXT NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ai_call_quotas_pkey" PRIMARY KEY ("day","scope","scope_id","feature_group")
);
