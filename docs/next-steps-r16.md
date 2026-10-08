# Next steps after run 16

What to do next, in order, based on what run 16 found plus the open items in
[`owner-todo.md`](owner-todo.md). Sizes: **S** = under a day, **M** = a few days, **L** = a week or more.
"Only you" marks a step that needs your account, phone, decision or signature.

## Before a demo with a real venue manager

| # | Item | Size | Only you |
|---|---|---|---|
| 1 | **Decide the open stacks.** Voice redesign #143 → #144 → #145 (waiting for "MERGE NOW"); run 16's #147 (staff import), #148 (onboarding orb) and the voice bug-hunt PR are stacked on #145. | S | The go-ahead, and the phone test of the preview links (signed in to Vercel). |
| 2 | **Publish after the week changed** (found in run 16, not changed): the stronger publish card states how many shifts change and how many people are notified, but Confirm publishes whatever the week holds at that moment. If someone adds or edits a shift between the preview and Confirm, more is published than the card said. Options: refuse and re-preview when the counts differ, or accept the current behaviour. | S | The decision (it changes what the server accepts). |
| 3 | **Phone test of the voice fixes** (stale "I heard" under Listening, the microphone off when the app goes to the background, one Confirm = one command) and the new **Import staff from a roster** button on an iPhone. | S | Only you (real iPhone, real microphone). |
| 4 | **Temporary AI limits** are still raised for the test week (owner-todo 20). Keep them through the demo, then set them back. | S | Only you (Railway variables). |
| 5 | **Friendly not-found screen** for unknown production addresses (owner-todo 21). | S | — |
| 6 | **Role on swap and join approval sheets** (owner-todo 22): the server sends the person's role with those readings. | S | — |
| 7 | **Two People-page controls that look wrong in WebKit** (found in run 16, outside its scope): the join link's "Expires after" picker draws as a white box with light text; and every `.btn` looks the same when disabled as when enabled. | S | — |
| 8 | **Rota stack** #69 → #78 → #84 → #108–#111 (owner-todo 9). | M | Review and the go-ahead. |

## Before an App Store submission

| # | Item | Size | Only you |
|---|---|---|---|
| 9 | **An iOS project does not exist yet.** Create the Capacitor iOS project (Android exists, `docs/android.md`), with microphone, camera and photo-library permission texts, and native push (Web Push does not work inside the app's web view). | L | Apple developer account, signing, App Store Connect. |
| 10 | **Privacy notice names Google Gemini** (Vertex AI) as the AI provider for roster photos and voice, and the legal review of `/privacy` and `/terms` (owner-todo 10). | M | Legal review and sign-off. |
| 11 | **Push-endpoint security fix** waits while the repository is public (it would advertise an open issue); it ships once the repository is private, or by your decision. | S | The decision on repository visibility. |
| 12 | **Live captions on iPhone** (owner-todo 23): revisit inside the iOS project. | M | — |
| 13 | **Keys and settings:** delete the local Vertex key copy and the old Gemini key (owner-todo 7–8); move Railway build settings off `railway.json` before 2026-12-01 (owner-todo 12). | S | Only you. |
| 14 | **Real iPhone audio**: confirm transcription of the iPhone's own recording format on a real device (all run 16 audio was synthetic speech through Chromium). | S | Only you (the phone). |

## Nice to have

| # | Item | Size | Only you |
|---|---|---|---|
| 15 | Run the voice state-machine fuzz (`e2e/voice-fuzz.spec.ts`) with thousands of sequences on a schedule, not only the short run in the test suite. | S | — |
| 15b | Show an announcement's reach as a count on the voice confirm (it now says everyone is notified; the server would send the number). | S | The decision. |
| 16 | Refuse an empty audio upload before it reaches the model (the app never sends one; a hand-made request costs one failing model call). | S | The decision (it changes what the server accepts). |
| 17 | A WebKit version of the voice fuzz (WebKit in the local test browser has no audio; it would need stand-ins). | M | — |
| 18 | Old open PRs: #91, #36, #30, #42 (owner-todo 13). | S | Merge or close. |
| 19 | `owner-todo.md` item 19 is out of date: #140 (roster import) is merged. | S | — |
| 20 | **Staff-screen bundle budget is full:** after run 16 the staff screens download 142.4 kB (gzip) against a 142.45 kB ceiling (budget + 10%). The next addition to the app shell will fail the build; slim the shell or re-set the budget on purpose. | S | Whether to re-set the budget. |
| 21 | **Voice can only schedule the next two weeks:** dates past the reading step's 14-day calendar ("December 31st", "the 1st of next month") are asked again, so they can't be done by voice. | M | — |
| 22 | **"6 to 2" always asks am/pm:** the most common extra tap in the live matrix; a venue setting for opening hours could settle it without guessing. | M | Whether to add the setting. |
