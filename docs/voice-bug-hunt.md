# Voice bug hunt (run 16)

What was tried against the voice sheet, what broke, and what changed. Made-up venue and names
only (`server/eval/voice/fixture.ts`); no audio or real names in the repo.

## Defects found and fixed

Each has a test that fails without the fix.

| # | What happened before | After | Test |
|---|---|---|---|
| 1 | **The last command's words stayed on screen.** A second recording showed the previous command's "I heard …" under the orb while it said *Listening* (also after a reading that failed). | A new recording starts with no words on screen; its own words appear once transcribed. | `e2e/voice-bughunt.spec.ts` (first two tests) |
| 2 | **The microphone stayed on in the background.** Switching apps or locking the phone while recording left the microphone recording until the 10-second stop, and the clip was then sent. | Going to the background turns the microphone off and drops the clip unsent; on return the sheet says *Recording stopped* and why. | `voice-bughunt.spec.ts` (third test); fuzz invariant 1 |
| 3 | **The microphone could switch on in the background.** If the app went to the background while the microphone was still starting (the permission prompt), the recording started anyway once it arrived. | It is released the moment it arrives, and the same message shows. | `voice-bughunt.spec.ts` (fourth test) |
| 4 | **Two Confirm taps in the same instant sent the command twice.** The server runs a command once when it has its voice-log id; without one, both would have run. | One Confirm sends one request, whatever the timing. | `voice-bughunt.spec.ts` (fifth test); fuzz invariant 4 |
| 5 | **Wrong action: time off booked for the wrong person.** *"Give Omar next Friday off"* (a manager) was offered as *"Ask for Fri 16 Oct off."*, a time-off request that is always the caller's own, so Confirm would have booked the manager's day off, not Omar's. The time-off card also did not say whose days they were. | Time off or availability whose words name someone else is asked, never offered: *"That would book your own days off, not Omar's."*, pointing to the rota. The card now reads *"Your time off · 1 day"*. Saying your own name, or nobody's, is unchanged. | `server/src/voice/contextCheck.test.ts`, `VoicePreview.test.ts`; live re-check |
| 6 | **A malformed reading took the whole app down** (found by the fuzz). A reading missing a field the confirm sheet draws (a shout-out with no person, an answer with no list) threw while drawing, and the router's error page replaced the app (no dock, only a reload helped). | Readings are checked before they are shown: a malformed one becomes *"couldn't read that"* with the words kept and nothing sent. An error boundary around the confirm sheet closes it with a message if anything else throws. The check accepts all 212 readings the real server returned in the live runs. | `src/lib/voiceReading.test.ts`; `voice-bughunt.spec.ts` (last test); fuzz invariant 6 |

Checked and already right (regression tests added):
- a new command never shows the last command's "Which one?" choices or confirm sheet;
- the typed box starts empty.

## State-machine fuzz

`e2e/voice-fuzz.spec.ts`: random sequences on the real app (fake microphone in Chromium, every
voice call answered in the page). Each sequence has 14 steps, drawn from:
- start/stop recording, close, Escape, the back gesture;
- type a command, edit the words, Update preview, pick a reading;
- Confirm, including twice in one instant;
- offline/online, a denied microphone;
- slow, failing and malformed answers;
- the app going to the background and back.

After every step, and again once each sequence is back to closed, it checks:
1. The microphone is released whenever the sheet is closed or the app is in the background.
2. At most one voice sheet and one confirm sheet are up.
3. Confirm sends only the reading on screen, with the words it was read from.
4. One Confirm runs a command once.
5. Once closed, nothing is left running: no animation frames, intervals, long timers, listeners, audio contexts, microphone tracks or orb drawing.
6. No error appears in the page.

