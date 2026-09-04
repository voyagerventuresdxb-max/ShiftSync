-- Enforce "at most one open clock-in per user" at the database level.
-- Prisma's schema DSL cannot express a partial/conditional unique index, so
-- this is hand-written. See the comment above the AttendanceLog model in
-- prisma/schema.prisma for why no @@unique appears there for this invariant.
CREATE UNIQUE INDEX "attendance_logs_one_open_per_user" ON "attendance_logs" ("user_id") WHERE "clock_out_at" IS NULL;
