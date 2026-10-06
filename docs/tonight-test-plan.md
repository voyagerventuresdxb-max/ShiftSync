# Tonight's production test plan

A 60–90 minute run-through on production with the **owner phone** (O) and, optionally, a
**staff phone** (S). It follows [`owner-todo.md`](owner-todo.md) items 1–6 and uses
[`voice-test-script.md`](voice-test-script.md) for voice; this page adds the order, timings,
screenshots, a findings log and what to check first when something misbehaves.

Use made-up names for everything you type (staff, roster photo, announcements). Production
has no SMS: a sign-in code is shown on screen only for numbers in the production echo allowlist.

## Before you start (5 min)

- [ ] Both phones charged, on mobile data or a Wi-Fi without a captive portal.
- [ ] Railway → `shiftsync-api` → Variables: the numbers you'll sign in with are in
  `ECHO_ALLOWED_PHONES` (look; don't change anything tonight unless you decide to redeploy).
- [ ] On O, open `https://shiftsync-api-production.up.railway.app/api/health` → `{"ok":true}`.
- [ ] Copy the findings log below somewhere you can type into (a copy is also in
  `C:\dev\_autonomous-run-artifacts\tonight-findings-log.md`).
- [ ] Screenshots: take them with the address bar visible when an error shows.

## Order and timings

| Block | Minutes | What | Steps |
|---|---|---|---|
| 1 | 5 | Web address opens without a Vercel login | owner-todo 1 |
| 2 | 10 | Owner sign-up and onboarding | owner-todo 2, steps 2.1–2.5 below |
| 3 | 5 | Test AI connection | owner-todo 3 |
| 4 | 10–15 | Roster photo | owner-todo 4, steps 4.1–4.4 |
| 5 | 10 | Staff phone: sign-in and the published week (optional) | steps 5.1–5.4 |
| 6 | 20–30 | Voice | `voice-test-script.md` |
| 7 | 5 | Kiosk link (optional) | step 7.1 |
| 8 | 5 | Billing and wrap-up | owner-todo 6, step 8.1 |

## Steps

| # | Phone | Do | Expect | Screenshot |
|---|---|---|---|---|
| 1.1 | O | Open `https://shift-sync-two-ashy.vercel.app` (not signed in to Vercel) | ShiftSync's Welcome screen, no Vercel login | yes |
| 2.1 | O | Welcome → **Account**: your number → **Send code** | The code appears on screen under the field | yes |
| 2.2 | O | Code, your name, venue name → **Verify & continue** | **Venue** step | — |
| 2.3 | O | Venue: name, location, type, two sections (e.g. Bar, Terrace) | **Roster** step | yes |
| 2.4 | O | Roster: **Skip for now** (the photo test comes in block 4) | Straight to **Invite** | — |
| 2.5 | O | **Invite** → **Finish setup** | Home, signed in as owner | yes |
| 3.1 | O | Profile → **AI connection** → **Test AI connection** | Two lines, both *Working*, Vertex AI `eu`, a few hundred to a few thousand ms | yes |
| 4.1 | O | Scheduling → **Upload Roster** → a photo of a printed roster with made-up names | A consent message before anything is sent | yes |
| 4.2 | O | Agree | The review screen with the shifts read from the photo | yes |
| 4.3 | O | Check names, days, times against the paper; fix flagged rows | Matches, or note each miss in the log | yes, per miss |
| 4.4 | O | **Confirm & Commit** | Shifts appear in Scheduling for that week | yes |
| 5.1 | O | People → Staff Directory → add a staff member with S's number → **Send login link** → share to S | A link to share | — |
| 5.2 | S | Open the link | Signed in as staff: a one-time "You're in" screen, then My Shifts | yes |
| 5.3 | O | Scheduling → add a shift for that staff member this week → **Publish & notify** | "Published" | — |
| 5.4 | S | Reopen My Shifts | The new shift in venue time; Home shows the next shift | yes |
| 6.x | O / S | Follow `voice-test-script.md`: first tap shows **Before you use voice** → **Use voice**. Tonight at least: on O `QUERY_MY_SCHEDULE`, `CREATE_SHIFT`, `PUBLISH_ROTA`, `POST_ANNOUNCEMENT`, one `UNRECOGNIZED`; on S `MARK_AVAILABILITY`, `REQUEST_SWAP`, and a manager phrase (must be refused). Each in the plain and the spoken form | Each confirm sheet as the script says; nothing changes until **Confirm** | each wrong sheet |
| 7.1 | O | People → **Kiosk link** → create → open it on S | This week's published rota, announcements, shoutouts; no sign-in | yes |
| 8.1 | O | Google Cloud → Billing → Reports for the AI project; Budgets & alerts | The USD 5 alert exists. Charges can lag by hours; look again tomorrow | yes |

Running total of AI use tonight: the self-test is 2 tiny calls, each roster photo 1–2 calls, each
voice command 2 calls. The in-app cap stops everything at USD 5 a month whatever happens.

## Findings log

| # | Time | Phone | Step | What I did | What I expected | What happened | Screenshot | Severity (blocker / annoying / cosmetic) |
|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | |
| 2 | | | | | | | | |
| 3 | | | | | | | | |

## When something misbehaves: check in this order

**Sign-in**
1. A Vercel login page instead of ShiftSync → Deployment Protection (owner-todo 1).
2. **Send code** works but no code appears → that number isn't in `ECHO_ALLOWED_PHONES`. Use a
   listed number, or a login link from an owner/manager (People → Send login link).
3. "Too many requests" → wait the time it says; resends have a short wait between them.
4. Code refused → request a new one and type it within a few minutes.
5. Anything else → open `/api/health` (above). Not `{"ok":true}`: the API is down; note the
   time; the observer below records it too.

**Roster photo**
1. No consent message before upload → stop and log it (nothing should go to the AI reader
   without it).
2. The message names the cause; match it:
   - "isn't set up on this server" → run Test AI connection (block 3); it will say why.
   - "busy right now" → Google rate limit; try again in a few minutes.
   - "until its AI model setting is updated" → model setting (`VLM_MODEL`), see
     [`vlm-go-live.md`](vlm-go-live.md).
   - "already used this week … available again on <date>" → the venue's 5 reads per 7 days are used.
   - "today's limit" / "paused for this month" → the daily or monthly AI limit.
   - "over the 5MB limit" → a smaller photo.
3. Wrong or missing shifts on the review screen → log each miss with a screenshot of the paper and
   the screen. Nothing is saved until **Confirm & Commit**.

**Voice**
1. No microphone prompt, or "Microphone access was denied" → browser/site microphone permission.
   On iPhone use Safari or the Home-Screen app.
2. The notice shows every time → the browser blocks site storage (private mode).
3. A red banner → match it in `voice-test-script.md` → "'Not set up' and 'limit reached'
   messages".
4. The **You said** line is wrong → transcription (accent, noise, distance): log the phrase and
   what was heard. Right **You said** but the wrong sentence → understanding: log both.
5. Anything changed without **Confirm** → stop testing voice and log it as a blocker.

**Test AI connection**
- *Not working — isn't set up* → `GEMINI_VERTEX_PROJECT` missing on Railway.
- *credentials can't be read* → `GOOGLE_SERVICE_ACCOUNT_JSON` is not the whole key file.
- *Google refused the server's credentials* → the service account lacks Vertex AI User, the
  Vertex AI API is off, or billing isn't linked ([`vlm-go-live.md`](vlm-go-live.md) §1, §3).
- *model isn't available* → model or region setting.
- *today's / this month's limit* → the in-app limits; nothing was sent.
- *Google didn't answer* → try again in a few minutes.
- "Too many requests" → 3 tests per 5 minutes.

**Billing**
- No charges yet → normal; Google's reports lag by hours.
- More than expected → the in-app cap still stops at USD 5; to switch AI off at once see
  [`runbook-incidents.md`](runbook-incidents.md) §5 (that needs a deploy).

## In the background tonight

A read-only health observer polls production every 5 minutes until 03:00 Dubai and summarises
the API logs every 15 minutes (counts only). It changes nothing in production.
