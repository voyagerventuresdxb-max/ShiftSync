# Split shifts: the database-level overlap guard

Split shifts (#78) let one person hold two shifts on one day. The rule that goes with it, **no
two shifts of one person may overlap in time**, was enforced only in application code
(`findShiftOverlap` / `findBatchOverlap` in `server/src/lib/actions/shiftActions.ts`). Two
requests arriving together could both pass that check and both be written.

Migration `20261003140000_shift_no_overlap_per_user` adds the database half:

```sql
ALTER TABLE shifts ADD CONSTRAINT shifts_no_overlap_per_user
  EXCLUDE USING gist (user_id WITH =, tsrange(start_time, end_time, '[)') WITH &&)
  WHERE (user_id IS NOT NULL AND status <> 'CANCELLED');
```

- Half-open ranges: segments that only touch (ends 15:00, starts 15:00) are allowed.
- Open (unassigned) shifts and CANCELLED shifts are outside the rule.
- Needs the `btree_gist` extension (the migration creates it; it is a standard, trusted
  PostgreSQL extension and is available on Supabase).
- Prisma cannot express an exclusion constraint in `schema.prisma`; the migration is plain SQL
  and the model carries a comment pointing at it. `npm run prisma:check-drift` stays clean because
  Prisma ignores constraint types it does not model.

Every writer maps a violation to the same 409 the app-level check already produces
(`ShiftOverlapError`): REST create and edit, voice CREATE_SHIFT / EDIT_SHIFT, template apply,
swap approval (through `updateShift`) and roster import (`persistShifts`, which now also runs the
friendly `findBatchOverlap` pre-check over the file).

## Before deploying: check the data (read-only)

The migration refuses to apply (clear error, nothing half-done) if overlapping pairs already exist.
Run this first against production (read-only) to see whether there is anything to fix:

```sql
SELECT a.user_id,
       u.full_name,
       a.id   AS shift_a, a.start_time AS a_start, a.end_time AS a_end, a.status AS a_status,
       b.id   AS shift_b, b.start_time AS b_start, b.end_time AS b_end, b.status AS b_status
FROM shifts a
JOIN shifts b
  ON a.user_id = b.user_id
 AND a.id < b.id
 AND a.start_time < b.end_time
 AND b.start_time < a.end_time
JOIN users u ON u.id = a.user_id
WHERE a.user_id IS NOT NULL
  AND a.status <> 'CANCELLED'
  AND b.status <> 'CANCELLED'
ORDER BY a.user_id, a.start_time;
```

Zero rows: deploy. Otherwise, for each pair, either cancel the duplicate (`status = 'CANCELLED'`),
move it, or unassign it (`user_id = NULL`) in the app, then re-run the query and deploy.

If the migration is applied by `npm run server:start` (`prisma migrate deploy`) and the pre-check
fails, the deploy's health check fails and the previous deploy keeps serving; nothing is changed in
the database. Fix the rows and redeploy.

## Tests

`server/src/lib/actions/shiftOverlapGuard.test.ts`:
- six simultaneous `POST /api/shifts` for one person at overlapping times: exactly one 201, the
  rest 409, one row;
- two concurrent direct `prisma.shift.create` calls: one row, the loser is a `ShiftOverlapError`;
- a raw `INSERT` that bypasses every app check is rejected by the constraint;
- touching segments, an open shift and a CANCELLED shift are all allowed;
- a roster import whose rows overlap a stored shift is refused as a whole (409, nothing imported);
- the detection query and the migration's pre-check, run inside a rolled-back transaction with the
  constraint dropped and two overlapping rows inserted: the query lists the pair and the pre-check
  raises the documented error.
