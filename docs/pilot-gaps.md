# Pilot gaps — first manager and first staff session

What a venue's first manager and first staff member would hit on the live pilot today that is
still missing or weak. Every row is checked against the code, tests or docs on `master`
(2026-10-06, after run 12); file references are given so each can be re-checked. Severity:
**blocker** (the session can't be completed), **high** (completes, but badly or with risk),
**medium**, **low**. Effort is rough: S ≤ ½ day, M 1–3 days, L a week or more, or "owner" for
steps only a person with the accounts can take.

## Sign-in and joining

| Gap | What happens today | Severity | Effort |
|---|---|---|---|
| No SMS | Codes are only sent with `SMS_OTP_ENABLED=true` and a provider (`server/src/lib/sms.ts`); production has neither. A number on the echo allowlist sees its code on screen; production lists one number. Everyone else is told "Enter the code we sent to …" (`src/routes/LoginRoute.tsx`) and nothing arrives. | blocker for anyone not on the allowlist | owner (provider + sender ID, `docs/otp-delivery-uae.md`); S to switch on |
| Staff can't join by invite link | Joining needs a verified code (`server/src/routes/join.ts`, purpose `JOIN`); the join screen promises a text (`src/components/JoinFlow.tsx`). With SMS off, only allowlisted numbers can file a join request. | blocker for self-join | comes with SMS |
| Working path for staff: login links | The manager adds the person in Staff Directory and taps **Send login link** (`src/components/StaffDirectory.tsx`): single use, 24 h (`server/src/lib/loginLinks.ts`); the session then lasts 30 days with no refresh (`server/src/lib/identity.ts`), after which a new link is needed. | high (manual for every person, every 30 days) | — |
| New owner signup | Same code step as login; a new owner whose number isn't allowlisted can't finish signup. Fallback is the operator script in `docs/deployment.md` ("set up the venue for them"). | blocker for a self-serve venue | comes with SMS |
| No-SMS wording | The code screen doesn't say a code may not come, and the paste-a-login-link box is only on the phone step (`LoginRoute.tsx`). | medium | S |

## Notifications

| Gap | What happens today | Severity | Effort |
|---|---|---|---|
| Push not yet tried on a phone | On since 2026-10-06 (VAPID keys set on Railway, checked against a local mock push service and on the live API). Not yet received on a real Android phone or iPhone; on iPhone it only works from the Home Screen app (`docs/push-go-live.md` §5). Every notification also stays under the in-app bell. | medium | owner session (§5) |
| Push setup doc was out of date | `docs/push-go-live.md` used the stale `shift-sync-shift-sync1.vercel.app` address (`docs/deployment.md` says to ignore it) and said iPhone push waits for the web app manifest, which is already on master (`public/manifest.webmanifest`, `index.html`). | low | corrected in this PR |

## Environments and data safety

| Gap | What happens today | Severity | Effort |
|---|---|---|---|
| Previews use production data | `vercel.json` sends every preview's `/api` to the production API (`docs/staging-setup.md`). A click on a PR preview reads and writes real venue data. | high | owner + M (`docs/staging-setup.md` steps) |
| Vercel protection | Production answered without a Vercel login on 2026-10-05 (`docs/mvp-status.md`); the owner check on a phone is still open (`docs/owner-todo.md`, `docs/launch-checklist.md`). | medium until confirmed | owner, minutes |
| Test venue in production | `__deploy-check__` venue still listed for removal (#53, `docs/test-venue-cleanup.md`, unticked in `docs/launch-checklist.md`). | low | owner, S |

## Rota, kiosk and offline

| Gap | What happens today | Severity | Effort |
|---|---|---|---|
| Rota builder v0 not live | Copy last week, split shifts, the overlap guard, uncovered-shift flags, bulk actions and all-staff availability are in the unmerged rota stack (#69 → #78 → #84 → #108–#111; `docs/rota-review-guide.md`). A first manager builds the week shift by shift. | high | owner review, then merge |
| Leave read access rule (rota stack) | A planned tightening of who may read the rota's leave list (to match the other rota reads) is not done yet; see the run 12 report. | medium (only once the stack merges) | S |
| Kiosk doesn't refresh itself | The kiosk link UI exists (People → kiosk panel: create, regenerate, revoke; audit-logged after run 12). A kiosk screen picks up edits only when reloaded (`docs/mvp-status.md`). | medium | M |
| Offline | The service worker handles push only (`public/sw.js`), so opening the app with no network fails. Staff see saved copies of My Shifts and published weeks already opened online; managers get no saved copy (`docs/mvp-status.md`). | medium | M–L |

## Apps and stores

| Gap | What happens today | Severity | Effort |
|---|---|---|---|
| No Android build | The debug-APK workflow stops at `npm ci`: `package-lock.json` is out of sync with `package.json` (dev-tool packages), so no APK is produced. | high for an app pilot, none for the web pilot | S (regenerate the lockfile in a reviewed PR) |
| Store readiness | No release signing or versioning (`docs/android.md`), no iOS project (PWA only, `docs/mvp-status.md`), no public account-deletion page that Google requires (`docs/store-readiness.md`), store accounts not decided (`docs/launch-checklist.md`). | high for stores | M–L + owner |

## Voice and AI

| Gap | What happens today | Severity | Effort |
|---|---|---|---|
| Voice not tried on real phones | `docs/voice-test-script.md` is ready; results are not recorded yet. | high until tested | owner session |
| Voice daily limits | Per person 40 model calls a day (20 commands), per venue 100 (50 commands), all AI together 150 a day while `AI_DAILY_CALL_LIMIT` is unset (`server/src/lib/aiBudget.ts`, `docs/ENV_VARS.md`). A busy pilot day may hit the venue limit. | medium | owner (variables) |
| AI roster reading | 5 reads per venue per 7 days in production (`AI_VISION_WEEKLY_LIMIT`), inside a USD 5 monthly cap (default while `AI_MONTHLY_BUDGET_USD` is unset). | low | owner (variables) |

## Other

| Gap | What happens today | Severity | Effort |
|---|---|---|---|
| Legal pages are drafts | `/privacy` and `/terms` carry a DRAFT banner pending legal review (`docs/owner-todo.md`). | medium | owner |
| Deploy config deadline | Railway stops reading `railway.json` on 2026-12-01 (#52, `docs/railway-deploy-procedure.md`). | high after 2026-12-01 | M |
