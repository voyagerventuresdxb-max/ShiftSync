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
- One tap starts recording, a second tap stops it; it stops by itself after 10 seconds. The voice
  sheet opens full-screen: the gold orb, one word for the step under it, what was heard (once it
  is transcribed — there are no live captions), and at the bottom the mic (its ring counts down the
  10 seconds), the keyboard on the left and **Cancel** on the right. Closing it while recording
  (the arrow at the top, or **Cancel**) turns the microphone off and sends nothing; closing it
  while the words are being read lets it step aside, and the sheet comes back with the answer.
- Every command shows a sheet first: a small label naming the kind of command (e.g. **Shout-out**,
  **New shift**), one sentence saying what will happen, **I heard "…"** (exactly what was heard),
  then a **preview** of the result as the app will show it (a shout-out or announcement as its board
  card, a shift as its rota line, a swap or join as its request line). One big **Confirm**, small
  **Edit** and **Cancel**. Nothing changes until **Confirm**.
- **Edit** (or tapping the heard words) turns *I heard* into a text box; fix the words and tap
  **Update preview**: the edited text is read again (no new recording), and you get a new sheet — still
  nothing changes until **Confirm**. **Back** returns to the preview.
- A low-confidence or unclear command shows **"Didn't catch that"**, a plain sentence and a hint,
  *I heard* already open for editing with **Update preview**, and no Confirm. No sheet ever says
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
| `UNRECOGNIZED` | Any signed-in role | "Order more limes." | "Uh, what's the weather like?" | **"Didn't catch that"**, a plain sentence (default *exact:* "I didn't catch what you'd like to do.") and a hint; *I heard* open for editing; **Update preview** and **Cancel**. | Nothing changes. |

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

These come from the server, word for word (`server/src/routes/voice.ts`). Before Confirm they show
above the typed command box (titled **Assistant unavailable** or **Limit reached**), so the command
can be typed instead; after Confirm they show in the red banner. The last four rows are the phone's own.

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
| Microphone blocked | Box **Microphone is off**: "ShiftSync isn't allowed to use the microphone, so nothing was recorded. Type your command below instead.", then how to turn it back on in iPhone Safari |
| Browser can't record | Box **Voice doesn't work here**: "This browser can't record voice commands. Type your command below instead." |
| Empty recording, or the recording stayed silent (checked on the phone, nothing is sent) | Box **Didn't hear anything**: "I didn't hear anything. Hold the phone a little closer and try again, or type your command below." |
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
| P8 | Manager | A close misspelling of someone on the team, e.g. "Give Alix a shout-out." (with or without a note) | Either the sheet for Alex Example, or "I couldn't find Alix on your team." with "Did you mean Alex Example?" and **Alex Example** offered: with a note, as a choice that previews the shout-out; without one, as a button that reads "Give Alex Example a shout-out." again (then **Almost there** asks what it should say). Never anyone from another venue. |
| P9 | Anyone | "Order more limes." | **Didn't catch that**, a plain sentence and a hint (never the same sentence twice), no Confirm. Note the exact words shown: they must read like a person, not a log line. |
| P10 | Manager | Say "Give Alex a shout-out", then on the sheet tap **Edit**, change the words to "Give Alex a shout-out for the spotless bar", tap **Update preview** | A new sheet for the edited words, with the new note in the preview; no new recording. **Back** (while editing) returns to the previous preview unchanged. |
| P11 | Manager | Say something that isn't understood, then fix the words in the *I heard* box and tap **Update preview** | The sheet for the fixed words. In the voice log both commands appear, the first as not understood. |
| P12 | Manager | "Create a bartender shift for Alex on Friday from 6pm." (no end time) | Either the new-shift sheet with an end you can check, or label **Almost there** with *exact* wording like "I've got a new shift for Alex Morgan on Fri <date> from 18:00 — what time does it end?". Never "I didn't catch what you'd like to do." Add "to 2am" to *I heard* and **Update preview**: the new-shift preview. |
| P13 | Manager | "Put Alex on the bar tomorrow evening." | The section sheet (Bar, tomorrow, PM). If a part is ever dropped: **Almost there** naming Alex Morgan and asking only for the missing part(s). |
| P14 | Manager | "Put Karim on the terrace tomorrow evening." | **Which Karim did you mean?** with both Karims (each previewing *Terrace · <date> · PM*); if section/day/period were dropped, **Almost there** asking "which Karim (…)" plus the missing parts. |

