-- Rate-limits the paid vision-fallback roster parse (hosted Gemini/Vertex AI
-- call, image/scanned-PDF uploads only) to once per location per week.
ALTER TABLE "locations" ADD COLUMN "last_vision_fallback_used_at" TIMESTAMP(3);
