# Voice test script (real phone)

A script for testing voice commands on a real phone against a real venue. It is generated from the
code, not from memory:

- the intent list and who may use each: `shared/voiceIntents.ts` (`STAFF_INTENTS`, `MANAGER_INTENTS`);
- what the model may answer: `server/src/voice/intentSchema.ts` (response schema) and
  `server/src/voice/prompts.ts` (rules, example confirm sentences);
- the confirm text the server writes itself (publish, templates, low confidence, people it can't
  pin down): `server/src/voice/parseIntent.ts` and `server/src/voice/people.ts`;
- what each confirmed command changes, and every error message: `server/src/routes/voice.ts`,
  `src/components/shiftsync/AppShell.tsx`, `src/components/shiftsync/VoiceCommandSheet.tsx`,
  `src/components/shiftsync/VoicePreview.tsx`.

If any of those files change, regenerate the matching rows.

All names below are made up. Use your own test venue's fake staff, never real people or numbers.

## Before you start

- A test venue with: two fake staff (here **Sam Sample** and **Alex Example**), two more who share
  a first name (here **Karim Saleh** and **Karim Aziz**), nobody called **Rana**, one fake manager,
  roles **Bartender** and **Server**, floor sections **Bar** and **Terrace**, one saved rota template
  **Weekend Standard**, and at least one shift next week. Sam needs an upcoming shift for the swap
  rows; one pending swap request and one pending join request (applicant **Riley Demo**) for the
  approval rows.
