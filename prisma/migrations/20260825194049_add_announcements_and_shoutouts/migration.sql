-- CreateTable
CREATE TABLE "announcements" (
    "id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "author_id" TEXT,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "edited_at" TIMESTAMP(3),

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shoutouts" (
    "id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "author_id" TEXT,
    "shift_snapshot" TEXT,
    "note" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shoutouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "announcements_location_id_created_at_idx" ON "announcements"("location_id", "created_at");

-- CreateIndex
CREATE INDEX "shoutouts_location_id_created_at_idx" ON "shoutouts"("location_id", "created_at");

-- CreateIndex
CREATE INDEX "shoutouts_employee_id_idx" ON "shoutouts"("employee_id");

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shoutouts" ADD CONSTRAINT "shoutouts_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shoutouts" ADD CONSTRAINT "shoutouts_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shoutouts" ADD CONSTRAINT "shoutouts_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
