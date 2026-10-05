# Launch checklist

One list of what must be decided or done before real venues use ShiftSync. Each item names the
doc to follow. Written 2026-10-04 from the docs on `master`. Tick an item only when it is done
and checked, and write the date next to it.

"The owner" is the person who runs ShiftSync's accounts (Railway, Vercel, Google Cloud, the
stores).

## Web access and environments

- [ ] **Production web address.** Pilot venues can open it on their phones without a Vercel
  account. Previews stay closed to the public. Follow: Vercel project settings,
  [`deployment.md`](deployment.md) §3.
- [ ] **Previews never touch production data.** A preview build's `/api` calls go to a staging
  API (`VITE_API_URL` set for Preview builds), not to production's; check it in the browser's
  network tab. Follow: [`staging-setup.md`](staging-setup.md) §3,
  [`ENV_VARS.md`](ENV_VARS.md) §2.
- [ ] **Production variables match the checklist**, both "must be set" and "must be absent".
  Follow: [`ENV_VARS.md`](ENV_VARS.md) §6.
- [x] **Health after the last deploy:** `/api/health` and `/api/health/ready` both answer `200`
  (checked 2026-10-05 after deploy `5fd67c0c`, master `ee65d9d`). Re-check after every deploy.
  Follow: [`runbook-incidents.md`](runbook-incidents.md) §0.
- [ ] **Test venues removed from production** (#53). Follow:
  [`test-venue-cleanup.md`](test-venue-cleanup.md).

## Railway

- [ ] **Move the build and deploy settings off `railway.json` before 2026-12-01** (#52). After
  that date Railway ignores the file, and the API would deploy with no healthcheck. Until it is
  done, never `railway up`. Follow: [`railway-deploy-procedure.md`](railway-deploy-procedure.md) §3.
- [ ] **Answer the open #52 question:** does a failed healthcheck keep the old deployment
  serving while the volume is attached? Follow: [`railway-deploy-procedure.md`](railway-deploy-procedure.md) §3.4.

## AI (roster photos and voice)

- [ ] **Google Cloud billing** linked, Vertex AI API on, budget alert set. Follow:
  [`vlm-go-live.md`](vlm-go-live.md) §1–2.
- [ ] **Vertex credentials** (service account, `GEMINI_VERTEX_PROJECT`,
  `GOOGLE_SERVICE_ACCOUNT_JSON`) are set on Railway (2026-10-04) and now serve both roster reading
  and voice (2026-10-05). Tick when the owner's **Test AI connection** (Profile) shows both
  *Working*. Follow: [`vlm-go-live.md`](vlm-go-live.md) §3–6, [`owner-todo.md`](owner-todo.md).
- [ ] **Spend cap decided:** keep or change `AI_MONTHLY_BUDGET_USD` (default 5),
  `AI_VISION_DAILY_CALL_LIMIT` (default 60), `AI_VOICE_DAILY_CALL_LIMIT` (default 200) and
  `AI_VISION_WEEKLY_LIMIT` (production: 5 per venue in any 7 days). Follow:
  [`vlm-go-live.md`](vlm-go-live.md) §2, [`ENV_VARS.md`](ENV_VARS.md).
- [ ] **Delete the old Gemini Developer API key.** Production no longer uses one (voice moved to
  Vertex on 2026-10-05). Each local worktree keeps its own key ([`ENV_VARS.md`](ENV_VARS.md) §1).
- [ ] **Opt-in before the first voice command, with a way to withdraw it.** The notice before the
  first recording is built (2026-10-05); a setting to withdraw it is not. Follow:
  [`store-readiness.md`](store-readiness.md) §3.
- [ ] **Voice tested on real phones** (iPhone and Android, accents, floor noise). Follow:
  [`voice-test-script.md`](voice-test-script.md).
- [ ] Everyone on call knows how to switch AI off. Follow:
  [`runbook-incidents.md`](runbook-incidents.md) §5.

## Sign-in codes by SMS (#51)

- [ ] UAE sender ID registered and approved on du and Etisalat; provider settings set on Railway;
  one test code reaches a du number and an Etisalat number; the code-echo settings removed.
  Follow: [`otp-delivery-uae.md`](otp-delivery-uae.md), [`ENV_VARS.md`](ENV_VARS.md) §6.
- [ ] Until then, decide how pilot staff sign in (a manager's login link). Follow:
  [`manager-quick-start.md`](manager-quick-start.md).

## Push notifications

- [ ] VAPID key pair generated, set on Railway, and checked on a real Android phone and iPhone.
  Follow: [`push-go-live.md`](push-go-live.md).

## Stores and legal

- [ ] **Store accounts:** who owns the Apple Developer and Google Play Console accounts is decided
  (the owner's decision), and both exist. Then work through the checklist in
  [`store-readiness.md`](store-readiness.md).
- [ ] **Legal review** of the draft `/privacy` and `/terms` pages, including retention periods
  and backups; then the DRAFT banner comes off. Follow:
  [`store-readiness.md`](store-readiness.md) §1–2, [`backup-restore.md`](backup-restore.md) §3.
- [ ] Public account-deletion web page for Google Play. Follow:
  [`store-readiness.md`](store-readiness.md) §1.

## Data safety

- [ ] Backup questions answered and a restore test done. Follow:
  [`backup-restore.md`](backup-restore.md).
- [ ] Whoever is on call has read the incident runbook. Follow:
  [`runbook-incidents.md`](runbook-incidents.md).

## Pending pull requests

- [ ] **Rota stack** reviewed and merged in order: #69 → #78 → #84 → #108–#111. Before #84's
  migration, run its read-only overlap check against production. Follow:
  [`rota-review-guide.md`](rota-review-guide.md) (covers #69, #78, #84).
- [x] **Kiosk links** (#115) merged and deployed 2026-10-05; revoke steps are in
  [`runbook-incidents.md`](runbook-incidents.md) §6.3. Shared screens opened with an old
  `/?venue=` link need a new kiosk link from People.
- [ ] After the rota stack merges, update the quick-starts and
  [`mvp-status.md`](mvp-status.md).
