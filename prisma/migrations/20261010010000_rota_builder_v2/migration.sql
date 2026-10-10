-- Rota builder v2: departments, venue shift types, the versioned week
-- document, per-person-day leave statuses, department minimums, and the
-- shift columns that carry a frozen type. Additive only — no column is
-- dropped and no existing row changes meaning. The partial unique index on
-- shifts (one live row per person per day) is guarded by a pre-check that
-- aborts the migration with a readable message if any venue already has two
-- live shifts for one person on one day, so production is never left
-- half-migrated: resolve those rows first (see docs/rota-builder-v2.md).

-- Pre-check for the one-live-shift-per-person-day rule (v2 models a split as
-- one row with two ranges). Lists the offending pairs so they can be merged
-- or cancelled before re-running `prisma migrate deploy`.
DO $$
DECLARE offending INTEGER;
BEGIN
  SELECT COUNT(*) INTO offending FROM (
    SELECT "user_id", "date" FROM "shifts"
    WHERE "user_id" IS NOT NULL AND "status" <> 'CANCELLED'
    GROUP BY "user_id", "date" HAVING COUNT(*) > 1
  ) d;
  IF offending > 0 THEN
    RAISE EXCEPTION 'rota_builder_v2: % person-day(s) have more than one live shift. Merge them into one shift with two ranges (or cancel one) and re-run. Query: SELECT user_id, date, COUNT(*) FROM shifts WHERE user_id IS NOT NULL AND status <> ''CANCELLED'' GROUP BY 1,2 HAVING COUNT(*) > 1;', offending;
  END IF;
END $$;

-- CreateEnum
CREATE TYPE "RotaWeekState" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "LeaveType" AS ENUM ('DAY_OFF', 'ANNUAL_LEAVE', 'SICK_LEAVE', 'UNPAID_LEAVE', 'HALF_DAY');

-- CreateEnum
CREATE TYPE "RotaLeaveStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'LEAVE_MARKED';
ALTER TYPE "AuditAction" ADD VALUE 'LEAVE_REMOVED';
ALTER TYPE "AuditAction" ADD VALUE 'WEEK_PATCHED';
ALTER TYPE "AuditAction" ADD VALUE 'WEEK_PUBLISHED';
ALTER TYPE "AuditAction" ADD VALUE 'SHIFT_TYPE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'SHIFT_TYPE_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'SHIFT_TYPE_ARCHIVED';
ALTER TYPE "AuditAction" ADD VALUE 'TIME_OFF_REQUESTED';

-- CreateTable
CREATE TABLE "departments" (
    "id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tint" TEXT NOT NULL DEFAULT 'gold',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_types" (
    "id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ranges" JSONB NOT NULL,
    "ends_next_day" BOOLEAN NOT NULL DEFAULT false,
    "tint" TEXT NOT NULL DEFAULT 'gold',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shift_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rota_weeks" (
    "id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "week_start" DATE NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "state" "RotaWeekState" NOT NULL DEFAULT 'DRAFT',
    "published_version" INTEGER,
    "published_at" TIMESTAMP(3),
    "published_by_id" TEXT,
    "published_snapshot" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rota_weeks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rota_leaves" (
    "id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_by_id" TEXT,
    "date" DATE NOT NULL,
    "type" "LeaveType" NOT NULL,
    "status" "RotaLeaveStatus" NOT NULL DEFAULT 'DRAFT',
    "time_off_request_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rota_leaves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "department_minimums" (
    "id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "min_headcount" INTEGER NOT NULL,

    CONSTRAINT "department_minimums_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "roles" ADD COLUMN "department_id" TEXT;

-- AlterTable
ALTER TABLE "shifts" ADD COLUMN "shift_type_id" TEXT,
ADD COLUMN "department_id" TEXT,
ADD COLUMN "ranges" JSONB,
ADD COLUMN "ends_next_day" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "note" VARCHAR(80),
ADD COLUMN "published_at" TIMESTAMP(3),
ADD COLUMN "edited_since_publish" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: a pre-v2 shift's frozen range is its own start/end as venue-local
-- wall-clock; `ends_next_day` when the end instant falls on a later venue day.
UPDATE "shifts" s
SET "ranges" = jsonb_build_array(jsonb_build_object(
      'start', to_char((s."start_time" AT TIME ZONE 'UTC') AT TIME ZONE l."timezone", 'HH24:MI'),
      'end',   to_char((s."end_time"   AT TIME ZONE 'UTC') AT TIME ZONE l."timezone", 'HH24:MI'))),
    "ends_next_day" = (((s."end_time" AT TIME ZONE 'UTC') AT TIME ZONE l."timezone")::date > ((s."start_time" AT TIME ZONE 'UTC') AT TIME ZONE l."timezone")::date),
    "published_at" = CASE WHEN s."status" = 'PUBLISHED' THEN s."updated_at" ELSE NULL END
FROM "locations" l
WHERE l."id" = s."location_id" AND s."ranges" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "departments_location_id_name_key" ON "departments"("location_id", "name");
CREATE UNIQUE INDEX "shift_types_location_id_name_key" ON "shift_types"("location_id", "name");
CREATE INDEX "shift_types_location_id_sort_order_idx" ON "shift_types"("location_id", "sort_order");
CREATE UNIQUE INDEX "rota_weeks_location_id_week_start_key" ON "rota_weeks"("location_id", "week_start");
CREATE UNIQUE INDEX "rota_leaves_user_id_date_key" ON "rota_leaves"("user_id", "date");
CREATE INDEX "rota_leaves_location_id_date_idx" ON "rota_leaves"("location_id", "date");
CREATE UNIQUE INDEX "department_minimums_department_id_weekday_key" ON "department_minimums"("department_id", "weekday");
CREATE INDEX "roles_department_id_idx" ON "roles"("department_id");
CREATE INDEX "shifts_location_id_date_status_idx" ON "shifts"("location_id", "date", "status");
CREATE INDEX "shifts_shift_type_id_idx" ON "shifts"("shift_type_id");
-- One live shift per person per day (raw SQL: Prisma cannot express a partial unique index).
CREATE UNIQUE INDEX "shifts_one_live_per_person_day" ON "shifts"("user_id", "date") WHERE "user_id" IS NOT NULL AND "status" <> 'CANCELLED';

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shift_types" ADD CONSTRAINT "shift_types_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rota_weeks" ADD CONSTRAINT "rota_weeks_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rota_weeks" ADD CONSTRAINT "rota_weeks_published_by_id_fkey" FOREIGN KEY ("published_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "rota_leaves" ADD CONSTRAINT "rota_leaves_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rota_leaves" ADD CONSTRAINT "rota_leaves_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rota_leaves" ADD CONSTRAINT "rota_leaves_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "department_minimums" ADD CONSTRAINT "department_minimums_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "department_minimums" ADD CONSTRAINT "department_minimums_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "roles" ADD CONSTRAINT "roles_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_shift_type_id_fkey" FOREIGN KEY ("shift_type_id") REFERENCES "shift_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
