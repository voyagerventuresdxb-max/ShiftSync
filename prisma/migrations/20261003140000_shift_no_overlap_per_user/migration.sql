-- Race-proof guard for the split-shift rule: one person can never hold two
-- shifts whose [start_time, end_time) ranges overlap, whatever path wrote
-- them (REST, voice, template apply, roster import, concurrent requests).
-- The app-level check in server/src/lib/actions/shiftActions.ts stays for
-- its friendly message; this constraint is what makes two simultaneous
-- writes impossible to both succeed.
--
-- Additive: no column changes, no data changes. Open (unassigned) shifts and
-- CANCELLED shifts are outside the rule. Segments that only touch (15:00 end,
-- 15:00 start) are allowed: the ranges are half-open.
--
-- Pre-check: if the data already violates the rule, this migration fails
-- CLEARLY instead of leaving a half-applied constraint. Fix the rows first
-- (the read-only detection query is in docs/split-shift-overlap-guard.md),
-- then re-run `prisma migrate deploy`.

CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
DECLARE
  violating_pairs integer;
BEGIN
  SELECT count(*) INTO violating_pairs
  FROM shifts a
  JOIN shifts b
    ON a.user_id = b.user_id
   AND a.id < b.id
   AND a.start_time < b.end_time
   AND b.start_time < a.end_time
  WHERE a.user_id IS NOT NULL
    AND a.status <> 'CANCELLED'
    AND b.status <> 'CANCELLED';
  IF violating_pairs > 0 THEN
    RAISE EXCEPTION USING
      MESSAGE = format('shift_no_overlap_per_user: %s pair(s) of overlapping shifts for one person already exist; resolve them before applying this migration', violating_pairs),
      HINT = 'Run the detection query in docs/split-shift-overlap-guard.md to list them, fix or cancel the duplicates, then re-run prisma migrate deploy.';
  END IF;
END $$;

ALTER TABLE "shifts"
  ADD CONSTRAINT "shifts_no_overlap_per_user"
  EXCLUDE USING gist (
    "user_id" WITH =,
    tsrange("start_time", "end_time", '[)') WITH &&
  )
  WHERE ("user_id" IS NOT NULL AND "status" <> 'CANCELLED');
