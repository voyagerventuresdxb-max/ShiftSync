# MVP status (master, 2026-10-05)

An honest snapshot: what works end to end on `master` and which test proves it, what is mocked or not configured in production, and the known limits. Update it when any of these change.

## Works end to end (test-backed)
Every line has an end-to-end Playwright spec in `e2e/` that drives the real app, the real API and a real database.

| Area | What works | Spec |
|---|---|---|
| Venue signup + onboarding | Welcome → Venue → Roster (Excel/CSV/text PDF) → Review (edit, flag, confirm) → Invite; survives a reload on every step | `onboarding`, `onboarding-step-persistence`, `review-persistence`, `venue-name-rename` |
| Sign-in | Phone + one-time code for every role, routed by role; resend cooldown; manager-issued one-time login links | `login`, `otp-resend-cooldown`, `login-links` |
| Joining | Expiring, revocable invite links; pending → owner approves on People → staff signs in → "You're in" → My Shifts; decline and re-apply | `invite-links`, `join-approval`, `staff-flow`, `people-refresh-reapply` |
| Kiosk screen | Per-venue kiosk link from People (shown once, regenerate, revoke) opens `/kiosk` on a shared screen: published rota, announcements, shoutouts; a venue id alone or an old link shows nothing (`docs/deployment.md` → Kiosk links) | `kiosk-token` |
| People | Staff Directory add/edit, phones stored as E.164; deactivating someone signs them out at once | `staff-directory`, `deactivate-ends-session` |
| Scheduling | Default roles, shifts without any roster upload, templates, publish with one notification per person | `zero-setup-scheduling`, `voice` |
| Time zones | Week, "today" and shift times are the venue's (tested from Dubai and Los Angeles viewers, month and year ends) | `calendar-liveness` |
| Floor plan | Section pins (place, drag, rename, delete), pinch zoom, daily assignment by drag | `floor-plan-pins`, `floor-plan-section-editor`, `floor-plan-zoom` |
| Documents | Policy documents upload, view, delete | `policy-documents` |
| Voice commands | A notice before the first recording; transcript → intent → confirm sheet → change, for staff and manager intents (the AI is faked at the network boundary in tests) | `voice` |
| AI connection test | Owner → Profile → Test AI connection: one tiny roster-reading and one tiny voice call, a line per feature; staff never see it | `ai-self-test` |
| Offline staff schedule | My Shifts and Home's next shift show the person's saved copy, labelled, when the network drops; wiped on sign-out | `offline-schedule` |
| Notifications | In-app bell; push delivery path up to the send (recorded in tests) | `push-outbox`, `push-unavailable` |
| AI roster consent | Nothing goes to the AI reader without the manager's per-file consent | `roster-ai-consent` |
| Account deletion | Self-service deletion from Profile; the last owner is refused; draft privacy/terms pages linked | `account-deletion` |
| Phone UX | ≥44px touch targets everywhere, back gesture closes sheets, offline/slow-network messages, iPhone PWA basics | `touch-targets`, `back-navigation`, `bad-network`, `iphone-pwa` |

Server-side rules with their own suites (no e2e): the Wednesday 17:00 cover-request window (`swapWindow.test.ts`), the readiness check (`/api/health/ready`), roster escalation rules, the eval harness (`npm run eval:roster`).

## Mocked or not configured in production
| Feature | State in production | What turns it on |
|---|---|---|
| AI roster reading (photos, scans) | **On**: Vertex AI (`eu`), behind the in-app spend cap (USD 5 a month); up to 5 AI reads per venue in any 7 days (`AI_VISION_WEEKLY_LIMIT=5`). First real-phone test pending | `docs/vlm-go-live.md` (owner: `docs/owner-todo.md` items 3–4) |
| Voice commands | **On** since 2026-10-05: the same Vertex AI setup as roster reading, same spend cap, 200 calls a day. First real-phone test pending | `docs/voice-test-script.md` |
| SMS sign-in codes | Flag off, no provider. Codes reach only numbers on the demo allowlist; everyone else signs in with a manager's login link | `docs/otp-delivery-uae.md` (sender-ID registration first) |
| Push notifications | **No VAPID keys**: in-app bell only | `docs/push-go-live.md` |
| Android app | Shell builds locally; nothing uploaded to Play | `docs/store-readiness.md` |
| iPhone | PWA (Add to Home Screen); no native app | — |
| Web front end | Production URL answered without a Vercel login on 2026-10-05; confirm on a phone | owner's Vercel settings (`docs/owner-todo.md` item 1) |

## Known limits
- **Rota builder v0 is not on master yet.** Leave on the grid, copy last week, split shifts, the overlap guard and manager-only drafts are in #69 → #78 → #84, awaiting review (`docs/rota-review-guide.md`).
- **Parser:** image rosters need the AI reader (day headers with a weekday, like `Mon 17/08`, are read since 2026-10-04).
- **Voice consent** is a notice shown once per person per device; there is no setting to withdraw it yet.
- **Offline copy** covers a staff member's own published weeks only, and only weeks already opened online on that device.
- **Live updates** are refetch-on-focus/visibility/notification, not websockets. A kiosk screen left open picks up new announcements or rota edits only when reloaded (it does move to the new week on Monday).
- **Legal pages** are drafts, marked as such, pending legal review.
- **Railway config-as-code** (`railway.json`) stops working on 2026-12-01 (#52 follow-ups).

## 5-minute demo script
Set up once: `npm run db:setup`, `npm run db:seed:demo -- --phones=<owner>,<staff>,<applicant>`, the three numbers in `ECHO_ALLOWED_PHONES`, `npm run dev:all`. Two browsers (or phones): owner and staff.

1. **0:00 Owner signs in** with the owner number → Home: announcements, shoutouts, cover-request approvals, anonymous floor feedback.
2. **0:45 Scheduling:** this week is published; open a shift, change its end time, save. Show the publish status.
3. **1:45 Staff phone:** sign in with the staff number → My Shifts shows the changed time in venue time; Home shows the next shift.
4. **2:30 People:** the pending join request → Approve; the new hire appears in the Staff Directory. Show the venue join link and QR.
5. **3:15 Floor plan:** drag a staff chip onto a section for tonight; open the section.
6. **4:00 Post an announcement** from Home; the staff phone shows it on its next focus (and as a push once VAPID is set).
7. **4:30 Close** on onboarding: a new venue uploads an Excel roster and lands on the Review screen in seconds.

**Between runs:** `npm run db:reset:demo -- --phones=<owner>,<staff>,<applicant>` (the same three numbers) puts the demo venue back exactly as seeded in a few seconds: it removes the demo organization, including anyone who joined, every edit and announcement, and the three numbers' sign-in codes, then re-seeds. Like the seed, it refuses to run unless the database is on localhost.

**Recorded walkthrough:** `npm run demo:record` (`playwright.demo.config.ts`, `e2e/demo/five-minute-demo.demo.ts`) plays the script above at phone size (390x844). It records one video per scene and one of the whole run into `DEMO_VIDEO_DIR` (default `test-results/demo-videos`; videos are never committed). It uses made-up numbers from the e2e echo pool and resets the venue before each take. Scene 5 opens a section but doesn't drag a chip.