| Run | Sequences | Steps | Readings | Confirms sent | Violations |
|---|---|---|---|---|---|
| Before the fixes | 200 | 1,506 | 92 | 33 | **36**: microphone on in the background (28), a second Confirm while the first was in flight (8) |
| After fixes 1–5 | 2,000 | 7,121 | 93 | 24 | **4**: one long timer still pending after closing, each time right after the connection was switched off and on (see below) |
| Diagnosis runs on the same code | 800 | — | — | — | The app crashed to the router's error page in 68 of the last 160 sequences: **fix 6**. This also explains the low step count above (with the app gone, most actions had nothing to tap). |
| Final code (the test suite's run) | 120 | 1,507 | 129 | 37 | **0** |

The test suite runs 120 sequences each time. Set `VOICE_FUZZ_SEQUENCES` for a longer run.

A second 2,000-sequence run on the final code was stopped after 80 minutes to keep the run's time box; it writes its report only at the end, so it has no numbers.

The four "long timer pending" reports were not seen again in 800 later sequences. The fuzz now records where each long timer was set. They followed offline/online switches, which points at the app's connection re-check rather than the voice sheet, but the source is not confirmed.

## Command matrix (live, text)

`server/eval/voice/matrix.ts`: 181 commands through the real model and the real local API. Each
case is scored against what a careful person would accept.

They mix sources:
- clean speech, filler words and misheard words;
- Hindi/Urdu/Arabic mixed into English;
- accents written as they come out;
- Arabic and Hindi script.

They cover these probes:
- relative days and "this weekend";
- overnight and ambiguous times;
- month and year boundaries and impossible dates;
- shared first names, short forms and longer names;
- people not on the staff list, pronouns, two people at once, quantities and role words used as names;
- other venue's names, injection phrases, and empty, short and very long input.

Results by outcome:
- **Correct**: the right reading and details.
- **Asked**: "Which one?", or a question instead of acting (always safe).
- **Refused**: a manager action from a staff account, "not by voice", nonsense.
- **Wrong action**: a Confirm offered for something other than what was meant.

| Group | Cases | Correct | Asked | Refused | Wrong action |
|---|---|---|---|---|---|
| Shout-outs | 22 | 11 | 10 | 1 | 0 |
| Announcements | 10 | 8 | 1 | 1 | 0 |
| Create shift | 24 | 5 | 18 | 1 | 0 |
| Open shift | 4 | 2 | 2 | 0 | 0 |
| Split shift | 2 | 1 | 1 | 0 | 0 |
| Edit shift | 12 | 6 | 5 | 1 | 0 |
| Cancel shift | 9 | 4 | 4 | 1 | 0 |
| Sections | 11 | 5 | 5 | 1 | 0 |
| Questions | 12 | 11 | 1 | 0 | 0 |
| Swaps | 14 | 8 | 5 | 1 | 0 |
| Time off | 10 | 7 | 3 | 0 | 0 (1 before fix 5) |
| Availability | 6 | 5 | 1 | 0 | 0 |
| Publish | 8 | 5 | 1 | 2 | 0 |
| Templates | 6 | 2 | 3 | 1 | 0 |
| Join requests | 6 | 4 | 1 | 1 | 0 |
| Not by voice | 8 | 0 | 0 | 8 | 0 |
| Input edges | 17 | 3 | 13 | 1 | 0 |
| **All** | **181** | **87** | **74** | **20** | **0** (1 before fix 5) |

- Nothing changed in the venue before Confirm in any case.
- No other venue's names appeared, no schedule answer named someone else, and no robotic wording was shown.
- Latency of the reading step: p50 2.6 s, p95 2.9 s. Cost about USD 0.019 per command.

One case was reviewed by hand and counted as correct. A staff member's *"Cancel my shift
tomorrow"* is offered as *"Ask for Fri … off."* Staff cannot cancel shifts, and asking for that
day off is the request they can make; the card says plainly what it does.

### Where it asked although it could have acted (25 cases, all safe)

- **Which times (9).** "6 to 2", "10 to midnight" and "12 to 8" without am/pm get "Which times did you mean?" with both readings to tap. This is by design (ask, don't guess); it is the most common extra tap.
- **Names, sections, roles (9).** Short forms ("Pri"), misheard names and a role the venue doesn't have get "Which one?", "couldn't find", or a suggestion to tap.
- **Dates past the next two weeks (3).** "December 31st", "January 2nd" and "the 1st of next month" are asked again: the reading step only knows the next 14 days. These can't be scheduled by voice today.
- **Other (4).** Unclear times ("half seven to half eleven at night") and a few code-mixed phrasings.

## Live audio

31 clips of synthetic speech (Windows' built-in voices; no new provider), through the real
transcribe and reading steps:
- 10 phrases clean, 5 of them also at 15 dB and 5 dB of venue noise;
- a noise-only clip;
- 8 new matrix phrases, including code-mixed ones and a 20-second ramble.

Results:
- **Readings.** Every clip whose words were transcribed got a correct reading or a question. No wrong action.
- **Noise and mixed language.** Noise-only got "I didn't hear a command". The two Hindi sentences spoken by an English synthetic voice were not recognised as speech: the same safe message, nothing offered.
- **Transcription.** Word error was 0 on most clean clips and at most 0.31 with noise.
- **Not tested.** Real iPhone recordings (their own audio format) and real venue noise; this needs a phone.

## Safety matrix

All checked on `/execute`, the only real boundary (`server/src/routes/voiceSafety.test.ts`).
Results: all refused, nothing changed, no leak.

- **Staff accounts:** every one of the 12 manager actions gets 403, and nothing changes in either venue.
- **Other venue's ids:** in every id field (person, shift, role, section, template; a staff swap naming another venue's person or shift) the request is refused with nothing changed and nothing of that venue in the answer.
- **Confirm after the preview's record changed:**
  - a removed shift (edit, cancel);
  - a swap decided in the meantime;
  - a person who left (shout-out, new shift, section): refused, nothing changed.
- **Readings with extra instructions:** injection phrases in the words never changed what was offered beyond the request itself; another venue's names are never offered.
- **Many people notified:**
  - publish carries the stronger card (shifts changing, people notified);
  - an announcement shows its board card, and now also says that everyone at the venue gets it as a notification (posting is the one full-team fan-out). It does not show a count yet: that would need the server to send one.
- **Rate limit, AI budget, offline and timeout:** a plain message; nothing is sent while offline, and a timed-out Confirm stays on the sheet with "it may still have gone through".

### Needs a decision (not changed)

- **Publish after the week changed.** The stronger publish card states how many shifts change and how many people are notified. `/execute` publishes whatever the week holds when Confirm arrives, so a shift added between preview and Confirm is published, and its person notified, without the card having said so. Changing this changes what the server accepts.
- **Empty audio upload.** A hand-made request with an empty audio file reaches the model (one failing, paid call). The app never sends one.
- **The announcement's reach as a count** (like publish's "people notified"): the server would send the number with the reading.
- **A command without a voice-log id.** If writing the log fails, a Confirm retried after a timeout cannot be recognised as already done. The client now never sends two at once (fix 4), but a deliberate retry after a timeout could still run twice. This is rare: it needs the log write to fail.
