-- AlterTable
ALTER TABLE "shifts" ADD COLUMN     "sidework" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "rota_templates" (
    "id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "entries" JSONB NOT NULL,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rota_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rota_publishes" (
    "id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "week_start" DATE NOT NULL,
    "published_at" TIMESTAMP(3) NOT NULL,
    "published_by_id" TEXT,
    "notified_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "rota_publishes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rota_templates_location_id_idx" ON "rota_templates"("location_id");

-- CreateIndex
CREATE UNIQUE INDEX "rota_publishes_location_id_week_start_key" ON "rota_publishes"("location_id", "week_start");

-- AddForeignKey
ALTER TABLE "rota_templates" ADD CONSTRAINT "rota_templates_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rota_templates" ADD CONSTRAINT "rota_templates_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rota_publishes" ADD CONSTRAINT "rota_publishes_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rota_publishes" ADD CONSTRAINT "rota_publishes_published_by_id_fkey" FOREIGN KEY ("published_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
