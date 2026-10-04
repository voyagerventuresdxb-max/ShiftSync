# Rota stack review guide (#69 → #78 → #84)

For the owner reviewing the three rota PRs before any of them merges. Every statement below comes from the PRs' code, tests and descriptions; nothing here is a plan.

| PR | Branch | Builds on | What it is |
|---|---|---|---|
| #69 | `rebase/rota-v0-on-master` | master | "Golden path rota v0" (#42) replayed onto master: build a week, publish, staff see it, edit by voice, staff see the change |
| #78 | `feat/rota-split-shifts` | #69 | Split shifts: one person, two segments on one day |
| #84 | `feat/split-shift-db-guard` | #78 | The database half of the no-overlap rule, plus roster import |

All three were refreshed against master on 2026-10-04 (merge commits, nothing force-pushed); each PR has a comment listing the conflict resolutions.

## What changed

### #69: rota v0
- **Drafts are private.** A draft shift is visible only to a manager of its own venue (`server/src/lib/shiftVisibility.ts`): the rota read, My Shifts, voice, swap requests and clock-in all apply it. Staff never see builder or upload controls.
- **Leave on the grid** (`RotaLeave`, `shared/leaveTypes.ts`): Day Off, Annual Leave, Sick Leave, Unpaid Leave block a shift that day (create, edit, bulk, template apply, voice, swap approval: a 409 with the reason; roster upload skips the row). Half Day can sit beside a shift. Leave publishes with the shifts. Staff see only their own published leave; nobody else sees a leave type.
- **Copy last week** (`src/engine/copyWeek.ts`): copies shifts into the shown week as drafts; leave, notes and sidework are not copied; rows blocked by leave, for inactive staff, or already present are skipped and reported.
- **Collapsible role sections** in the builder.
- **Publish:** one transaction stamps shifts and leave, writes the publisher (always the signed-in manager) and one "Schedule updated" per person.
- **Edits after publish:** editing or removing a published shift notifies the person (old → new, in venue time); moving a shift into an unpublished week turns it back into a draft. Published leave changes notify without naming the leave type.
- **Live refresh without websockets** (`src/lib/scheduleRefresh.ts`): refetch on focus, on visibility, on a push click and on an in-app notification click.
- **Phone layout:** builder header wraps, the grid scrolls inside its box with a pinned name column.
- **Migrations (additive):** `20260925075120_add_rota_leave`, `20260925123450_add_leave_audit_actions`.

### #78: split shifts
- Two segments per person per day across builder, copy-week, templates, publish and Personal Rota. No schema change.
- **Overlap is refused** in the shared shift actions (REST, voice, bulk/copy-week, template apply, swap approval): `409`, e.g. "… already works 11:00–15:00 on … — two shifts for one person can't overlap." Segments that only touch (15:00 end, 15:00 start) are allowed; open and cancelled shifts never count; overnight segments do.
- **Builder:** weekly hours per person; "9.0h total" on a split day; a refused save shows its reason inside the shift sheet.
- **Publish digest** lists both segments under one day ("Tue 3 Jun 11:00–15:00 + 18:00–23:00").
- **Personal Rota:** a split day is one card with both segments and summed hours; "Request cover" asks which segment.

### #84: database guard
- **Migration `20261003140000_shift_no_overlap_per_user`** (additive): a Postgres exclusion constraint (`btree_gist`) so two concurrent writes can never both store overlapping shifts for one person. The migration refuses to apply while overlapping pairs already exist. **Run the read-only detection query in `docs/split-shift-overlap-guard.md` against production first.**
- A constraint violation maps to the same `409` as the app-level check.
- **Roster import** now refuses a file that overlaps stored shifts or itself (all or nothing).

