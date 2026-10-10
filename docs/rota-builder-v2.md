# Rota builder v2 — the week model

The roster is one document per (venue, Monday): `shifts` + `rota_leaves`,
versioned by `rota_weeks.version`. Every write presents the version it last
saw and gets the new one back; every reader refetches on a bump. The contract
both sides share is `shared/rotaWeek.ts`; the server side is
`server/src/lib/actions/weekActions.ts` and `server/src/routes/weeks.ts`.

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
* `PUBLISHED` — after a publish; visible to staff and kiosk.
* `CANCELLED` — a **published** shift the manager deleted. It is hidden from
  every list (managers included) but kept so the next publish can tell the
  person their shift was removed; `publishWeek` then hard-deletes it. Deleting
  a `DRAFT` shift removes the row at once.
* `edited_since_publish` — set when a published shift is changed (the gold dot).

Trade-off, on purpose: a published shift is edited in place, so staff see the
new version immediately rather than after the next publish. Holding the old
version for staff would need a second table of pending versions; instead the
publish diff compares the live rows against `published_snapshot`, which still
holds what staff were last **told**, and the publish notice names the change.

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
| `past_day` | The venue-local day has passed. Source `import` is exempt (backfill). |
| `unknown_shift` / `unknown_person` / `unknown_role` / `unknown_shift_type` | Not at this venue, cancelled, deactivated or archived. `unknown_role` also covers a department not at the venue. |
| `bad_ranges` | Not 1–2 well-formed HH:MM ranges, or neither `shiftTypeId` nor `ranges` given on a create. |
| `bad_leave_type` | `setLeave.type` is not a `LeaveTypeCode`. |
| `note_too_long` | `note` > 80 characters. |
| `already_has_shift` | The person already has a live shift that day. |
| `overlap` | The instants overlap another shift of that person (a cross-midnight shift against the next day's). |
| `person_on_leave` | A blocking leave (Annual, Sick, Unpaid) is on that person-day. A Day off / Half day gives way: it is removed (`LEAVE_REMOVED`) and the shift lands. |
| `pending_request` | A PENDING time-off request covers that person-day and `overridePendingRequests` is not set. With it, the request is `DECLINED` (`reviewedById` = actor, note "Declined by scheduling") in the same transaction and listed in `declinedRequestIds`. |
| `leave_over_shift` | `setLeave` on a day the person has a live shift, whatever the leave type. |

Side effects of an op:

* create → `DRAFT`, `created_by_id` = actor, department defaults to the role's, ranges frozen from the type (or custom).
* update → who/when/what; a published shift gets `edited_since_publish`. Changing the person or the day deletes the old person-day's `section_assignments` (floor sections follow the shift).
* delete → draft: hard delete; published: `CANCELLED` (see above). Section assignments cleared either way.
* setLeave / clearLeave → upsert / delete `rota_leaves`. Clearing a leave that came from an approved request does not reopen the request.
* Audit: one row per op (`SHIFT_CREATED` / `SHIFT_UPDATED` / `SHIFT_DELETED` / `LEAVE_MARKED` / `LEAVE_REMOVED`, `TIME_OFF_DECLINED` on override) whose note starts with `[<source>]`, plus one `WEEK_PATCHED` row per batch.

Sources: `grid` (the week grid and the legacy `routes/shifts.ts` routes),
`voice`, `template` (`rotaActions.applyRotaTemplate`), `import`
(`parsing/persistShifts.ts`), `swap` (`swapActions.decideSwapRequest`),
`timeOff`, `bulk` (`POST /api/shifts/bulk`, one patch per distinct week).

### Legacy callers

`POST/PATCH/DELETE /api/shifts` and `POST /api/shifts/bulk` build one-op
patches with no `expectedVersion` (logged once as a warning) and keep their
old response shapes; `breakMinutes`/`briefingNote`/`sidework` are outside the
week document and are written directly after the patch. Refusals map to the
statuses that client already handles: unknown ids → 404, a collision with a
shift / leave / pending request → 409, anything else → 422.

`POST /api/shifts/:locationId/publish` (and voice `PUBLISH_ROTA`) still run the
legacy `publishRota`, which now also writes the v2 snapshot (`snapshotWeek`),
clears `edited_since_publish`, publishes draft leaves and drops `CANCELLED`
rows, so the new grid and the old banner agree. `GET …/publish-status` reads
the week row when there is one.

A swap approval reassigns through the patch inside the request's own status
flip. The cover already working that day → `409 target_has_shift`; on
blocking leave → `409 target_on_leave`. A `SWAP`-type request (the model has
no target-shift column) trades the two people's shifts on the requester's day
when the cover has one — via an open shift, because a person-day holds only
one live shift — and otherwise behaves like a cover.

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

Resolve each pair before re-running `prisma migrate deploy`:

* A genuine split (two non-overlapping shifts the same day) → merge into one
  row: keep the earlier row, set its `end_time` to the later row's, set
  `ranges` to both ranges in order and delete the later row (and move any
  `attendance_logs.shift_id` / `shift_swap_requests.shift_id` to the kept row).
* A duplicate (same times) → delete one.
* A mistake → `UPDATE shifts SET status = 'CANCELLED' WHERE id = …` (the
  index ignores cancelled rows) and let the next publish of that week drop it.

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
npm run server:typecheck
```

To run one file: `node scripts/with-branch-schema.mjs --connection-limit=1 "node --import tsx --test server/src/lib/actions/weekActions.test.ts"`.
