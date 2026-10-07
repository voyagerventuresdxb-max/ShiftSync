-- CreateTable
CREATE TABLE "roster_reading_cache" (
    "id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "file_sha256" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "reading" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roster_reading_cache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "roster_reading_cache_location_id_file_sha256_version_key" ON "roster_reading_cache"("location_id", "file_sha256", "version");

-- AddForeignKey
ALTER TABLE "roster_reading_cache" ADD CONSTRAINT "roster_reading_cache_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