- The first mic tap per person on a phone shows **"Before you use voice"** (what is sent to Google,
  that the recording isn't kept). Tap **Use voice**. Test **Not now** once: nothing is recorded or sent.
- One tap starts recording, a second tap stops it; it stops by itself after 10 seconds.
- Every command shows a sheet first: a small label naming the kind of command (e.g. **Shout-out**,
  **New shift**), one sentence saying what will happen, **I heard "…"** (exactly what was heard),
  then a **preview** of the result as the app will show it (a shout-out or announcement as its board
  card, a shift as its rota line, a swap or join as its request line). One big **Confirm**, small
  **Edit** and **Cancel**. Nothing changes until **Confirm**.
- **Edit** turns *I heard* into a text box; fix the words and tap **Try again**: the edited text is
  read again (no new recording), and you get a new sheet. **Back** returns to the preview.
- A low-confidence or unclear command shows **"Didn't catch that"**, a plain sentence and a hint,
  *I heard* already open for editing with **Try again**, and no Confirm. No sheet ever says
  "supported command" or "intent".
- Two requests in one breath ("…and also…"): only the first is confirmed, then the sheet says
  *"I heard something else in there too — what's the next thing you'd like me to do?"*.
- The confirm sentence is written by the model for most intents, so wording varies: check that the
  **meaning** (who, what, which day and time) is right. Rows marked *exact* are written by the server.

## Intents

**Any signed-in role** = staff, manager or owner. **Manager or owner** = a staff account gets the
banner *"That command needs a manager or owner account."* and no confirm sheet.

| Intent | Role needed | Plain phrase | Spoken variation | Expected confirm sheet | Expected result in the app |
|---|---|---|---|---|---|
| `MARK_AVAILABILITY` | Any signed-in role | "Mark me unavailable next Friday." | "Um, can you put me down as, like, not available on Friday next week?" | "Mark you unavailable on Friday, <date>." ("prefer off" phrasing → preferred off) | Green banner with the same sentence. The day shows as unavailable (or preferred off) in that person's My Shifts availability strip, and against their shifts in the manager's rota builder. |
| `REQUEST_SWAP` | Any signed-in role | "Ask Alex to cover my Saturday shift." | "So, uh, I need someone to take my Saturday, can Alex do it?" | "Ask Alex Example to cover your Saturday <time> shift." | A pending swap request appears for managers, and managers get a "New swap request" notification. Only your own upcoming shifts can be offered. After Wednesday 17:00 (venue time) for that week: the swap window is closed and nothing is created. |
| `QUERY_MY_SCHEDULE` | Any signed-in role | "What's my schedule this week?" | "Hey, er, when am I working this weekend?" | Sheet titled **"Your schedule"** with the answer itself, e.g. "You're working Friday 6pm–close and Saturday 2pm–10pm." Only a **Got it** button. | Nothing is written. Answers only from your own shifts; asking about someone else's schedule gives "Didn't catch that". |
| `APPROVE_SWAP` | Manager or owner | "Approve Sam's swap request." | "Yeah okay, uh, go ahead and approve the swap Sam asked for." | "Approve Sam Sample's swap request for their <day> shift." | Request approved, shift moves to the cover, requester notified. If already decided: "That swap request was already approved." (or declined). |
| `DECLINE_SWAP` | Manager or owner | "Decline Sam's swap request." | "Um, no, let's say no to Sam's swap." | "Decline Sam Sample's swap request for their <day> shift." | Request declined, shift unchanged, requester notified. |
| `APPROVE_JOIN` | Manager or owner | "Approve Riley's join request." | "Riley Demo asked to join, uh, yeah, let them in." | "Approve Riley Demo's request to join." | Riley becomes active staff at the venue. If already handled: "That join request was already reviewed." |
| `DECLINE_JOIN` | Manager or owner | "Decline Riley's join request." | "Hmm, actually, reject the join request from Riley." | "Decline Riley Demo's request to join." | Join request declined; nobody is added. |
| `CREATE_SHIFT` | Manager or owner | "Create a bartender shift for Alex on Friday from 6pm to 2am." | "Can you, um, add a bar shift Friday night, six till two, for Alex?" | "Create a Bartender shift for Alex Example, Friday 6pm–2am." Preview: Alex Example, *Bartender · Fri <date> · 18:00–02:00*, **Draft**. | A **draft** shift appears in the rota builder (not published, staff aren't notified). "For nobody" makes an open shift (preview: **Open shift**). |
| `EDIT_SHIFT` | Manager or owner | "Move Alex's Friday shift to start at 7pm." | "Uh, Alex's Friday, push it to seven instead." | "Change Alex Example's Friday Bartender shift to 7pm–<end>." | That shift's time (or day, role, person) changes in the builder. Ending at or before the start counts as an overnight shift. |
| `ASSIGN_SECTION` | Manager or owner | "Put Sam on the terrace Friday evening." | "Er, Sam, terrace, Friday PM please." | "Move Sam Sample to the Terrace section, Friday PM." | Sam is pinned to Terrace for that date's PM on the floor plan. |
| `PUBLISH_ROTA` | Manager or owner | "Publish next week's rota." | "Okay, um, let's push out the rota for next week." | *Exact:* "This will publish N shifts across M staff members for the week of <Monday> — confirm?" No shifts: "There are no shifts scheduled for the week of <Monday> yet — nothing to publish." (no Confirm) | The week is published; affected staff are notified. |
| `APPLY_ROTA_TEMPLATE` | Manager or owner | "Apply the Weekend Standard template to next week." | "Can you, like, use the weekend standard one for next week?" | *Exact:* "Apply template "Weekend Standard" to the week of <Monday> — confirm?" Unclear name: "I'm not sure which saved template you meant — did you mean "…" or "…"? Please say the template name again." | The template's shifts are created as drafts for that week. |
| `POST_ANNOUNCEMENT` | Manager or owner | "Post an announcement: staff meeting Monday at 3pm in the bar." | "Um, announcement, uh, everyone, staff meeting Monday three pm, at the bar." | A short line ("Post this announcement to the venue") **plus "How it will look": the board's announcement card** with the exact text, filler words removed, nothing added, under your name. | The announcement appears on the venue board exactly as shown in the card. |
| `POST_SHOUTOUT` | Manager or owner | "Give Alex a shoutout for handling the rush tonight." | "Shoutout to, uh, Alex, amazing job with the rush tonight." | "Give Alex Example a shoutout with this note" **plus "How it will look": the board's shout-out card** (initials, **Alex Example**, the exact note, "<your name> · just now"). | The shoutout appears on the board for Alex, with that note. |
| `UNRECOGNIZED` | Any signed-in role | "Order more limes." | "Uh, what's the weather like?" | **"Didn't catch that"**, a plain sentence (default *exact:* "I didn't catch what you'd like to do.") and a hint; *I heard* open for editing; **Try again** and **Cancel**. | Nothing changes. |

Low confidence (any intent): the sheet shows **"Didn't catch that"**, *exact:* "I'm not sure I got
that right." and "It sounded like "<sentence>", but I'd rather check than guess. Say it again, or fix
what I heard and try again." No Confirm.

## Accents and floor noise

Run each block with at least one speaker of each accent your venue has (for example Arabic-,
Hindi/Urdu-, Tagalog-, and British/American-accented English), using fake names only.

1. **Quiet room, phone at chest height.** Baseline: run the plain phrase of five rows (mark
   availability, query schedule, create shift, publish, announcement).
2. **Kitchen/bar noise.** Play recorded service noise (or run during a real service) at normal
   level, phone at chest height. Same five rows, spoken variation.
3. **Arm's length.** Phone held out, same noise. Three rows.
4. **Names.** Say each fake staff name once in a sentence ("…for Alex", "…Sam's swap"). The server
   gives the model the venue's own staff, section and role names to help it; note any name heard
   wrong.
5. **Numbers and times.** "six till two", "18:00 to 02:00", "half seven": check the confirm
   sentence shows the right times and day.
6. **Two requests at once.** "Mark me off Friday and also what's my schedule": only the first is
   confirmed, then the follow-up prompt.

For every try, log what the **You said** line showed: a wrong **You said** is a transcription
problem (accent/noise); a right **You said** with a wrong sentence is an understanding problem.

## "Not set up" and "limit reached" messages

These come from the server, word for word (`server/src/routes/voice.ts`), shown in the red banner.

| Situation | Message |
|---|---|
| No AI set up on the server | "Voice commands aren't set up on this server yet. Use the app's buttons meanwhile." |
| Today's voice limit reached (`AI_VOICE_DAILY_CALL_LIMIT`, default 200 calls ≈ 100 commands; resets at 00:00 UTC = 04:00 Dubai) | "Voice commands have reached today's limit and are back tomorrow. Use the app's buttons meanwhile." |
| This person's daily voice quota used (`AI_VOICE_USER_DAILY_LIMIT`, default 40 calls ≈ 20 commands) | "You've used today's voice commands; they're back tomorrow. Use the app's buttons meanwhile." |
| This venue's daily voice quota used (`AI_VOICE_VENUE_DAILY_LIMIT`, default 100 calls ≈ 50 commands) | "Your venue has used today's voice commands; they're back tomorrow. Use the app's buttons meanwhile." |
| Monthly AI budget reached (`AI_MONTHLY_BUDGET_USD`) | "Voice commands are paused for the rest of this month (AI spending limit reached). Use the app's buttons meanwhile." |
| AI model setting out of date | "Voice commands are switched off on this server until its AI model setting is updated. Use the app's buttons meanwhile." |
| Google busy or unreachable | "Voice commands aren't available right now — try again later." |
| More than 20 recordings (or 30 commands understood) in 5 minutes by one person | "Too many requests — please wait a few minutes and try again." |
| Phone's recording format refused | "Your phone's recording format (<type>) wasn't accepted by the transcription service. This is a bug on our side rather than an outage — please tell us your phone model." |
| Microphone blocked | "Microphone access was denied or unavailable." |
| Browser can't record | "Voice commands are not supported in this browser." |
| Empty recording | "No audio captured — try again." |
| The recording stayed silent (checked on the phone, nothing is sent) | "I didn't hear anything. Hold the phone a little closer and try again." |
| The transcriber heard no speech (noise only) | "I didn't hear a command. Hold the phone a little closer and try again." |

How to see them without spending money: on a **non-production** environment, set
`AI_VOICE_DAILY_CALL_LIMIT=0` (today's limit), `AI_MONTHLY_BUDGET_USD=0` (monthly), or remove
`GEMINI_VERTEX_PROJECT` and `GEMINI_API_KEY` (not set up), deploy, and record one command each. A
refused command never reaches Google.

## Re-test from the evaluation

These failed or were borderline in the automated evaluation ([`voice-eval-report.md`](voice-eval-report.md)).
Say each one on a real phone, in a quiet room and then with background noise, and log the
result. Fake names: use people at your own test venue.

| # | Role | Say | Expect | Seen in the evaluation |
|---|---|---|---|---|
| R1 | Manager | "Approve Alex's swap request." (with one pending swap from Alex) | The approve sheet for that swap | Asked to rephrase: understood, but not confident enough |
| R2 | Manager | "Decline Alex's swap request." | The decline sheet for that swap | Same as R1 |
| R3 | Owner | "Approve the pending swap." | The approve sheet | Asked to rephrase before the fix; fixed in the re-run |
| R4 | Manager | "Create a bartender shift for Alex on Friday from 6 p.m. to 2 a.m." | Friday's date in the sheet; if a different day ever shows, the app must ask again | Once resolved to Saturday before the fix |
| R5 | Manager | "Put Alex on the bar tomorrow evening." | Bar section, tomorrow, PM | Fell through before the fix |
| R6 | Staff | "Mark me unavailable tomorrow." (with background noise) | Tomorrow, unavailable | Under-confident in noise before the fix |
| R7 | Manager | "Post an announcement: staff meeting Monday at 3 p.m. in the bar." (with noise) | The announcement text, word for word | Under-confident in noise before the fix |
| R8 | Manager | "Approve Riya's join request." (a pending applicant named Riya) | The approve sheet | Heard as "Riaz" once and asked again (right) |
| R9 | Anyone | Tap the mic and say nothing for 3 seconds | "I didn't hear anything…", nothing sent | Silence became an invented command before the fix |
| R10 | Anyone | Tap the mic with only background noise | "I didn't hear…" message | Noise became a name before the fix |

## "Which did you mean?" choices

When the app isn't sure but has two or three concrete readings, it lists them instead of asking
you to rephrase. Tapping one shows the normal confirm sheet for it; nothing changes until
**Confirm**. The model decides when to offer choices, so a phrase may also give a normal sheet or
a "rephrase" message; note which one you got.

| # | Role | Say | Expect |
|---|---|---|---|
| C1 | Manager | "Alex's swap, the pending one." (one pending swap from Alex) | The approve or decline sheet, or label **Choose one** with "Which did you mean?" and *Approve…* / *Decline…* buttons. Tap *Decline…*: the decline sheet, its preview the swap request line tagged **Decline**, and an **Other choices** link back; the swap stays pending until you tap Confirm. |
| C2 | Manager | Same as C1, then tap **Cancel** on the choices | The sheet closes; the swap is still pending. |
| C3 | Staff | "Swap with Omar or approve it." | Never a manager action in the list. With only one staff reading left, the app asks you to rephrase. |
| C4 | Manager | A phrase naming someone who isn't at your venue | That person never appears in a choice. |

## People: missing names, shared names, and editing what was heard

The app looks up every person a command names in **your own venue's** staff list. Someone who
isn't there gets a plain message naming them; a first name two or three people share is always a
question, never a silent pick. Rows marked *exact* are written by the server. Nothing changes
until **Confirm**.

| # | Role | Say | Expect |
|---|---|---|---|
| P1 | Manager | "Give Alex a shout-out saying great job." (one Alex) | Label **Shout-out**; preview card with **Alex Example**, note "Great job" (or close), "<your name> · just now". **Confirm** → green banner; exactly one shout-out on the board. |
| P2 | Manager | "Give Rana a shout-out saying great job." (nobody called Rana) | Label **Not on your team**; *exact:* "I couldn't find Rana on your team." and "If Rana is new, add them in People first, then try again."; an **Open People** button; *I heard* open for editing; no Confirm. **Cancel**: nothing posted. Never "Could not confidently match this to a supported command." |
| P3 | Staff | "Ask Rana to cover my shift tomorrow." | *exact:* "I couldn't find Rana on your team." and "Check the name and try again."; no People button. |
| P4 | Manager | "Give Karim a shout-out saying great job." (Karim Saleh and Karim Aziz) | Label **Which person?**; *exact:* "Which Karim did you mean?"; one button per Karim (name and the note). Tap **Karim Aziz**: the shout-out preview for Karim Aziz, an **Other choices** link back. **Cancel**: nothing posted. |
| P5 | Manager | Same as P4, tap **Karim Saleh**, then **Confirm** | Exactly one shout-out, to Karim Saleh, with that note. |
| P6 | Manager | "Give Karim Aziz a shout-out for closing up." | The normal shout-out sheet for Karim Aziz (the surname settles it); no question. |
| P7 | Manager | "Put Karim on the terrace tomorrow evening." | "Which Karim did you mean?"; each choice previews *Terrace · <date> · PM*. |
| P8 | Manager | A close misspelling of someone on the team, e.g. "Give Alix a shout-out." | Either the sheet for Alex Example, or "I couldn't find Alix on your team." with **Alex Example** offered as a choice. Never anyone from another venue. |
| P9 | Anyone | "Order more limes." | **Didn't catch that**, a plain sentence and a hint, no Confirm. Note the exact words shown: they must read like a person, not a log line. |
| P10 | Manager | Say "Give Alex a shout-out", then on the sheet tap **Edit**, change the words to "Give Alex a shout-out for the spotless bar", tap **Try again** | A new sheet for the edited words, with the new note in the preview; no new recording. **Back** (while editing) returns to the previous preview unchanged. |
| P11 | Manager | Say something that isn't understood, then fix the words in the *I heard* box and tap **Try again** | The sheet for the fixed words. In the voice log both commands appear, the first as not understood. |
| P12 | Manager | "Create a bartender shift for Alex on Friday from 6pm." (no end time) | Either the new-shift sheet with an end you can check, or label **Almost there** with *exact* wording like "I've got a new shift for Alex Morgan on Fri <date> from 18:00 — what time does it end?". Never "I didn't catch what you'd like to do." Add "to 2am" to *I heard* and **Try again**: the new-shift preview. |
| P13 | Manager | "Put Alex on the bar tomorrow evening." | The section sheet (Bar, tomorrow, PM). If a part is ever dropped: **Almost there** naming Alex Morgan and asking only for the missing part(s). |
| P14 | Manager | "Put Karim on the terrace tomorrow evening." | **Which Karim did you mean?** with both Karims (each previewing *Terrace · <date> · PM*); if section/day/period were dropped, **Almost there** asking "which Karim (…)" plus the missing parts. |

## Results log

Copy this table per session. Fill **Heard** from the **You said** line, **Intent** from the sheet
(or "banner: <message>").

| # | Tester (fake id) | Accent | Noise | Phrase said | Heard ("You said") | Intent / sheet shown | Correct? (Y/N) | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | T1 | | quiet / service / arm's length | | | | | |
| 2 | | | | | | | | |
| 3 | | | | | | | | |
