-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateTable
CREATE TABLE "floor_plan_images" (
    "id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "file_url" TEXT NOT NULL,
    "original_name" TEXT,
    "mime_type" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "floor_plan_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "floor_sections" (
    "id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "floor_plan_image_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "polygon" JSONB NOT NULL,
    "pax_capacity" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "floor_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "section_assignments" (
    "id" TEXT NOT NULL,
    "section_id" TEXT NOT NULL,
    "staff_id" TEXT NOT NULL,
    "shift_date" DATE NOT NULL,
    "duty_label" TEXT,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'DRAFT',
    "created_by_id" TEXT,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "section_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "floor_plan_images_location_id_created_at_idx" ON "floor_plan_images"("location_id", "created_at");

-- CreateIndex
CREATE INDEX "floor_sections_location_id_idx" ON "floor_sections"("location_id");

-- CreateIndex
CREATE INDEX "floor_sections_floor_plan_image_id_idx" ON "floor_sections"("floor_plan_image_id");

-- CreateIndex
CREATE INDEX "section_assignments_shift_date_idx" ON "section_assignments"("shift_date");

-- CreateIndex
CREATE INDEX "section_assignments_staff_id_idx" ON "section_assignments"("staff_id");

-- CreateIndex
CREATE UNIQUE INDEX "section_assignments_section_id_staff_id_shift_date_key" ON "section_assignments"("section_id", "staff_id", "shift_date");

-- AddForeignKey
ALTER TABLE "floor_plan_images" ADD CONSTRAINT "floor_plan_images_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "floor_sections" ADD CONSTRAINT "floor_sections_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "floor_sections" ADD CONSTRAINT "floor_sections_floor_plan_image_id_fkey" FOREIGN KEY ("floor_plan_image_id") REFERENCES "floor_plan_images"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section_assignments" ADD CONSTRAINT "section_assignments_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "floor_sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section_assignments" ADD CONSTRAINT "section_assignments_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section_assignments" ADD CONSTRAINT "section_assignments_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