## 12-minute demo flow (made-up names)

Same structure as the owner's private demo script, with made-up names. Example venue: a roster
PDF with 21 staff including **Alex Morgan** (Waiter), **Sam Okoye** (Runner), two people called
**Karim** (Karim Saleh, Bartender; Karim Aziz, Runner), and an **Edwin** and an **Edwina**.
Sections to create on the floor plan: **Terrace**, **Bar**, **Main floor**. Before the demo,
have Sam ask for a swap from a staff phone for a shift in a week whose cover requests are still
open, so there is a swap to approve.

| Min | Step | Say / do | Expected on screen |
|---|---|---|---|
| 0–1 | Sign in, fresh venue | Owner sign-in; check the venue name in the header | The name you typed; a rename shows everywhere at once |
| 1–3 | Import the roster | Schedule → Upload → the roster PDF, AI reading allowed | Progress: "Uploading", "Reading your roster with the AI reader", "Cross-checking the two readings", "Matched people to your staff"; then the review screen |
| 3–4 | Check names and week | Scroll the review list | Every person listed as new, the printed week (not this week); a cell marked to check opens with the readings to pick from; a person only one AI reading listed asks "Import them?" |
| 4 | Confirm | Tap Confirm | People lists everyone; the week is filled. Uploading the same file again adds 0 people and 0 shifts |
| 4–5 | Floor plan | Floor Plan tab | Empty state with "Add your first section"; add Terrace, Bar, Main floor |
| 5–6 | Section by voice | "Put Alex on the terrace tomorrow evening" | Alex Morgan (Waiter), Terrace, tomorrow's full date, PM. Confirm |
| 6–7 | Shift by voice | "Create a waiter shift for Alex on Friday from 6 to 2" | Two readings, evening first: tap 18:00–02:00 (ends next day), then Confirm |
| 7–8 | Shout-out | "Give Alex a shout-out for great service tonight" | Shout-out preview for Alex Morgan. Confirm |
| 8 | Shared first name | "Give Karim a shout-out saying well done" | "Which Karim did you mean?" with both Karims and their roles; tap one, then Confirm |
| 8–9 | Announcement by voice | "Post an announcement: staff meeting Monday at 3pm in the bar" | The announcement text, word for word. Confirm |
| 9–10 | Swap approval by voice | "Approve Sam's swap request" | The approve sheet for Sam's swap. Confirm |
| 10–11 | A question | "Who is working tonight?" | A list of tonight's people with roles and times; just Done, no Confirm |
| 11–12 | Publish by voice | "Publish next week's rota" | The stronger card: how many shifts change and how many people are notified. "Confirm: publish and notify N people" |

**Phrases verified live (local stack, live model, typed):** every phrase in the table, plus
"Who's on tomorrow?", "Who is on the terrace tonight?", "Are there any pending swap requests?",
"What are the latest announcements?", "When am I working next?" (staff), "Cancel Sam's shift
tomorrow", "Move Alex's Saturday shift to start at 7pm", "Add Alex on Sunday from 18:30 to 1",
a split shift ("10am to 2pm and 6pm to 11pm"), "I need next Tuesday off for a doctor's
appointment" (staff), "Ask Alex to cover my shift tomorrow" (staff), "Mark me unavailable next
Wednesday" (staff), code-mixed phrasing ("Yalla, put Alex sa terrace bukas ng gabi"; "Sam ko kal
shaam six to eleven ki shift do"; "Shukran Sam, give her a shout-out"), and every never-by-voice
request (each declined with a link to the right screen).

**Three recovery moves**
1. Wrong or unclear person: "Which one?" or "Pick from your team". Tap the right person;
   nothing changes before Confirm.
2. Misheard words, or a noisy room: tap the keyboard next to the mic and type the command, or fix
   the words in "I heard — fix it, then update the preview"; the same preview and Confirm follow.
3. Import says "Hard to read — not imported", or many cells to check: upload the original PDF
   export instead of a photo; a repeat import adds no duplicates.

