# Calendar liveness audit (2026-10-03)

Static search of client (`src/`, `shared/`) and server (`server/src/`) for hardcoded dates, literal
`Date` constructors, mock data outside tests and seeds, fixed week-start constants, timezone
assumptions and every screen that shows a date. Classes: **LIVE** (correct, from the real clock in
the right calendar), **SEED** (demo/seed data only), **TEST-ONLY**, **BUG** (wrong or suspicious in
production code). Fixed items are marked ✔ (branch `fix/calendar-liveness`); the rest are findings.

## How dates are stored (the key to everything below)

- `Shift.date` is UTC midnight of the **venue-local** calendar day.
- `Shift.startTime` / `endTime` are real instants, built by `combineDateAndTime(date, "HH:mm",
  Location.timezone)` (`server/src/parsing/normalize.ts`).
- `Location.timezone` defaults to `Asia/Dubai`.
- The client never receives the venue timezone. Every client "today" is the **device's** local
  calendar day; every client "HH:mm" for a shift comes pre-formatted by the server in venue time.
- Every rota week is **Monday to Sunday** (`src/engine/weekStart.ts`, templates store
  Monday-relative offsets, `RotaPublish` is keyed on the Monday).

## Findings

| Where | What | Class | Note |
|---|---|---|---|
| `server/src/lib/venueTime.ts` | `venueToday`, `formatVenueTime`, `venueTimezoneFor` | LIVE | Correct venue "today" / wall-clock. Previously used only by voice. |
| `server/src/lib/actions/swapActions.ts` `shiftLabelOf` | formatted `startTime`/`endTime` with `dayjs.utc` | **BUG ✔** | They are instants, so a 09:00 Dubai shift was labelled "05:00" in the approvals list and in push notifications. Now rendered in the shift's venue timezone. |
| `server/src/routes/schedules.ts` upload + `server/src/parsing/parseText.ts` `currentWeekStart` | default week = **Sunday** of the week in **process-local** time; the client never sends `weekStart` | **BUG ✔** | Every roster without explicit dates was anchored to a Sunday-first week computed on the host clock (UTC on Railway), disagreeing with the Monday weeks the app shows. Now the Monday of the current week in the **venue's** timezone; a client-sent `weekStart` must be a Monday (400 otherwise). |
| `server/src/parsing/deterministicParser.ts`, `parseVision.ts` prompts, `normalize.ts` comment | "Sunday-first" / "(ISO Sunday)" | **BUG ✔** | Column-position mapping and the Gemini prompt assumed a Sunday week start while the rest of the app is Monday-based. Wording fixed; the code already mapped columns from `weekStart`, so a Monday `weekStart` now gives Monday-first columns. |
| `server/src/routes/myShifts.ts` | `today = new Date(); setUTCHours(0)` | **BUG ✔** | UTC date, not the venue day: from 00:00 to 04:00 Dubai yesterday's shifts stayed "upcoming". Now `venueToday`. Also returns `startLabel`/`endLabel` (venue HH:mm). |
| `src/routes/MyShiftsRoute.tsx` | `toLocaleTimeString()` on the instants | **BUG ✔** | Device-zone times, unlike every other screen (venue time). Now shows the server's venue labels; the date shows as "Mon 5 Oct". |
| `server/src/routes/attendance.ts` weekly-hours | week window `[weekStart 00:00Z, +7d)` on clock-in instants | **BUG ✔** | Dubai's Monday 00:00–04:00 clock-ins counted toward the previous week. Now the venue's own Monday midnights (`venueWeekRange`). |
| `server/src/lib/swapRequestPolicy.ts` | `VENUE_TIMEZONE = 'Asia/Dubai'` hardcoded; 17:00:00 exactly returned `now` | **BUG ✔** | Now takes the shift's venue timezone; exactly 17:00 counts as closed and rolls to next week. |
| `shifts.ts` publish, `rotaTemplates.ts` apply, `voice.ts` PUBLISH_ROTA / APPLY_ROTA_TEMPLATE | `weekStart` only checked as a real date | **BUG ✔** | A non-Monday publish created an orphan `RotaPublish` row that no status read ever found, and a non-Monday template apply shifted every shift. All four now answer 400 unless the date is a Monday. |
| `src/routes/SchedulingRoute.tsx` `?week=` sync | re-adopted the stale URL on every Prev/Next click | **BUG ✔** | Prev/Next week snapped straight back (found by the new faked-clock e2e; #69 carries the same fix on its branch). Now `reconcileWeekParam` (unit-tested) with Monday snapping of a shared/bookmarked non-Monday `?week=`. |
| `src/routes/SchedulingRoute.tsx` roster grid | matched shifts to columns by **weekday only** | **BUG ✔** | A committed upload row from another week showed in this week's column. Now matched by date. |
| `src/components/shiftsync/RotaBuilder.tsx` week label | `Mon 05 – Sun 11` (no month, no year) | **BUG ✔** | Unreadable across a month or year end. Now "Mon 28 Sep – Sun 4 Oct 2026" (both years when the week crosses one). |
| `src/state/AppStateContext.tsx` `useState(currentWeekStart())` | computed once at mount | **BUG ✔** | A tab left open past Monday 00:00 (kiosk, phone) kept last week as "this week". An untouched auto-selected week now follows the clock on focus/visibility and every minute; a week the user navigated to never moves. |
| `server/src/parsing/parseVision.ts` `FALLBACK_SAMPLE_RESPONSE` | a fixed fake roster dated 2026-08-17/18 | **BUG (mock data in production)** | In the default `VLM_FALLBACK_MODE=auto`, an image upload returns this sample roster whenever Gemini is unavailable or fails. Deferred to the iPhone/PWA phase, which re-cuts #43's "no sample roster" change. |
| `src/routes/ScheduleEditorRoute.tsx` | opens on Monday, not today; no week navigation | finding | Low; the Scheduling page is the week navigator. |
| `src/components/shiftsync/ApprovalsPanel.tsx` | copy "Requests close Wednesday 17:00 GST" | finding | True for Dubai venues; not derived from the venue timezone. The window is also only stored/shown, not enforced (requests can still be filed after it). **Update 2026-10-04:** enforced server-side (a shift's week closes Wednesday 17:00 venue time; REST and voice answer 409 `swap_window_closed`; managers can still decide filed requests); copy now says "venue time". |
| `src/components/FloorPlan/AssignmentBoard.tsx` `todayIso()` | device-local, once at mount | finding (low) | Same stale-after-midnight shape as the week state; left as is (the board is a manager tool used in the moment). |
| `src/engine/weekStart.ts`, `src/engine/rosterView.ts`, `src/engine/time.ts` | Monday-based, device-local calendar math | LIVE | Device-local is right for a UAE phone. See "Week start" below. |
| `Announcements.tsx`, `Shoutouts.tsx`, `NotificationBell.tsx`, `FloorFeedbackReview.tsx`, `EightySixBoard.tsx`, `StaffDirectory.tsx`, `PendingApprovals.tsx` | `toLocale*` on instants without `timeZone` | LIVE (device zone) | Relative times and timestamps of events, shown in the device zone. Acceptable. |
| `src/engine/parser.ts` `Date.now()` | — | LIVE (dead code) | `parseRosterText` is unused on the client. |
| `src/state/AppStateContext.tsx` `config` (`Demo Venue`, `knownStaff`) | placeholder | SEED (inert) | Name and staff are never shown; `compliance.maxWeeklyHours` (48) is used live and is not per venue. |
| `server/scripts/run-*.ts` `WEEK_START = '2026-08-24'` | dev scripts | SEED | Not shipped. |
| `server/src/**/*.test.ts`, `e2e/*.spec.ts` | hardcoded 2026 dates | TEST-ONLY | Expected. Two day-of-week-dependent specs fixed: `zero-setup-scheduling.spec.ts` (today+2 fell into next week on a weekend) and `weekStart.test.ts` (00:30Z on a Monday is Sunday west of UTC). |

There is no "copy week" feature; week-to-week reuse is rota templates only.

## Week start is not configurable (finding, not built)

`Location` stores only `timezone`; there is no week-start field. Monday is hardcoded on the client
(`src/engine/weekStart.ts`, `SchedulingRoute.tsx` `DAYS`), in `scheduleNotifications.ts`, in the
voice prompt and in template offsets. The server's parsers used to assume Sunday (fixed above to
Monday). Making it per-venue would touch `RotaPublish` keys, template offsets, the parsers and
every week label, so it is reported here and left for a product decision.

## Tests added

- `server/src/lib/timezoneMatrix.test.ts`: runs `timezoneMatrix.probe.ts` in a child process under
  `TZ=UTC`, `Asia/Dubai` and `America/Los_Angeles` and asserts identical, expected results for the
  venue week start (2026-10-03 10:00, 2026-10-31 23:30 and 2026-12-31 23:30 Dubai; Monday 00:30 Dubai
  as a Dubai and as a Los Angeles venue), the Wednesday window close at 16:59 / 17:00 / 17:01
  Dubai and for a Los Angeles venue, the venue shift label, the venue week range and the Monday check.
- `e2e/calendar-liveness.spec.ts`: faked browser clock (`page.clock`) at the three instants above,
  viewed from Asia/Dubai and America/Los_Angeles: Scheduling shows the week containing the device's
  "now", Next/Previous week crosses the month and the year with the right label and `?week=`, a
  non-Monday `?week=` is snapped, a shift added on "tomorrow" in the rota builder is stored on exactly
  that venue day with a venue-time instant, My Shifts shows venue wall-clock times, and the
  swap-request lock state is the same for both viewers.
- `src/engine/weekMath.test.ts`, `weekStart.test.ts` (`reconcileWeekParam`).
