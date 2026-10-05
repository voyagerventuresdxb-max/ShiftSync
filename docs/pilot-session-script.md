# Pilot session script

A 45-minute session with one venue manager: a 5-minute demo, tasks they try alone, then an
interview. Uses only features on `master`. For the technical setup on phones (Wi-Fi, ports,
iPhone and Android details), see [`pilot-checklist.md`](pilot-checklist.md).

**Never use production, real staff names or real phone numbers.** The demo database and every
name in it are made up.

## 1. Setup checklist (the day before)

- [ ] **Demo database**, local or a dedicated demo database, never production:
  `npm run db:setup`, then `npm run db:seed:demo -- --phones=<owner>,<staff>,<applicant>`.
  Use three test numbers you control. The seed refuses any database that isn't local. It creates
  a venue with made-up staff, this week published, an announcement, a shoutout and one pending
  join request.
- [ ] **Sign-in codes on screen:** put the same three numbers in `ECHO_ALLOWED_PHONES`, with
  `ALLOW_DEV_OTP_ECHO=true`, in your **local** `.env` only.
- [ ] **Start it:** `npm run dev:all`. Open the app once on each phone
  ([`pilot-checklist.md`](pilot-checklist.md) step 3).
- [ ] **Devices:** phone M (manager, signs in as the seeded owner), phone S (staff), a laptop for
  notes. A third phone for the applicant is optional. One iPhone and one Android if you can.
  All charged.
- [ ] **Roster files with made-up names:** `server/eval/roster/corpus/grid-western.xlsx` (reads
  cleanly) and `server/eval/roster/corpus/header-weekday-mismatch.xlsx` (shows a flagged row).
- [ ] **People added during the session** get made-up names only, such as "Test Person 1".
- [ ] **Voice:** only if your local API has its own Gemini key. Otherwise skip the voice task.
- [ ] **Roles:** one person runs the session, one takes notes. Print §3 and §5.
- [ ] **Consent:** tell the manager what you note down. Record the screen only if they agree.

## 2. The 5-minute demo

Adapted from the demo in [`mvp-status.md`](mvp-status.md).

| Time | Phone | Do | Point out |
|---|---|---|---|
| 0:00 | M | Sign in with the owner number. | Home: announcements, shoutouts, cover approvals, anonymous floor feedback. (screenshot: 10-manager-home-390.png) |
| 0:45 | M | Scheduling → **Weekly rota builder**. Tap a shift, change the end time, **Save shift**. | The badge moves from **Published · locked** to **Unpublished changes**. Tap **Publish changes**. |
| 1:45 | S | Sign in with the staff number. | My Shifts shows the new time, in venue time. (screenshot: 61-staff-my-shifts-390.png) |
| 2:30 | M | People → **Pending Approvals** → **Approve**. | The new person appears in the Staff Directory. Show the **Join link** and its QR code. (screenshot: 40-people-pending-approval-390.png) |
| 3:15 | M | **Floor plan**: drag a staff chip onto a section for tonight. | Sections and daily assignment. (screenshot: 30-floor-plan-390.png) |
| 4:00 | M | Home → **Announcements** → **Post** → **Broadcast**. | Phone S shows it when the app comes back into focus. |
| 4:30 | M | Scheduling → **Upload Roster** → `grid-western.xlsx`. | The review preview appears in seconds. Nothing is saved until **Confirm & Commit**. |

## 3. Tasks they try alone (15 minutes)

Hand over phone M. Read each task aloud. Don't help unless they are stuck for 2 minutes.

1. "Find out who works tomorrow evening."
2. "Add a shift for tomorrow, and make sure the team knows."
3. "A new waiter wants to join. Get them into ShiftSync."
4. "Upload this roster." (`header-weekday-mismatch.xlsx`)
5. "Tell the whole team that Friday brunch is fully booked."
6. "A staff member asked for cover. Decide it." (Create one first on phone S: Scheduling →
   Personal Rota → **Request cover**. Cover requests for a week close Wednesday 17:00 venue
   time. Later in the week, first add the staff member a shift next week, publish it, and
   request cover on that one.)

### Observation checklist

Tick what you see, and write the moment in the findings log (§5).

- [ ] **Roster review flags:** do they understand **Needs Review**? Do they try to edit a row
  in place? (On Scheduling they must fix the file and upload again.) Do they see why **Confirm &
  Commit** stays disabled until every flagged row is marked reviewed?
- [ ] **Publish:** there is no confirm step; one tap publishes and notifies. Did they expect a
  preview? Do they read **Published · locked** correctly? On a locked week the **+** buttons and
  drag are off. Do they find that tapping a shift still lets them change it?
- [ ] **Publish changes:** after an edit, do they notice **Unpublished changes** and publish again?
- [ ] **Two kinds of approval:** new people are on People → **Pending Approvals**; cover
  requests are on Home → **Conflict-Free Approvals**. Do they look in the wrong place?
- [ ] **Join link:** the onboarding Invite step says the join link "lives in Roster", but it is on
  People → **Join link**. Do they look under Scheduling?
- [ ] **Approval gate:** the Invite step says people tap the link "and they're in", but unknown
  numbers wait for approval. Does that surprise them?
- [ ] **Navigation:** do they find the bottom dial's tabs, the My Shifts button and the bell at the
  top, and the round voice button?
- [ ] **AI consent:** if a file goes to the AI reader, do they understand the question before
  **Send to the AI reader**?
- [ ] **Words:** note any word they don't understand ("Team Matrix", "Shoutouts", "86 List").
- [ ] **WhatsApp:** note each moment they reach for WhatsApp instead of the app.
- [ ] **Time:** how long from choosing the file to a committed roster?

## 4. Interview questions

1. Walk me through how you made last week's rota. Which tools, how long, who checked it?
2. How do your staff find out their shifts today? What goes wrong?
3. When someone can't work a shift, what happens, step by step?
4. When you tapped Publish, what did you expect to happen?
5. On the roster review screen, was anything unclear? Which row would you check first?
6. Who else at your venue would use this? Who should approve new staff?
7. Would your staff join from a link on WhatsApp? What would stop them?
8. How do you feel about a roster photo being read by an AI service outside the UAE?
9. What would you stop using to make room for ShiftSync?
10. What one change would make you use it next week?

## 5. Findings log template

Severity: **1** blocked (could not finish), **2** needed help, **3** hesitated, **4** idea or
wish. No real names or numbers in quotes; write "[staff member]" instead.

| Time | Screen | What happened | Quote | Severity | Follow-up |
|---|---|---|---|---|---|
| 0:00 | | | | | |
| | | | | | |
| | | | | | |

## 6. After the session

- Reset the demo for the next session: run the same `npm run db:seed:demo -- --phones=…` again.
  It resets this week's demo shifts and the pending join request. Uploaded rosters and people
  added during the session stay.
- Turn each severity 1 and 2 finding into an issue, and link the findings log.
- Screenshots are referenced by file name only; they were taken from a branch with unmerged rota
  work, so small wording differences from `master` are expected.
