# Pilot checklist — a manager demo on a real phone

For a 20-minute walkthrough with a venue manager, on their phone and yours, against a local or
dedicated demo database (never production). Two phones: **M** (you, the manager/owner) and **S**
(a staff member — a second phone, or a colleague's).

## Before the day

1. **Database and seed (laptop).** Local Postgres up (`npm run db:setup`), then seed the demo venue
   with the three numbers you will use (owner, staff, applicant):
   ```bash
   npm run db:seed:demo -- --phones=<owner mobile>,<staff mobile>,<applicant mobile>
   ```
   It refuses to run against anything but `localhost` / `127.0.0.1`. Re-run any time to reset this
   week's rota.
2. **Sign-in codes.** There is no SMS yet (#51): codes are shown on screen only for numbers in
   `ECHO_ALLOWED_PHONES`, with `ALLOW_DEV_OTP_ECHO=true`. Put the same three numbers there.
3. **Reach the laptop from the phones.** Both phones on the laptop's Wi-Fi; API on `:4000`, web on
   `:5173` bound to the LAN (`npm run dev:all -- --host` for Vite, or a tunnel). Open the web URL on
   each phone once and confirm the login screen renders.
4. **Optional, Android app:** install the debug APK from the `Android debug APK` workflow run
   (built against your API origin) on M. Voice needs the microphone prompt accepted.
5. **Charge both phones.** Turn off the venue Wi-Fi's captive portal if it has one.

## The walkthrough (M = manager phone, S = staff phone)

| # | Where | Do | Expect |
|---|---|---|---|
| 1 | M `/login` | Enter the owner number → Send code → enter the shown code | Lands on Home: announcement, shoutout, "Conflict-Free Approvals" |
| 2 | M Scheduling | Open the Weekly rota builder | This week, Monday to Sunday, labelled with month and year; 7 people, split and overnight shifts visible |
| 3 | M Scheduling | Tap "Add shift on <tomorrow>", pick a role and times, save | Chip appears on the right day; status says "Unpublished changes" |
| 4 | M Scheduling | Publish | "Published"; the staff phone gets the notification (if push is on) |
| 5 | S `/login?as=staff` | Enter the staff number → code | "Staff sign in" wording, no venue-setup links; lands on My Shifts with venue times |
| 6 | S My Shifts | Scroll | This week's shifts, "Your next shifts", availability strip for the current week |
| 7 | M People → Pending Approvals | Approve "Sara Nour" | Row disappears; the applicant can now sign in |
| 8 | S (or a third phone) `/join?invite=…` | Paste the venue's invite link from People → Invite | "Join <venue> as staff", a phone field, short welcome; no manager wording |
| 9 | Applicant `/login?as=staff` | First sign-in after approval | "You're in" screen, then My Shifts |
| 10 | M People → Staff Directory | Toggle a staffer Inactive, then Active | The staffer's phone is signed out on its next action and lands on `/login` with "You've been signed out." (#80); the owner's own chip refuses |
| 11 | M Home | Tap the microphone, say "Publish this week's rota" | Confirm sheet with the venue week; Confirm executes. On S, say "Approve Omar's request" → "That command needs a manager or owner account." |
| 12 | M Scheduling → Upload | Upload an Excel/CSV roster export | Preview with venue times; dates read correctly whatever the laptop's timezone (#82) |
| 13 | Either phone | Turn Wi-Fi off, tap Send code / Publish | A message, a disabled button, no endless spinner; works again when Wi-Fi returns |
| 14 | M `/people` → Notification preferences | On an iPhone in Safari | "Add to Home Screen" hint; after installing, the push toggle appears |

## iPhone specifics (Safari)

- Share → Add to Home Screen; the installed app opens full screen with the dark status bar.
- Tap a text field: the page must not zoom (16px controls). The keyboard must not hide the field.
- Voice: the first tap asks for the microphone; a recording goes through (iPhone records `audio/mp4`).
- Push works only from the installed Home-Screen app, and only once VAPID is live (`docs/push-go-live.md`).

## Android specifics

- Debug APK: sign-in, roster file picker, camera capture on the roster step, hardware back, status bar.
- Voice: the system microphone prompt appears on the first tap (RECORD_AUDIO is declared).
- Kill and relaunch the app: still signed in. Settings → Apps → ShiftSync → Storage → Clear: signed out.

## If something goes wrong

- No code shown: the number is not in `ECHO_ALLOWED_PHONES`, or the API is not the one the phone
  reaches (check `/api/health` from the phone's browser).
- "You've been signed out" unexpectedly: the session row was removed (deactivation, sign-out
  elsewhere) — sign in again.
- A 409 on save: the person already works at that time (split-shift rule). Pick another slot.
- Re-seed between demos: `npm run db:seed:demo -- --phones=…` resets this week's demo shifts and the
  pending request; it never touches other venues.
