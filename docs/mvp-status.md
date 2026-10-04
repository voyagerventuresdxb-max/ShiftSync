# MVP status (master, 2026-10-04)

An honest snapshot: what works end to end on `master` and which test proves it, what is mocked or not configured in production, and the known limits. Update it when any of these change.

## Works end to end (test-backed)
Every line has an end-to-end Playwright spec in `e2e/` that drives the real app, the real API and a real database.

| Area | What works | Spec |
|---|---|---|
| Venue signup + onboarding | Welcome → Venue → Roster (Excel/CSV/text PDF) → Review (edit, flag, confirm) → Invite; survives a reload on every step | `onboarding`, `onboarding-step-persistence`, `review-persistence`, `venue-name-rename` |
| Sign-in | Phone + one-time code for every role, routed by role; resend cooldown; manager-issued one-time login links | `login`, `otp-resend-cooldown`, `login-links` |
| Joining | Expiring, revocable invite links; pending → owner approves on People → staff signs in → "You're in" → My Shifts; decline and re-apply | `invite-links`, `join-approval`, `staff-flow`, `people-refresh-reapply` |
| People | Staff Directory add/edit, phones stored as E.164; deactivating someone signs them out at once | `staff-directory`, `deactivate-ends-session` |
| Scheduling | Default roles, shifts without any roster upload, templates, publish with one notification per person | `zero-setup-scheduling`, `voice` |
| Time zones | Week, "today" and shift times are the venue's (tested from Dubai and Los Angeles viewers, month and year ends) | `calendar-liveness` |
| Floor plan | Section pins (place, drag, rename, delete), pinch zoom, daily assignment by drag | `floor-plan-pins`, `floor-plan-section-editor`, `floor-plan-zoom` |
| Documents | Policy documents upload, view, delete | `policy-documents` |
| Voice commands | Transcript → intent → confirm sheet → change, for staff and manager intents (the AI is faked at the network boundary in tests) | `voice` |
| Notifications | In-app bell; push delivery path up to the send (recorded in tests) | `push-outbox`, `push-unavailable` |
| AI roster consent | Nothing goes to the AI reader without the manager's per-file consent | `roster-ai-consent` |
| Account deletion | Self-service deletion from Profile; the last owner is refused; draft privacy/terms pages linked | `account-deletion` |
| Phone UX | ≥44px touch targets everywhere, back gesture closes sheets, offline/slow-network messages, iPhone PWA basics | `touch-targets`, `back-navigation`, `bad-network`, `iphone-pwa` |

Server-side rules with their own suites (no e2e): the Wednesday 17:00 cover-request window (`swapWindow.test.ts`), the readiness check (`/api/health/ready`), roster escalation rules, the eval harness (`npm run eval:roster`).

## Mocked or not configured in production
| Feature | State in production | What turns it on |
|---|---|---|
| AI roster reading (photos, scans) | Code ready; **no Vertex credentials**, so image uploads get a clear "not configured" message with the manual path | `docs/vlm-go-live.md` |
| Voice commands | **No Gemini key**: voice is off | a key set by hand on Railway |
| SMS sign-in codes | Flag off, no provider. Codes reach only numbers on the demo allowlist; everyone else signs in with a manager's login link | `docs/otp-delivery-uae.md` (sender-ID registration first) |
| Push notifications | **No VAPID keys**: in-app bell only | `docs/push-go-live.md` |
| Android app | Shell builds locally; nothing uploaded to Play | `docs/store-readiness.md` |
| iPhone | PWA (Add to Home Screen); no native app | — |
| Web front end | Production URL behind Vercel deployment protection | owner's Vercel settings |

## Known limits
- **Rota builder v0 is not on master yet.** Leave on the grid, copy last week, split shifts, the overlap guard and manager-only drafts are in #69 → #78 → #84, awaiting review (`docs/rota-review-guide.md`).
- **Parser:** day headers written like `Mon 17/08` aren't recognised (the eval harness reports it); image rosters need the AI reader.
- **Live updates** are refetch-on-focus/visibility/notification, not websockets.
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
