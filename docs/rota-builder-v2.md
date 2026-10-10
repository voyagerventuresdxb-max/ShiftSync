# Rota builder v2 — the week model

The roster is one document per (venue, Monday): `shifts` + `rota_leaves`,
versioned by `rota_weeks.version`. Every write presents the version it last
saw and gets the new one back; every reader refetches on a bump. The contract
both sides share is `shared/rotaWeek.ts`; the server side is
`server/src/lib/actions/weekActions.ts` and `server/src/routes/weeks.ts`, with
the supporting routes for shift types, departments and time off.

## Routes

Every route is venue-scoped by the caller's session: a `:locationId` that is
not the caller's venue is a 403, an id of another venue's record is a 404.
"Manager" means a MANAGER or OWNER session.

| Method and path | Who | Answers |
| --- | --- | --- |
| `GET /api/weeks/:locationId/:weekStart` | any session of the venue, or the venue's kiosk token | `WeekDocDto` (staff/kiosk: the published view, below) |
| `PATCH /api/weeks/:locationId/:weekStart` | manager | `WeekPatchInput` → 200 ok / 409 `version_conflict` / 422 `{ error, refusal, op }` / 400 |
| `POST /api/weeks/:locationId/:weekStart/publish-preview` | manager | `PublishPreviewDto` |
| `POST /api/weeks/:locationId/:weekStart/publish` | manager | `{ expectedVersion, fingerprint }` → `PublishResult` (409 on version or fingerprint mismatch, 422 `empty`) |
| `GET /api/shift-types/:locationId` | any session of the venue | `{ shiftTypes }` — live first, archived after |
| `POST /api/shift-types/:locationId` | manager | `ShiftTypeInput` → 201 `{ shiftType }`; 409 name taken; 400 bad input |
| `POST /api/shift-types/:locationId/bulk` | manager | `{ shiftTypes: ShiftTypeInput[] }` (≤ 20) → `{ shiftTypes (the venue's full list), skipped (names) }` |
| `PATCH /api/shift-types/:locationId/:id` | manager | `ShiftTypePatch` → `{ shiftType }`; 409 name taken |
| `POST /api/shift-types/:locationId/:id/archive` | manager | `{ shiftType }` (idempotent) |
| `GET /api/departments/:locationId` | any session of the venue | `{ departments, minimums }` (real departments only; "Other" is the week document's) |
| `POST /api/departments/:locationId` | manager | `DepartmentInput` → 201 `{ department }`; 409 name taken; 404 a role not at the venue |
| `PATCH /api/departments/:locationId/:id` | manager | `{ name?, tint?, sortOrder?, roleIds? }` → `{ department }`; `roleIds` replaces the set |
| `PUT /api/departments/:locationId/:id/minimums` | manager | `{ minimums: { weekday, minHeadcount }[] }` → `{ minimums }` (replaces; 0 = none) |
| `POST /api/time-off` | any session (staff for themselves; a manager may pass `userId` of their venue) | `{ userId?, startDate, endDate, reason? }` → 201 `{ request }`; 409 overlaps a pending request; 400 past/bad dates; 403 staff naming someone else |
| `GET /api/time-off/:locationId?status=pending\|all` | any session of the venue (staff: own only) | `{ requests: TimeOffRequestDto[] }` |
| `PATCH /api/time-off/:id` | manager | `TimeOffDecisionInput` → 200 `{ result: 'ok', request, versions }` / 409 `{ result: 'not_pending' }` / 422 `{ result: 'refused', refusal, message }` / 404 |

Changed, same shapes as before: `GET /api/my-shifts` (adds `MyShiftV2Fields`,
published only), `POST /api/attendance/clock-in` (auto-matches the shift; the
response adds `shiftId`), `POST /api/schedules/upload` (adds
`proposedShiftTypes`), `POST /api/rota-templates` (v2 entry fields), the
legacy `/api/shifts` routes (through the patch; staff get the published view).

## Tables

| Table | Role |
| --- | --- |
| `departments` | A venue's grouping of roles (Floor, Bar, Kitchen…). `roles.department_id` is nullable; ungrouped roles appear under a synthetic department `other` ("Other", tint `cream`) in the week document. |
| `shift_types` | Venue timings the manager drags onto the grid (`ranges` = 1–2 `{start,end}` HH:MM, `ends_next_day`). A shift **freezes** its own copy when created, so editing a type never rewrites history. |
| `rota_weeks` | One row per (venue, Monday), created lazily by the first write. `version` is the optimistic-concurrency token; `published_snapshot` is what staff were last told; `published_version`/`published_at`/`published_by_id` describe the last publish. |
| `rota_leaves` | A person-day status (Day off, Annual leave, Sick, Unpaid, Half day). One per (user, date). A leave day never also holds a shift. |
| `department_minimums` | Optional per-department, per-weekday headcount. Drives only the `uncovered` flag in the coverage row. |
| `shifts` (new columns) | `shift_type_id`, `department_id`, `ranges`, `ends_next_day`, `note` (≤ 80 chars, staff-visible — distinct from the manager-only `manager_notes`), `published_at`, `edited_since_publish`. |

A partial unique index, `shifts_one_live_per_person_day` on
`(user_id, date) WHERE user_id IS NOT NULL AND status <> 'CANCELLED'`, enforces
one live shift per person per day. A split shift is **one** row with two
ranges; its `start_time`/`end_time` instants span both (first start → last end,
on the next venue day when the last range crosses midnight), so legacy readers
(attendance, kiosk, voice reads, `routes/shifts.ts`'s DTO) keep working.

## Statuses and what staff see

* `DRAFT` — created by any write, visible to managers only.
* `PUBLISHED` — after a publish (or written published by the roster import).
* `CANCELLED` — a **published** shift the manager deleted. Hidden from
  managers at once, but kept so the next publish can tell the person their
  shift was removed; `publishWeek` then hard-deletes it. Deleting a `DRAFT`
  shift removes the row at once.
* `edited_since_publish` — set when a published shift is changed (the gold dot).

A published shift is edited in place (one row, one version counter), but
**staff keep seeing what they were told until the next publish** (design board
E: "staff surfaces still show the published value until Publish").
`weekActions.toldShiftOf` renders a row from the week's `published_snapshot`:
a draft is never visible, an edited or soft-cancelled published shift shows
its told version (person, day, times, type, note), a published row the
snapshot does not list shows as it stands. Leaves likewise come from the
snapshot. This "told view" is what these readers return to STAFF (and the
kiosk): `GET /api/weeks/…` (also: no `editedSincePublish`, no
`hasUnpublishedChanges`, a `pendingRequestId` only on the viewer's own shift,
only the viewer's own requests; kiosk: no requests), `GET /api/my-shifts`, and
the legacy `GET /api/shifts/:locationId` for a STAFF session or kiosk token.
Readers of the live row see an edit at once: attendance auto-match, voice
reads (owned by the voice layer), floor-plan assignments.

A week **published before v2** (a legacy `rota_publishes` row, or PUBLISHED
rows the old import wrote) has no `rota_weeks` row. Until something writes to
it, readers treat its PUBLISHED rows as the told snapshot; the first write
creates the row as `PUBLISHED`, version 1, `published_version` 1, with that
snapshot — so the first v2 publish lists only what changed since, instead of
re-notifying everyone.

## The patch API

```
GET   /api/weeks/:locationId/:weekStart                   any session of the venue, or the kiosk token
PATCH /api/weeks/:locationId/:weekStart                   manager; body WeekPatchInput
POST  /api/weeks/:locationId/:weekStart/publish-preview   manager
POST  /api/weeks/:locationId/:weekStart/publish           manager; body { expectedVersion, fingerprint }
```

`weekStart` must be a Monday (`400 WEEK_START_NOT_MONDAY_ERROR` otherwise).

`PATCH` applies a `WeekPatchInput` — `{ expectedVersion?, ops[], overridePendingRequests?, note? }`
— atomically, in one transaction, under a per-week Postgres advisory lock
(`week:<locationId>:<weekStart>`), with a conditional `UPDATE … WHERE version = <seen>`
as the belt to that brace. Responses:

* `200` `{ result: 'ok', version, results[], declinedRequestIds[], week }` — `results` is per op, in order; `tempId` is echoed for creates.
* `409` `{ result: 'version_conflict', currentVersion, week }` — the client's `expectedVersion` is stale; nothing landed.
* `422` `{ error, refusal, op }` — one op broke a rule; nothing landed (the whole batch rolls back). `op` is the index, `-1` for a batch-level refusal.

Rules every op is checked against, in the database **as it stands when the op
runs** (so an earlier op in the same batch counts):

| Refusal | When |
| --- | --- |
| `not_monday` | `weekStart` is not a Monday. |
| `outside_week` | An op's date (or the shift's current date) is not in `[weekStart, +7)`. A cross-week move is two patches. |
| `past_day` | The venue-local day has passed. Sources `import` (backfill) and `swap` (recording a cover that already happened, as before v2) are exempt. |
| `unknown_shift` / `unknown_person` / `unknown_role` / `unknown_shift_type` | Not at this venue, cancelled, deactivated or archived. `unknown_role` also covers a department not at the venue. |
| `bad_ranges` | Not 1–2 well-formed HH:MM ranges, or neither `shiftTypeId` nor `ranges` given on a create. |
| `bad_leave_type` | `setLeave.type` is not a `LeaveTypeCode`. |
| `note_too_long` | `note` > 80 characters. |
| `already_has_shift` | The person already has a live shift that day. |
| `overlap` | The instants overlap another shift of that person (a cross-midnight shift against the next day's). |
| `person_on_leave` | A blocking leave (Annual, Sick, Unpaid) — or any leave created by an approved time-off request — is on that person-day. A manager's Day off / Half day gives way: it is removed (`LEAVE_REMOVED`) and the shift lands. |
| `pending_request` | A PENDING time-off request covers that person-day and `overridePendingRequests` is not set. With it, the request is `DECLINED` (conditionally: a request decided a moment ago is a `pending_request` refusal, not overwritten; `reviewedById` = actor, note "Declined by scheduling") in the same transaction, listed in `declinedRequestIds`, and the requester is told after commit ("Time off declined: …"). |
| `leave_over_shift` | `setLeave` on a day the person has a live shift, whatever the leave type. |

Side effects of an op:

* create → `DRAFT`, `created_by_id` = actor, department defaults to the role's, ranges frozen from the type (or custom).
* update → who/when/what; a published shift gets `edited_since_publish`. Changing the person or the day deletes the old person-day's `section_assignments` (floor sections follow the shift). New `ranges` without a `shiftTypeId` keep the shift's type label, even when that type has been archived since (only a type named by the op must be live).
* delete → draft: hard delete; published: `CANCELLED` (see above). Section assignments cleared either way.
* setLeave / clearLeave → upsert / delete `rota_leaves`. Clearing a leave that came from an approved request does not reopen the request.
* Audit: one row per op (`SHIFT_CREATED` / `SHIFT_UPDATED` / `SHIFT_DELETED` / `LEAVE_MARKED` / `LEAVE_REMOVED`, `TIME_OFF_DECLINED` on override) whose note starts with `[<source>]`, plus one `WEEK_PATCHED` row per batch.

A unique violation of `shifts_one_live_per_person_day` (a writer outside the
week lock) is answered as `already_has_shift`, op `-1`, never a 500.

Sources: `grid` (the week grid and the legacy `routes/shifts.ts` routes),
`voice`, `template` (`rotaActions.applyRotaTemplate`), `import`
(`parsing/persistShifts.ts`), `swap` (`swapActions.decideSwapRequest`),
`timeOff`, `bulk` (`POST /api/shifts/bulk`, one patch per distinct week).

### Legacy callers

`POST/PATCH/DELETE /api/shifts` and `POST /api/shifts/bulk` build one-op
patches with no `expectedVersion` (logged once as a warning) and keep their
old response shapes; `breakMinutes`/`briefingNote`/`sidework` are outside the
week document and are written directly after the patch. `PATCH` only puts
what actually changed into the patch (the old Shift Editor sends date, start
and end back unchanged on every save; re-sending them would collapse a split
shift into one range and set the gold dot for nothing). Moving a shift to
another week through `PATCH` is refused (`outside_week`, 422). Refusals map to
the statuses that client already handles: unknown ids → 404, a collision with
a shift / leave / pending request → 409, anything else → 422.

`POST /api/shifts/:locationId/publish` (and voice `PUBLISH_ROTA`) still run the
legacy `publishRota`, which takes the week lock first and now also writes the v2 snapshot (`snapshotWeek`),
clears `edited_since_publish`, publishes draft leaves and drops `CANCELLED`
rows, so the new grid and the old banner agree. `GET …/publish-status` reads
the week row when there is one.

A swap approval reassigns through the patch inside the request's own status
flip. It keeps the old guard: under the week lock the shift must still belong
to the requester, else `conflict` (409, as before). The cover already working
that day → `409 target_has_shift`; on blocking leave, or with a pending
time-off request that day (an approval never declines someone's request) →
`409 target_on_leave`. A `SWAP`-type request (the model has
no target-shift column) trades the two people's shifts on the requester's day
when the cover has one — via an open shift, because a person-day holds only
one live shift — and otherwise behaves like a cover.

## Shift types, departments, time off

**Shift types** (`routes/shiftTypes.ts`): name 1–40 characters, unique per
venue ignoring case (archived ones included) → 409; `ranges` must pass
`validateRanges` (1–2 ranges, only the last may cross midnight, no overlap);
`tint` must be one of `SHIFT_TINTS`; `endsNextDay` is computed
(`rangesEndNextDay`), never taken from the client; a new type sorts last
unless `sortOrder` is given. Editing a type's times **never** rewrites
existing shifts — each froze its ranges. Archiving removes it from the
palette: a patch naming it is refused `unknown_shift_type`; shifts made from
it keep times and label. Audited: `SHIFT_TYPE_CREATED` / `_UPDATED` /
`_ARCHIVED`. `bulk` validates every entry first (one bad entry → 400, nothing
saved) and skips names the venue already has.

**Departments** (`routes/departments.ts`): name unique per venue → 409; every
`roleIds` entry must be a role of the venue (else 404); on PATCH it replaces
the set (listed roles move here from wherever they were; roles no longer
listed become ungrouped, "Other"). Minimums: weekday 0 (Sunday) … 6, each at
most once, headcount 0–99; PUT replaces the department's set. Only the
coverage row reads them. Department writes are not audited (no audit action
exists for them) and do not bump week versions: an open grid sees a new
department or type on its next fetch.

**Time off** (`routes/timeOff.ts`, `lib/actions/timeOffActions.ts`): a request
is at most 60 days, cannot start on a past venue day and cannot overlap
another PENDING request of the person. Creation is audited
(`TIME_OFF_REQUESTED`) and, when filed by staff, the venue's managers are
told. A decision is claimed with a conditional `updateMany … WHERE status =
'PENDING'`, so two managers can never both decide a request (the second gets
409 `not_pending`). **Approve**, in one transaction: for every week the range
touches (in date order — the order every multi-week writer takes week locks
in), one week patch (source `timeOff`) turns any live shift of the person on
those days into an **open shift** (`userId` null, so the coverage row flags
it) and marks each day as leave (`leaveType`, default `ANNUAL_LEAVE`); the
leave rows get `time_off_request_id`, which locks them against shifts
whatever their type. Days already past are skipped, not refused. A refusal in
any week (say the person was deactivated) rolls the whole decision back
(422). The new leaves are drafts like any manager edit: staff see them after
the next publish; the requester is told at once ("Time off approved: Tue 14 –
Thu 16 Oct"). **Decline** only flips the status ("Time off declined: …").
Both are audited (`TIME_OFF_APPROVED` / `TIME_OFF_DECLINED`). The response's
`versions` maps each touched Monday to its new week version.

## My shifts, clock-in, roster import, templates

* `GET /api/my-shifts`: the next five shifts from the venue's today, published
  only, each **as the person was told it** (a shift moved to someone else
  since publish still shows for its told owner until the next publish tells
  them both). Each item keeps its old fields and adds `MyShiftV2Fields`:
  `shiftTypeName` (the told type's name), `ranges` (both of a split),
  `endsNextDay`, `note` (the staff-visible note, never `managerNotes`).
* `POST /api/attendance/clock-in` with no `shiftId`: `lib/clockInShift.ts`
  ties the log to the person's PUBLISHED (or completed) shift at their venue
  by the start-day rule — today's shift, except that between 00:00 and 06:00
  venue time last night's cross-midnight shift wins while it has not ended.
  No such shift: the log is recorded without one, as before. A sent `shiftId`
  is used as before.
* `POST /api/schedules/upload` returns `proposedShiftTypes`
  (`parsing/proposeShiftTypes.ts`, pure): two rows of one person on one day
  are one split (as the import stores them), identical timings are counted,
  timings the venue already has as a live type are dropped, at most eight,
  most used first. Name: the in-file legend's label when a legend entry has
  the same times ("Morning" from "M = Morning 07:00-15:00"), else "Morning"
  (starts before 11:00), "Mid" (11:00–14:59), "Evening" (15:00 on), "Split"
  for two ranges, with " 2", " 3" … so no name repeats the venue's or another
  proposal's. Tints cycle gold, sand, clay, ochre, sage, cream.
* Roster import (`parsing/persistShifts.ts`): takes every touched week's lock
  (date order) before reading the rota; a day with blocking leave (or leave
  from an approved request) keeps its leave and the imported shift is
  reported like an overlap (`existingLeave` set, times empty); a Day off /
  Half day gives way. The imported rows are written PUBLISHED and **merged**
  into the week's snapshot (`snapshotWeek(…, { mergeShiftIds })`): a manager's
  drafts in the same week are not recorded as told, so the next publish still
  announces them.
* Templates (`POST /api/rota-templates`): entries are validated (dayOffset
  0–6, role id, start/end HH:MM) and may carry `shiftTypeId` (a live type of
  the venue), `ranges` (1–2, validated) and `shiftNote` (the staff-visible
  note, ≤ 80); `start`/`end` are derived from `ranges` or the type when
  omitted, so pre-v2 readers keep working. Apply: a live type without saved
  ranges takes the type's current times; saved ranges win (labelled with the
  type if it still exists); an archived type falls back to the saved times; a
  pre-v2 entry uses `start`/`end`. An entry's `note` stays the manager-only
  `managerNotes` it always was. A person who has left (deactivated or
  deleted) gets an open shift instead of failing the whole apply. Any other
  refusal (someone already on that day, on leave, a past day) still refuses
  the whole template (409), nothing half-applied.

## Publish

1. `publish-preview` returns `PublishPreviewDto`: one row per person whose
   person-days differ between `published_snapshot` and the live rows
   (`before`/`after` as short text, e.g. `Evening 16:00–01:00`, `Day off`,
   `null`). A removal counts for the snapshot's person; a reassignment for
   both. `urgent` = the shift starts within 24 h. `notifiedCount` = rows whose
   person has a device (a push subscription, or a session in the last 30
   days); the rest are in `noDeviceUserIds`. `uncovered` comes from the
   coverage row. `fingerprint` = sha256 of `{ locationId, weekStart, version, rows }`
   with rows sorted by `userId`, `date`.
2. `publish` presents `expectedVersion` + `fingerprint`. Same lock and version
   check as a patch; the preview is recomputed and compared — `409 fingerprint_mismatch`
   (with the fresh preview) if the week changed under the confirm sheet;
   `422 empty` when there is nothing at all to publish (a week that only
   removes shifts still publishes — people must be told). Then drafts →
   `PUBLISHED` (`published_at` set), `edited_since_publish` cleared,
   `CANCELLED` rows deleted, draft leaves → `PUBLISHED`, a new snapshot with
   `published_version` = the new version, the legacy `rota_publishes` row
   upserted, `WEEK_PUBLISHED` audited, and — after commit — one
   `notifyUser` per changed person with a device ("Your week is ready" on a
   first publish, "Your week changed" after; the body names the days and
   before → after, or a count when more than three).

## Migration pre-check and duplicate person-days

`prisma/migrations/20261010010000_rota_builder_v2` is additive, backfills
`ranges`/`ends_next_day`/`published_at` for existing rows, and creates the
partial unique index. It **aborts** before touching anything if any venue has
two live shifts for one person on one day, printing the count and the query:

```sql
SELECT user_id, date, COUNT(*) FROM shifts
WHERE user_id IS NOT NULL AND status <> 'CANCELLED'
GROUP BY 1, 2 HAVING COUNT(*) > 1;
```

Resolve them with this runbook (verified against a scratch database: a
true split, an exact duplicate and an attendance log pointing at the second
half). Take a backup first.

**Before** `prisma migrate deploy` — park every extra live shift of a
person-day (the earliest start is kept), so the unique index can be built:

```sql
BEGIN;
CREATE TABLE rota_v2_parked AS
SELECT s.id AS parked_id, k.id AS kept_id, false AS folded
FROM shifts s
JOIN LATERAL (
  SELECT k.id FROM shifts k
  WHERE k.user_id = s.user_id AND k.date = s.date AND k.status <> 'CANCELLED'
  ORDER BY k.start_time, k.id LIMIT 1
) k ON true
WHERE s.user_id IS NOT NULL AND s.status <> 'CANCELLED' AND s.id <> k.id;
ALTER TABLE rota_v2_parked ADD COLUMN status "ShiftStatus";
UPDATE rota_v2_parked p SET status = s.status FROM shifts s WHERE s.id = p.parked_id;
UPDATE shifts SET status = 'CANCELLED' WHERE id IN (SELECT parked_id FROM rota_v2_parked);
COMMIT;
```

Then deploy (the migration backfills `ranges` for every row, parked ones
included). **After** — fold true splits into the kept row, review the rest,
re-point references and remove the parked rows:

```sql
BEGIN;
-- A true split: exactly one parked row, the kept row's single range ends before it starts the same day.
UPDATE rota_v2_parked p SET folded = true
FROM shifts k, shifts m
WHERE k.id = p.kept_id AND m.id = p.parked_id
  AND (SELECT COUNT(*) FROM rota_v2_parked q WHERE q.kept_id = p.kept_id) = 1
  AND jsonb_array_length(k.ranges) = 1 AND jsonb_array_length(m.ranges) = 1
  AND NOT k.ends_next_day
  AND (k.ranges->0->>'end') < (m.ranges->0->>'start');
UPDATE shifts k
SET ranges = k.ranges || m.ranges, end_time = m.end_time, ends_next_day = m.ends_next_day
FROM rota_v2_parked p JOIN shifts m ON m.id = p.parked_id
WHERE k.id = p.kept_id AND p.folded;
-- REVIEW these before going on: duplicates, overlaps and three-shift days. They are deleted below.
SELECT p.*, m.start_time, m.end_time FROM rota_v2_parked p JOIN shifts m ON m.id = p.parked_id WHERE NOT p.folded;
UPDATE attendance_logs a SET shift_id = p.kept_id FROM rota_v2_parked p WHERE a.shift_id = p.parked_id;
UPDATE shift_swap_requests r SET shift_id = p.kept_id FROM rota_v2_parked p WHERE r.shift_id = p.parked_id;
DELETE FROM shifts WHERE id IN (SELECT parked_id FROM rota_v2_parked);
DROP TABLE rota_v2_parked;
COMMIT;
```

If the review shows a parked row that should have stayed (e.g. a real
second job that day), re-create it after the deploy as a split on the kept
row through the grid, or as an open shift. A published week touched this way
has no `rota_weeks` row yet; its first v2 write seeds the snapshot from the
PUBLISHED rows as they then stand (see "Statuses and what staff see").

The roster import (`persistShifts.ts`) now merges two rows for one person-day
into one split shift at import time and reports a third, or a day the person
already works, as an overlap — so a re-import cannot recreate the condition.

## Running the tests

Everything DB-backed goes through the branch-schema wrapper (AGENTS.md §6):

```
npm run db:setup          # once per worktree: local Postgres, migrations, branch schema
npm run prisma:generate   # the client must know the new models
npm run test:server       # all server tests, including:
#   server/src/lib/actions/weekActions.test.ts   version counter, person-day rules, split/cross-midnight instants, publish diff + fingerprint
#   server/src/routes/accessMatrix.test.ts       who may call the four /api/weeks routes
#   server/src/routes/shifts.test.ts             the legacy routes on top of the patch
#   server/src/routes/swapDecide.test.ts         swap approval through the patch
#   server/src/parsing/persistShifts.test.ts     the import writing v2 rows + snapshot
#   server/src/routes/rotaV2.test.ts             weeks API shapes and the staff told view, shift types, departments,
#                                                time off (file, decide, approve → open shift + locked days, races),
#                                                my-shifts v2 fields, clock-in auto-match, templates v2
#   server/src/parsing/proposeShiftTypes.test.ts the import's shift-type proposals (pure)
#   server/src/lib/clockInShift.test.ts          the start-day / overnight clock-in rule (pure)
npm run server:typecheck
```

The CI workflow (`.github/workflows/rota-v2-ci.yml`) migrates and seeds the
branch schema `test:server` runs against (`with-branch-schema.mjs` points it
at `dev_<branch>`, not `public`), and does not set `PUSH_TRANSPORT=record`
(the push and production-guard tests assert the real transport's logs).

To run one file: `node scripts/with-branch-schema.mjs --connection-limit=1 "node --import tsx --test server/src/lib/actions/weekActions.test.ts"`.

## Decisions taken here

* Staff surfaces read the told snapshot, not the live rows (see above); the
  manager's grid is the live document.
* A week published before v2 is adopted as published on its first write.
* Swap approvals may record a past cover; everything else refuses past days.
* Time-off approval writes draft leaves (they reach staff with the next
  publish, like every other manager edit); the requester is told at once.
* A template keeps applying all-or-nothing, except that people who have left
  become open shifts.
* An entry's / shift's `note` is staff-visible; `managerNotes` stays
  manager-only — templates keep their old `note` meaning (manager-only) and
  use `shiftNote` for the staff line.

## Not done (server)

* Voice (`routes/voice.ts`, `server/src/voice/**`) still uses its own paths
  for reads and REQUEST_TIME_OFF; owned by the voice work.
* Attendance auto-match, voice reads and floor-plan assignments read the live
  rows: a published shift edited but not yet re-published is matched with its
  new times.
* No route reverses an approved time-off request; clearing its leave days in
  the grid (`clearLeave`) is the escape hatch and leaves the request APPROVED.
* No audit rows for department or minimum changes (no AuditAction values for
  them; adding some is a migration).
* Department / shift-type edits do not bump week versions.
* Legacy `PATCH /api/shifts/:id` cannot move a shift to another week.
* The organisation-level 12/24 h clock setting does not exist; the week
  document always says `24h`.
