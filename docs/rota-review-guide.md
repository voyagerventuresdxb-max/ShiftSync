# Rota stack review guide (#69 → #78 → #84 → #108–#111)

For the owner reviewing the rota PRs before any of them merges. Every statement below comes from the PRs' code, tests and descriptions; nothing here is a plan.

| PR | Branch | Builds on | What it is |
|---|---|---|---|
| #69 | `rebase/rota-v0-on-master` | master | "Golden path rota v0" (#42) replayed onto master: build a week, publish, staff see it, edit by voice, staff see the change |
| #78 | `feat/rota-split-shifts` | #69 | Split shifts: one person, two segments on one day |
| #84 | `feat/split-shift-db-guard` | #78 | The database half of the no-overlap rule, plus roster import |
| #108 | `feat/rota-uncovered-flags` | #84 | Uncovered-shift flags, and a second tap to publish a week that has them |
| #109 | `feat/rota-availability-all` | #84 | Everyone's availability in the builder, in one request |
| #110 | `test/rota-builder-ui` | #84 | Click-through tests for collapse, notes, copy-week and templates (tests only) |
| #111 | `feat/rota-bulk-actions` | #84 | Select several shifts, then assign or delete them together |

#108–#111 each build on #84 independently. Merge order: #69, #78, #84, then #108–#111 in any order.

All seven were refreshed against master `94cd7c9` on 2026-10-05 (merge commits, nothing force-pushed); each PR has a comment listing the conflict resolutions.

## Run 12 refresh (2026-10-06)

All seven branches were refreshed on master `244b67b` (which now includes #124–#131), merge
commits only, nothing force-pushed. Still not merged (owner switch `ROTA = NO`).

What changed on the stack in this refresh:
- **#69 — access matrix after #126.** Master now checks route coverage from the live router; the
  conflict kept that check and this branch's existing route classification (see Known limits below).
- **#69 — voice test data.** Master's offline voice corpus (#125) creates draft shifts; with the
  stack's draft rule a staff caller only sees published shifts, so the corpus now publishes the
  staff caller's own fixture shifts.
- **#69 — golden-path spec.** It records for a moment before stopping the voice command (since
  #125 a silent recording is not sent, and the test browser's fake microphone only beeps now
  and then).