**Names that will ask "Which one?"** Shared first names (Karim) always; a one-word name with a
close alternative at the same venue ("Edwin" when there is also an Edwina) asks, the exact
match listed first; saying the full name settles it.

**Not for a demo:** anything outside rota and people (declined politely); phone photos of dense
or angled printed rosters; rosters whose day headings are shifted against the columns (everyone
is imported, every day is shown to check); staff swap requests for a week whose cover requests
have closed (the app explains the cut-off).

## Typing, answers, declines and error states (voice tools v2, phone side)

The keyboard button next to the mic opens **Type a command**: type what you would say and tap
**Show preview**. A typed command goes through the same reading, preview and **Confirm** as a spoken one;
its sheet says **You typed** instead of *I heard*. While a command runs, its step is written out:
*Listening… tap the mic to stop*, *Transcribing…*, *Understanding…* (on the voice sheet: one word
under the orb, the full step for a screen reader), then *Ready to confirm* or *Here's the answer*,
then *Doing it…* on the confirm sheet, then a **Done: …** banner. With iPhone **Reduce Motion** on
(Settings → Accessibility → Motion), the orb is a still image, nothing moves or pulses, the heard
words appear at once, and the words of each step still show. Made-up names as in *Before you start*; dates are spelled out in full (weekday, day,
month, year).

| # | Role | Do or say | Expect |
|---|---|---|---|
| T1 | Manager | Tap the keyboard button, type "Create a bartender shift for Alex on Friday from 6pm to 2am", **Show preview** | *Understanding…*, then **New shift** with **You typed "…"**, Alex Example, "Bartender · Friday <date>, 18:00 – 02:00 (ends Saturday)", *Ready to confirm*. **Confirm** → "Done: …" banner. |
| T2 | Staff | Type "order more limes", **Show preview** | **Didn't catch that**, the words in the box, and three phrases under **Or try**: "When am I working this week?", "I can't work next Friday", "Request next Monday to Wednesday off". Tap one: it fills the box and nothing is sent. **Update preview** sends it. |
| T3 | Manager | Same as T2 | The phrases are the manager's: "Who's working tonight?", "Add an open bartender shift tomorrow 6pm to 2am", "Any pending requests?" |
| T4 | Anyone | Say any command | *Listening*, *Transcribing* and *Understanding* each show under the orb (the orb changes with them) before the confirm sheet. |
| R1 | Manager | "Who's working tonight?" | Label **Who's working**; a title with tonight's full date; one row per person (name, then role, then times); a single **Done**; no Confirm. Nothing changes. |
| R2 | Manager | "Who's on the terrace tonight?" | Label **Sections**; one row per person on Terrace, or the empty sentence if nobody is. **Done** only. |
| R3 | Staff | "Any pending requests?" | Label **Requests**; only this person's own requests. **Done** only. |
| R4 | Anyone | "What were the last announcements?" | Label **Announcements**; recent announcements as rows. Any text that looks like code shows as plain text. **Done** only. |
| R5 | Staff | "What's my schedule?" | Label **Your schedule**; a row per shift, or "You have no shifts in the next 14 days." **Done** only. |
| D1 | Manager | "Deactivate Riley Demo" | Label **Not by voice**; *exact (server):* "Removing or deactivating someone isn't done by voice. Do it in People."; an **Open People** button that opens People; **Got it**; no Confirm, nothing changes. |
| D2 | Manager | "Run payroll" | **Not by voice** with the server's sentence about payroll and WPS; no screen button. |
| D3 | Staff | "Change my sign-in phone number" | **Not by voice**, a sentence telling them to ask a manager; no screen button. |
| P1 | Manager | "Publish next week's rota" (with some draft changes) | Label **Publish rota**; card **Before you publish**: *Shifts changing N*, *People notified M*, "N shifts will change and M people will be notified."; the big button reads **Confirm: publish and notify M people**. Check N and M against the rota: only shifts this publish changes, only people who get a notification. |
| C1 | Manager | "Cancel Alex's Friday shift" | Label **Cancel shift**; card **Shift to cancel** with a red edge and a **Cancel** tag: Alex Example, Bartender, "Bartender · Friday <date>, <start> – <end>", and "This shift comes off the rota, and Alex Example is no longer working it." Buttons **Confirm: cancel this shift**, **Edit**, **Keep shift**. **Keep shift** changes nothing. |
| O1 | Staff | "Book next Monday to Wednesday off" | Label **Time off**; "Time off · 3 days"; "From Monday <date> to Wednesday <date>"; the reason if one was said. |
| S1 | Manager | "Add a split shift for Sam on Saturday, 11 to 3 and 6 to 11" | **New shift**; "Split shift, two parts", then "1st: Saturday <date>, 11:00 – 15:00" and "2nd: Saturday <date>, 18:00 – 23:00". One **Confirm** creates both. |
| E1 | Anyone | Safari → **aA** → Website Settings → Microphone → **Deny**; tap the mic | Box **Microphone is off** with how to turn it back on (aA → Website Settings → Microphone → Allow, or Settings → Apps → Safari → Microphone). Type the command in **Type it instead**: it works. Then allow the microphone again with those steps. |
| E2 | Anyone | Airplane mode on; tap the mic | Box **You're offline**: "Voice needs a connection, so nothing was recorded. Reconnect and try again." Type something, **Show preview**: "Nothing was sent. Reconnect, then tap Show preview again — your words are kept below." Airplane mode off, **Show preview**: the sheet appears. |
| E3 | Manager | Get any preview, airplane mode on, tap **Confirm** | The sheet stays open with **You're offline**: "Nothing was sent and nothing changed. Reconnect, then tap Confirm again." Reconnect and **Confirm**: done once, not twice. |
| E4 | Anyone | On a slow connection (or a dev build with `window.__shiftsyncVoiceTimeoutMs = 1000` set in the console), send a command | After 25 seconds (1 s on the dev setting): box **Taking too long**: "The assistant didn't answer within 25 seconds, so I stopped waiting. Nothing changed. Try again, or type it below." The words are kept. |
| E4b | Manager | Get any preview, then make **Confirm** slow (very weak signal, or the dev setting above) | The sheet stays open with **Taking too long**: "No answer after 25 seconds. It may still have gone through — check before you confirm again." Tap **Confirm** again: "Done: …", and the change exists once, never twice. |
| E5 | Anyone | Non-production with no AI key; send a typed command | Box **Assistant unavailable** with the server's sentence (see the table above). |
| E6 | Anyone | More than 30 commands in 5 minutes, or a spent daily limit | Box **Limit reached** with the server's sentence. |

