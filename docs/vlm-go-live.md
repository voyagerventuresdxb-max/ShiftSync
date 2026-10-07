# Roster vision go-live (Vertex AI)

What turns on AI reading of roster **photos and scanned PDFs** in production, in the order to do
it. Spreadsheets and text PDFs never need this: the deterministic parsers read them first, and
they keep working whether or not vision is on.

Until these steps are done, production has no vision credentials: an image upload answers a
clear 422 ("AI roster reading isn't set up on this server. Upload an Excel/CSV export instead.")
and never shows invented data.

Never paste a key, key file or any part of one into chat, a PR, an issue, a commit or a log.

## 0. What the code expects (checked 2026-10-04)

| Setting | Default | Source |
|---|---|---|
| `VLM_MODEL` | `gemini-3.6-flash` | GA on the Gemini API and Vertex AI; no shutdown date announced ([models](https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash), [Vertex model page](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-6-flash), [deprecations](https://ai.google.dev/gemini-api/docs/deprecations)). Vertex lists `gemini-3.8-flash` as its eventual replacement, with at least 45 days' notice ([model versions](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions)). |
| `VLM_FALLBACK_MODEL` | `gemini-3.5-flash-lite` | GA; Vertex retirement "July 21, 2027 or later" ([model versions](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions)). |
| `GEMINI_VERTEX_LOCATION` | `eu` | Both models are offered on Vertex only on the `global` endpoint and the `us` / `eu` **multi-regions** — not in any single region, `europe-west4` included ([locations](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/locations)). `eu` keeps model processing inside the EU. `@google/genai` 2.17.1 sends `eu` to `https://aiplatform.eu.rep.googleapis.com/` (checked in the installed SDK). |

- Gemini **2.5** models retire on Vertex on **2026-10-20** ([model versions](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions)). Don't set any `gemini-2.5-*` ID.
- If Google retires a model anyway, the server logs `[vision] MODEL NOT AVAILABLE: … model "<id>" …`, tries the fallback model, and if every model is gone the manager sees "AI roster reading is unavailable on this server until its AI model setting is updated…". Fix by setting `VLM_MODEL` / `VLM_FALLBACK_MODEL` and redeploying.
- The API itself runs in Railway region `sfo` (US West). Vertex `eu` pins where the model processes the image; the request passes through the US-hosted API on its way.

## 1. Google Cloud: project and billing

1. https://console.cloud.google.com → project picker → **New project** (e.g. `shiftsync-prod`), or pick the existing one. Note its **project ID** (not the name).
2. **Billing** → link the project to a billing account.
3. **APIs & Services → Library** → search **Vertex AI API** → **Enable**.

## 2. Spending: the in-app cap is the hard stop

**The hard stop is inside the app, not in Google Cloud.** Every Gemini / Vertex call the API makes
(roster vision, voice transcription, voice intent, and `vlm:check`) first reserves its worst-case
cost against a monthly budget and a daily call count for its feature kept in the database
(`server/src/lib/aiBudget.ts`). If the call could cross a limit, nothing is sent to Google and
the manager sees "AI reading is paused for this month; upload Excel/CSV or add staff manually."
(or "…has reached today's limit and is back tomorrow…" for the daily count).
Spreadsheets, text PDFs and manual entry keep working. If the counters can't be reached, AI calls
are refused too (fail closed).

Voice uses the same Vertex project, region and credentials as vision (only `VOICE_MODEL` is its own),
so the steps below turn on both.

| Variable | Default | Meaning |
|---|---|---|
| `AI_MONTHLY_BUDGET_USD` | `5` | Estimated spend per UTC calendar month, all venues and features together. |
| `AI_VISION_DAILY_CALL_LIMIT` | `60` | Roster-vision model calls per UTC day, all venues together. |
| `AI_VOICE_DAILY_CALL_LIMIT` | `200` | Voice model calls per UTC day, all venues together (two per command). |
| `AI_DAILY_CALL_LIMIT` | `150` | Ceiling on all AI calls per UTC day; `0` switches AI off. |
| `AI_VOICE_USER_DAILY_LIMIT` / `AI_VOICE_VENUE_DAILY_LIMIT` | `40` / `100` | Voice calls per UTC day for one person / one venue. |
| `AI_VISION_USER_DAILY_LIMIT` / `AI_VISION_VENUE_DAILY_LIMIT` | `10` / `20` | Roster-reading calls per UTC day for one person / one venue. |
| `AI_PRICE_IN_PER_M` / `AI_PRICE_OUT_PER_M` | `3` / `15` | USD per 1M input / output tokens used for the estimate. At or above the highest price Google lists for these models (checked 2026-10-04), so the estimate runs high, never low. |

The API logs `[ai-budget] WARNING: estimated AI spend for <month> has reached 80% …` once a month
when the estimate passes 80 %. The owner can see the cap's state at `GET /api/ai/usage`
(month-to-date estimate, limit, calls today in total and for vision and voice, and their limits).

The steps below are a second line, in Google Cloud:

1. **Budget alert at USD 5.** **Billing → Budgets & alerts → Create budget.** Scope: this project
   only. Amount: **USD 5** per month. Alert thresholds: **50 %, 90 %, 100 %** of actual spend,
   emailed to you. **A budget alert only sends an email; it does not stop spending.** Google's billing
   data also lags by hours, so the email can arrive after the money is spent.
2. **Lower the Vertex quotas.** **IAM & Admin → Quotas & System Limits** → filter *Service: Vertex AI
   API* → find the generate-content requests-per-minute quota for each model (`gemini-3.6-flash` and
   `gemini-3.5-flash-lite`) in location `eu` → **Edit quotas** → set a low value (e.g. 10 per minute)
   → submit. The exact quota names in that list were not verified while writing this; pick the
   per-minute generate-content quota for each model in `eu`. A quota limits the **rate**, not the
   monthly total.
3. The app's other limits still apply (`server/src/routes/schedules.ts`): AI reading takes files up
   to 5 MB and runs at most **`AI_VISION_WEEKLY_LIMIT` times per venue in any 7 days** (default 1;
   each successful read counts for 7 days; `0` switches AI roster reading off), plus the general
   roster-upload rate limiter.

## 3. Service account with Vertex AI User only

1. **IAM & Admin → Service Accounts → Create service account.** Name `shiftsync-vision`. No other description needed.
2. **Grant access:** role **Vertex AI User** (`roles/aiplatform.user`). Nothing else — not Editor, not Owner. Done.
3. Open the account → **Keys → Add key → Create new key → JSON**. A `.json` file downloads. This file **is** the secret.
   - If key creation is blocked ("disabled by organization policy"), an org admin has to allow it for this project first.

## 4. Set the variables by hand in Railway

In the Railway dashboard → project `shiftsync` → environment `production` → service `shiftsync-api` → **Variables**:

| Variable | Value |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | open the downloaded `.json` in a text editor, copy **all** of it, paste as the value (the raw editor keeps it on one variable) |
| `GEMINI_VERTEX_PROJECT` | the project ID from step 1 |
| `GEMINI_VERTEX_LOCATION` | leave unset (default `eu`) |

Then delete the downloaded `.json` from your Downloads folder and empty the bin. Railway stages the
change; don't deploy it from the banner — use step 5.

Leave `VLM_MODEL`, `VLM_FALLBACK_MODEL` unset unless you need to change the defaults.

## 5. Deploy, then check it inside the service

`vlm:check` goes through the spend cap like every other call, so it must reach production's
database to record its one call (token counts and estimated cost only). Production's database is
on Railway's private network, so a `railway run npm run vlm:check` from your laptop can't reach it
and always ends `FAIL (paused)` with an `[ai-budget] spend ledger unreachable` line — the cap
failing closed, not a credentials problem. Run it inside the service instead:

1. Deploy the API the documented way ([`railway-deploy-procedure.md`](railway-deploy-procedure.md) §2: `railway redeploy --from-source`, never `railway up`), so the new variables are live. In the deploy log there must be **no** `[vision] … client setup failed` line.
2. Open a shell in the running service and run the check there. `railway ssh` needs an SSH key on
   your Railway account (Account settings → SSH keys). The check prints no credential material.

   ```powershell
   cd C:\dev\ShiftSync-deploy
   npx -y @railway/cli@5.63.1 ssh
   # then, inside the service:
   npm run vlm:check
   ```

   Without an SSH key, skip this step: the photo test in §6 exercises the same provider through
   the same cap.

   Expect: `provider=vertex-gemini model=gemini-3.6-flash … region=eu`, then
   `answered by model=… in …ms; tokens in/out=…; shift rows read=4 (expected 4)` and
   `RESULT: PASS`. Exit codes: 0 pass, 1 fail, 2 not configured.
   - `FAIL (credentials)…` → the pasted JSON is incomplete; re-paste the whole file.
   - `FAIL (failed, HTTP 403)` → the service account lacks **Vertex AI User**, or the API isn't enabled.
   - `FAIL (model_unavailable)` → a model/location mismatch; check `GEMINI_VERTEX_LOCATION` is unset or `eu`.
   - `FAIL (busy, HTTP 429)` → the quota from step 2 is too low or exhausted; wait a minute.
   - `FAIL (paused)` → the in-app cap refused the call before anything was sent: the month's budget
     or today's call limit is reached, or (with an `[ai-budget] spend ledger unreachable` line) the
     database couldn't be reached — you ran it outside the service.
   - Do **not** run it through `node scripts/with-branch-schema.mjs` against production: that
     wrapper is for dev worktrees and would point production's connection at a dev schema.

**In the app instead (no laptop):** sign in as the venue **owner** → **Profile** → **AI connection** →
**Test AI connection**. It sends one tiny image call (roster reading) and one tiny audio call
(voice) on the production setup, through the spend cap, and shows per feature: *Working — model
(Vertex AI, region), N ms*, or *Not working —* a plain reason (not set up, credentials unreadable,
access refused, model unavailable, today's / this month's limit reached, Google not answering).
It never shows a key, project id or provider message. Owners only; 3 runs per 5 minutes.

## 6. Photo-roster test on a phone

1. On a phone, sign in as a manager of a **test venue** (AI reading is limited to `AI_VISION_WEEKLY_LIMIT` reads per venue in any 7 days, so don't spend a real venue's allowance). Open **Scheduling** → the roster upload panel. It states that image and scanned-PDF rosters are read by a third-party AI service outside the UAE.
2. Take a photo of a printed roster with **made-up names** (or the sample image from `server/scripts/fixtures/vlm-check-roster.png` shown on another screen).
3. The **review screen** must show the shifts read from the photo; nothing is saved until you confirm.
4. Railway logs for that request: `[parseVision] image/PDF read by vertex-gemini model=… — … chars, tokens in/out=…/…, N shifts`. The log carries counts only, never the names.

## 7. Turning it off, rotating the key

- **Off:** delete `GEMINI_VERTEX_PROJECT` (and `GOOGLE_SERVICE_ACCOUNT_JSON`) in Railway, redeploy. Image uploads go back to the clear 422; spreadsheets are unaffected.
- **Rotate:** in Google Cloud, create a new JSON key for `shiftsync-vision`, replace the Railway value, redeploy, run `vlm:check`, then delete the old key under **Keys**.

## Voice: exactly what is sent to the model, and who decides what it means

Both voice calls send the same bounded spelling hint and nothing else from the venue. The hint is
built by `buildVocabularyHint` (`server/src/voice/transcribe.ts`, loaded by `venueSpellingHint` in
`server/src/voice/context.ts`) from the caller's **own venue only**: the display names of its
**active** team members, its section names, and six fixed scheduling words. Any term that looks like
contact data (an `@`, or six or more digits) is dropped even if it was typed into a name; the list is
de-duplicated and capped at 150 terms and 4,000 characters. The model is told to use it only to spell
words that were actually said.

- **Transcription** (`POST /api/voice/transcribe`) sends the audio and the spelling hint.
- **Intent** (`POST /api/voice/parse-intent`) sends the transcript (as the user turn) and a system
  prompt (`server/src/voice/prompts.ts`) holding only: the caller's account role; the venue's today
  and a 14-day weekday calendar (dates, no records); the tools that role may use (staff: their own
  availability, swaps, time off and the reads; managers and owners: every tool), plus DECLINED and
  UNRECOGNIZED; the rules for names, times and code-mixed words; and the spelling hint.
- **Never sent:** ids of any kind, phone numbers, email addresses, applicants (join requests), shifts,
  swap requests, templates, role names, announcements or shout-outs, inactive staff, or anything from
  another venue. `server/eval/voice/voiceTools.test.ts` checks the prompt for every one of these.

The model answers with **one tool and the words as heard** (`{ tool, args, confidence, summary }`):
a name as said ("Omar"), a section or role as said ("the bar"), a day from the calendar, a time
exactly as said ("6", "6pm", "half past six"). It never returns ids. The server
(`server/src/voice/tools.ts`) looks everything up in the caller's venue:

- **People:** `server/src/voice/people.ts` settles on one person only when exactly one fits strongly
  (exact name, spelling variants such as Yousef/Yusuf, short forms such as Jim/James, then
  sound-alike names). Two or more fit: "Which one?" with each person's role. Close names: "did you
  mean". Nothing close: the caller picks from their team. Nobody is ever created from a voice command.
- **Sections, roles and service words** ("closing", "lunch", Tagalog "gabi", Hindi "subah") are
  checked against the venue's own lists the same way (`vocabulary.ts`).
- **Shifts** are found by person, day and (if said) time; **swap requests** by requester and/or day;
  **applicants** by name among pending join requests; **templates** by name.
- **Times** are read on the server (`times.ts`). "6pm to 2" is 18:00–02:00. "18:30 to 1" is
  18:30–01:00. "6 to 2" could be 06:00–14:00 or 18:00–02:00, so the caller is asked, with the evening
  reading first, unless they said "tonight", "evening", "lunch" or similar. "Closing", "opening" and
  "a double" come from the venue's own templates and upcoming shifts, or are asked for.

**Reads** (who is working, who is in a section, pending requests, recent announcements and
shout-outs, my schedule) are answered by the server from the venue's records after the model call.
The model never sees the results, and stored text is returned as plain data. Staff see only
published shifts and section assignments, and only their own requests.

**Changes** still need the caller's Confirm. The confirm sheet spells out the full name, role, day,
date and times, and `/execute` re-checks everything before writing: the role, the venue of every id,
active role and person, real dates, no past days, and no overlaps. It has its own rate limit, and a
retried Confirm for the same command runs once.

## Cost

`vlm:check` and every production read log the input/output token counts, and the spend cap keeps a
per-venue monthly ledger (`ai_usage`: calls, tokens, estimated USD; no content). The estimate uses
`AI_PRICE_IN_PER_M` / `AI_PRICE_OUT_PER_M` (defaults 3 / 15), set deliberately above Google's listed
prices. Prices checked on 2026-10-04 on Google's
[Vertex AI pricing page](https://cloud.google.com/vertex-ai/generative-ai/pricing), per 1M tokens:

| Model | Input | Output |
|---|---|---|
| Gemini 3.6 Flash, global endpoint, standard, until 2026-12-31 | $0.75 | $3.75 |
| Gemini 3.6 Flash, global endpoint, standard, from 2027-01-01 | $1.50 | $7.50 |
| Gemini 3.6 Flash, regional / multi-region endpoints (`eu`) | +10 % on the above | +10 % |
| Gemini 3.6 Flash, Priority tier, regional, from 2027-01-01 (highest listed) | $2.97 | $14.85 |
| Gemini 3.5 Flash-Lite, global endpoint | $0.30 | $2.50 |

"Thinking" tokens are billed as output. Every call asks for the lowest thinking level (`minimal`)
and has a per-feature output ceiling (roster vision 16,384, voice transcription 1,024, voice intent
2,048 tokens). Re-check the pricing page before raising the budget; if Google raises prices above
the defaults, raise `AI_PRICE_IN_PER_M` / `AI_PRICE_OUT_PER_M` to match.