- **Gate on each top branch (#108–#111):** typecheck, lint 0 errors, unit 120–123, server 712–713 with the access matrix (3 skipped), full e2e 95/95, 95/95, 98/98 and 96/96 (`CI=1 --retries=0`); #69, #78 and #84 each: typecheck, lint, unit and server. One load-dependent AI-quota test failed once on #109 while another suite ran on the machine and passed 2/2 alone. Each PR has a comment with its merge commit and results.

### Migrations (all additive)
| Migration | PR | What it does |
|---|---|---|
| `20260925075120_add_rota_leave` | #69 | New `LeaveType` and `RotaLeaveStatus` types, new `rota_leaves` table with its indexes and foreign keys. Nothing existing changes. |
| `20260925123450_add_leave_audit_actions` | #69 | Adds `LEAVE_MARKED` and `LEAVE_REMOVED` to `AuditAction`. |
| `20261003140000_shift_no_overlap_per_user` | #84 | Enables `btree_gist` and adds an exclusion constraint on `shifts` (one person, no overlapping shifts). No column or data change. **It refuses to apply if overlapping shifts already exist** — and migrations run at API start, so that would fail the deploy's health check. Run the read-only detection query in `docs/split-shift-overlap-guard.md` against production before merging #84. |

### 15-minute click-through
Local, with `npm run db:seed:demo` (made-up staff) as in "How to run it" above; two browsers.
1. (2 min) Owner: open next week → it shows as a draft. Staff browser: the draft is invisible.
2. (3 min) Owner: add 11:00–15:00 and 18:00–23:00 for one person on one day → "9.0h total". Try
   14:00–19:00 → refused inside the sheet with the reason.
3. (2 min) Mark Annual Leave on another day for that person, then try a shift there → refused;
   Half Day → allowed.
4. (2 min) Leave one shift unassigned and publish → the first tap warns (#108), the second
   publishes. Staff browser: both segments in Personal Rota, two rows in My Shifts.
5. (2 min) "Select shifts", pick three, **Assign to…** one person where one would overlap → two
   land, one is refused with the reason (#111).
6. (2 min) Mark someone with no shift unavailable → the builder shows the badge on their row (#109).
7. (2 min) Copy last week into an empty week → segments copy, leave doesn't, conflicts listed.

### Known limits (added in run 12)
- A planned tightening of who may read the leave list (to match the other rota reads) is not in the stack yet; it needs an owner decision (run 12 report).

## What changed

### #69: rota v0
- **Drafts are private.** A draft shift is visible only to a manager of its own venue (`server/src/lib/shiftVisibility.ts`): the rota read, My Shifts, voice, swap requests and clock-in all apply it. Staff never see builder or upload controls. Since the 2026-10-05 refresh the week read also follows master's rule: it needs a session of the venue or the venue's kiosk link, and a kiosk screen sees published shifts only.
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

### #108: uncovered shifts
- A header badge ("N uncovered shifts"), "N open" under each day, and the Open shifts row turns to the warning colour.
- Publishing a week with uncovered shifts takes two taps: the first only warns, the second publishes. The confirm resets when the week or the count changes.
- Client only (`src/engine/openShifts.ts`); no schema or API change.

### #109: everyone's availability
- `GET /api/availability?weekStart=` returns every availability mark at the caller's own venue for that week (managers and owners; the venue comes from the session). The builder makes this one call instead of one per person.
- Unavailable and preferred-off badges show for everyone in the grid, including people with no shift yet; the tooltip shows the note.

### #110: builder click-through tests
- `e2e/rota-builder-ui.spec.ts`: collapse and expand a role section, a briefing note from edit to the staff member's rota, copy last week, save and apply a template. No app code.

### #111: bulk actions
- "Select shifts" mode in the builder header, then **Assign to…** (a person, or nobody) or **Delete** (asks once, then deletes).
- Each shift is written on its own through the same calls a single edit uses, so each keeps its own audit row and notification. A refused shift (overlap, leave) doesn't stop the others; the result says how many were refused and why.

## How to run it
1. `git worktree add ../ShiftSync-rota origin/feat/split-shift-db-guard` (contains #69, #78 and #84; use one of #108–#111's branches to see that PR on top).
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
- [ ] (#108) Leave a shift unassigned and publish: the first tap only warns, the second publishes.
- [ ] (#109) Mark someone with no shift unavailable for a day: the builder shows the badge on their row.
- [ ] (#111) "Select shifts", pick three, **Assign to…** one person where one would overlap: two land, one is refused with the reason.

## Known limits (from the PRs)
- Resolved in the 2026-10-05 refresh: the rota golden-path e2e asserts pushes through the e2e push outbox; shift publish takes the publisher from the session only (#69's lines kept where #84 met master's on-behalf change); the upload notice has master's current wording.
- The leave-vs-shift rule is application-level only (a concurrent shift + leave write for the same person and day can both pass); the overlap rule has the database guard.
- Breaks are not subtracted from hour totals. A staff member with only leave (no shifts) in a week sees the empty state. A `breakMinutes`-only edit to a published shift doesn't notify.
- Swap notifications format times in UTC (`swapActions.shiftLabelOf`).
- The touch-target spec doesn't seed leave, so leave chips and the leave sheet aren't measured.
- "Department" sections in the builder are the fixed front-of-house role list (Bartender, Host and Chef fall under "Other"); `/api/my-shifts` doesn't carry the briefing note (#110's audit).
- Not in scope: compliance or overtime logic, staff self-scheduling.

## Screenshots
Captured on 2026-10-05 from the refreshed #84 (master `94cd7c9`) with the demo seed (made-up personas), at 390×844 and 1280×800, in `C:\dev\_autonomous-run-artifacts\demo-screens-run10\` (not committed; the 2026-10-04 set is in `demo-screens\`):
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
| `49-voice-first-use-notice` | The notice before a person's first voice recording on a device |
| `50-voice-confirm-sheet` | Voice confirm sheet (transcription and intent faked) |
| `60-staff-home`, `61-staff-my-shifts` | Staff Home and My Shifts |
| `70`–`73-join-*` | Staff join: the link, phone and code, waiting for approval, "You're in" |

In full-page captures the floating bottom bar appears mid-page; that is the capture method, not the layout.