## How to run it
1. `git worktree add ../ShiftSync-rota origin/feat/split-shift-db-guard` (the top of the stack contains all three).
2. `npm install`, then `npm run db:setup` (local Docker Postgres, your own branch schema).
3. `npm run db:seed:demo -- --phones=<owner>,<staff>,<applicant>` for a populated venue (made-up staff). Put the three numbers in `ECHO_ALLOWED_PHONES` in your local `.env` to receive codes on screen.
4. `npm run dev:all`, open `http://localhost:5173`, sign in as the owner number.
5. Tests: `npm run test:server` (rota: `rotaLeaves`, `splitShifts`, `shiftOverlapGuard`, `shiftVisibility`, `shiftNotifications`), `npm run test:e2e -- rota-split-shift`.

## Try these
- [ ] As owner, open next week: it shows as a draft. Sign in as staff on a second browser: the draft is invisible.
- [ ] Add a shift 11:00–15:00 and a second 18:00–23:00 for one person on the same day: both show, the day reads "9.0h total". Try 14:00–19:00: refused inside the sheet with the reason.
- [ ] Mark Annual Leave for someone on a day, then try to add them a shift that day: refused. Half Day: allowed.
- [ ] Publish: staff now see both segments in Personal Rota (one card) and My Shifts (two rows); one "Schedule updated" each.
- [ ] Edit a published shift: the person gets "Shift changed" with old and new times; their screen updates when they come back to the app.
- [ ] Copy last week into an empty week: segments copy, leave doesn't, conflicts are listed as skipped.
- [ ] Save the week as a template and apply it to another week; apply it again on top: refused, not doubled.
- [ ] Voice (needs a Gemini key locally): "Move Omar's shift to six till midnight" → confirm sheet → the change lands.

## Known limits (from the PRs)
- The **rota golden-path e2e spec** stops at its own precondition (VAPID keys + local push receiver) because master's e2e config now runs with push off. #99 (now on master) added a push outbox for e2e; switch that spec's two push assertions to it when #69 is refreshed again.
- **#84 conflicts with master's on-behalf fix** in shift publish (Stage B, Run 5): #69 already takes the publisher from the session only, which is stricter; keep #69's lines.
- The leave-vs-shift rule is application-level only (a concurrent shift + leave write for the same person and day can both pass); the overlap rule has the database guard.
- Breaks are not subtracted from hour totals. A staff member with only leave (no shifts) in a week sees the empty state. A `breakMinutes`-only edit to a published shift doesn't notify.
- Swap notifications format times in UTC (`swapActions.shiftLabelOf`).
- The touch-target spec doesn't seed leave, so leave chips and the leave sheet aren't measured.
- The Scheduling upload notice on the stack still has the pre-#93 wording ("Excel/CSV/text-PDF rosters are never sent anywhere"); master's newer copy wins when the stack is refreshed.
- Not in scope: compliance or overtime logic, staff self-scheduling.

## Screenshots
Captured from the top of the stack with the demo seed (made-up personas), at 390×844 and 1280×800, in `C:\dev\_autonomous-run-artifacts\demo-screens\` (not committed):
| File (`-390.png` and `-1280.png`) | Shows |
|---|---|
| `01`–`05-onboarding-*` | Welcome, Venue, Roster, Review (a synthetic roster), Invite |
| `10-manager-home` | Manager Home |
| `20-rota-published` | This week, published |
| `21-rota-draft-split-shift-leave` | Next week as a draft: a split shift (11:00–15:00 + 18:00–23:00, "9.0h total"), Sick Leave and Annual Leave chips |
| `22-rota-copy-last-week` | The week after, after "Copy last week" |
| `23-rota-save-as-template` | The Save-as-template sheet |
| `30-floor-plan` | Floor plan with section pins |
| `40-people-pending-approval` | People with a pending join request |
| `50-voice-confirm-sheet` | Voice confirm sheet (transcription and intent faked) |
| `60-staff-home`, `61-staff-my-shifts` | Staff Home and My Shifts |
| `70`–`73-join-*` | Staff join: the link, phone and code, waiting for approval, "You're in" |

In full-page captures the floating bottom bar appears mid-page; that is the capture method, not the layout.