## The voice sheet (run 15)

| # | Do | Expect |
|---|---|---|
| V1 | Tap the mic, say a command, tap the mic again | Orb: a slow ring (starting), a dotted sphere whose speed and fine outer ring follow your voice (listening), orbits (transcribing), a connected web (understanding); the heard words appear word by word, then the confirm sheet rises and the orb becomes a small calm ring above it. |
| V2 | Tap the mic, then the top arrow (or **Cancel**) while still recording | The sheet closes, the phone's microphone indicator goes off, and nothing is sent (no transcript, nothing in the voice log). |
| V3 | Say a command, then close the sheet while it shows *Transcribing* | The sheet steps aside, the dock's mic spins; the confirm sheet comes back on its own with the answer. |
| V4 | On any preview, tap the heard words (or **Edit**), change them, **Update preview** | The same reading again from the edited words, no recording; a new preview; nothing changes before **Confirm**. |
| V5 | "Which one?" (two people with the same first name) | The orb is small and dim; each person is a card with full name and role; no Confirm until one is chosen. |
| V6 | Microphone denied, airplane mode, or a timeout | A still, dim orb, the problem in plain words, and the typed box on the same sheet; **Show preview** goes on to the same Confirm. |
| V7 | iPhone **Reduce Motion** on, then V1 | The orb is a still image in every step; the heard words appear at once; nothing slides. |

## Results log

Copy this table per session. Fill **Heard** from the **You said** line, **Intent** from the sheet
(or "banner: <message>").

| # | Tester (fake id) | Accent | Noise | Phrase said | Heard ("You said") | Intent / sheet shown | Correct? (Y/N) | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | T1 | | quiet / service / arm's length | | | | | |
| 2 | | | | | | | | |
| 3 | | | | | | | | |
