# Autonomous run — 2026-10-02

Multi-phase run against `origin/master @ 32edfc5` (= production), using the gap audit of 2026-10-01 as the source of truth. Each phase got its own worktree, branch and PR. **Nothing was merged or deployed.** No Railway, Vercel, Supabase or production env var was touched. The main checkout (`C:\dev\ShiftSync`) was never edited.

## Final report

### 1. Results

Every phase passed typecheck (client + server), lint (0 errors) and build.

| Phase | Status | PR | Tests (unit · server · e2e) |
|---|---|---|---|
| 0 Setup / baseline | done | — | master: 62/62 · 283 pass, 1 skip · 20 passed + 1 flaky (disk-full upload, passed on retry) |
| 1 Security: echo allowlist + prod boot guards | done | [#62](https://github.com/voyagerventuresdxb-max/ShiftSync/pull/62) | 62/62 · 301 pass, 1 skip · full 21/21 |
| 2 Housekeeping | done | [#61](https://github.com/voyagerventuresdxb-max/ShiftSync/pull/61) | 62/62 · 284 pass, 1 skip · full 23/23 |
| 3 `/login` + role routing | done | [#64](https://github.com/voyagerventuresdxb-max/ShiftSync/pull/64) (on #62) | 68/68 · 301 pass, 1 skip · `login` 10/10, full 31/31 |
| 4 Approval → staff in | done | [#65](https://github.com/voyagerventuresdxb-max/ShiftSync/pull/65) (on #64) | 68/68 · 309 pass, 1 skip · full 34/34 |
| 5 Invite tokens | done | [#66](https://github.com/voyagerventuresdxb-max/ShiftSync/pull/66) (on #65) | 70/70 · 320 pass, 1 skip · `invite-links` 5/5, full 39/39 |
| 6 #44 login links (adapted) | done | [#67](https://github.com/voyagerventuresdxb-max/ShiftSync/pull/67) (on #66) | 70/70 · 345 pass, 1 skip · `login-links` 2/2, full 41/41 |
| 7 Golden-path e2e | done | [#68](https://github.com/voyagerventuresdxb-max/ShiftSync/pull/68) (on #67) | golden path **3/3 consecutive** runs · full 42/42 |
| 8 Deploy-safety prep (#52, VAPID) | done | [#63](https://github.com/voyagerventuresdxb-max/ShiftSync/pull/63) | 66/66 · 287 pass, 1 skip · full 21/21 |
| 9 Rebase of #42 (rota v0) | done, **draft** | [#69](https://github.com/voyagerventuresdxb-max/ShiftSync/pull/69) | 72/72 · 308 pass, 1 skip · full 22/22 |
| Integration: #61–#68 merged together locally | done | — (local only) | 74/74 · 350 pass, 1 skip · 43/44; the one failure was fixed on #61 and re-verified |

e2e runs from Phase 3 on used `--retries=0`.

### 2. Merge order

**Set these before merging anything:**
- Railway API service: set **`ECHO_ALLOWED_PHONES`** to your demo numbers, comma-separated, in E.164 (e.g. `+9715xxxxxxxx`). Production runs `ALLOW_DEV_OTP_ECHO=true`. Once #62 deploys, a production API with echo on and an empty list **refuses to boot**; the healthcheck then fails and the previous deploy keeps serving.
- Railway API service: confirm `NODE_ENV=production` is set. Also confirm `ALLOW_DEV_OTP_BYPASS` and `ALLOW_DEV_ERROR_INJECTION` are **not** set; either one makes production refuse to boot.
- Vercel needs nothing. In your local `.env`, add `ECHO_ALLOWED_PHONES`, or the dev code stops showing.

**How to merge:** the repo usually squash-merges and does not delete branches after a merge. For #62 and the stack #64–#68, use **"Create a merge commit"**. If you squash a parent, every child PR re-applies the parent's commits and conflicts. After each parent merges, edit the child PR's base to `master` before merging it. Otherwise it merges into the parent's branch and never reaches master.

**Order:**
1. **#62 (security).** Most urgent: today any phone number gets its code echoed in production, so anyone can sign in as anyone. After merging, redeploy the API from source and check `/api/health`. Then confirm an allowlisted number shows a code and any other number doesn't.
2. **#63 (deploy safety).** Independent of everything else. `railway.json` is unchanged, so today's deploys behave the same. It adds the `start` script and `railpack.json` (protection against the static-site fallback) and makes a bad VAPID key fail soft.
3. **#61 (housekeeping).** Independent; merges cleanly with everything.
4. **#64 → #65 → #66 → #67 → #68**, in one sitting, retargeting each to `master`. Then **redeploy the API straight away**: Vercel ships the frontend from master, but the API does not auto-deploy. Until the API is redeployed, the new invite panel and login-link pages error.
   - #66 runs migration `invite_links`. Its deploy starts the **7-day window** for old `/join?location=` links, so post the new invite link in staff WhatsApp groups that week.
   - #67 runs migration `login_links`. Leave `LOGIN_METHODS` unset (that means phone codes and links both work). `LOGIN_LINK_TTL_HOURS` is optional (default 24).
5. **#69 (draft) is not part of this order.** It needs the #42 author's review first. If it lands after the stack:
   - Rename its `e2e/golden-path.spec.ts` to `golden-path-rota.spec.ts`.
   - Keep both sides of the `AuditAction` enum.
   - Switch its staff login to `nextEchoPhone()` + `/login`.

Once those land, it's your call whether to close #44 (superseded by #67), #43 (overlaps #62 and is on an old base) and #42 (if #69 is accepted).

### 3. Check on a real phone (iPhone Safari and Android Chrome)

1. On `/login`, an allowlisted number shows the dev code. Any other number gets no code and can't sign in; that's expected until SMS (#51).
2. Role landing: owner/manager goes to Home (`/`), staff goes to My Shifts. The phone and code fields bring up the numeric keyboard.
3. Paste the invite link into a WhatsApp group and check the preview. Tap it: "Join <venue>" → join → "Waiting for <manager>". Approve on the manager's phone. The applicant signs in again, lands on My Shifts, and sees "You're in" in the bell.
4. Scan the QR from the onboarding Invite step with the phone camera.
5. On the manager's phone, Regenerate and then Revoke the invite link. The old link must then say "no longer active".
6. Staff Directory → **Send login link** → share sheet → WhatsApp. Tap it on the staff phone and sign in once; a second tap must be refused. On iPhone, check the installed Home Screen app: a link tapped in WhatsApp may sign in Safari only. If so, "Paste your login link" inside the app is the way in.
7. At phone width, check layout and tap targets on `/login`, `/login/link`, the invite panel on People, and Pending Approvals.
8. An old `/join?location=…` link still works during the week after #66 deploys.

### 4. Blocked, skipped, risky; open questions

**Nothing blocked.** All nine phases delivered. #44, #43 and #42 were not pushed to, commented on or closed.

**Risks:**
- **After #62, non-allowlisted users can't get a code in production.** Until SMS (#51), staff need login links from #67.
- **Merge mechanics** for the stack (see §2). Squash-merging, or not retargeting each PR to master, is the main way to get this wrong.
- **#52 is still open.** `.railway/railway.ts` in #63 is a draft that hasn't been tried on Railway. `railway.json` stops working on 2026-12-01. Run the non-production proof in `docs/railway-deploy-procedure.md` in early November.
- **NODE_ENV:** production very likely already has `NODE_ENV=production` (`server/src/lib/prisma.ts` depends on it), so #62's boot guard will be live on its first deploy.

**Gaps:**
- `.env.example` was not updated; agents aren't allowed to read it. Add `ECHO_ALLOWED_PHONES` by hand.
- #61 has no `MEMORY.md` entry; the permission classifier refused that edit.
- `/people` doesn't live-refresh.
- Deactivating a user doesn't end their sessions (#20).
- PENDING duplicates filed before #65 stay in the queue; decline them.
- e2e logs show benign teardown races (caught 500s).

**Housekeeping:**
- C: was full at start, and an install hit "no space left on device". I cleared the npm cache (11.6 GB; it rebuilds itself).
- The 15+ older `C:\dev\ShiftSync-*` worktrees from earlier sessions each hold a `node_modules`. That's where the space went.
- The main checkout still has uncommitted edits on `fix/onboarding-followups-12-15`, plus dozens of junk untracked files named like `$resp`, `({`, `200`. They look like shell-redirect accidents. I didn't touch them.
- Local Docker now has a `dev_<branch>` schema for each run branch. They're safe to drop.

**Open questions:**
- Which numbers go in `ECHO_ALLOWED_PHONES`?
- Close #43/#44 once #62/#67 land?
- Are the defaults right: 30-day invite links and 24-hour login links?
- Should a declined applicant be able to re-apply through the link? Today a manager has to add them.

### 5. Remaining roadmap (not started)

- Rota builder: split shifts.
- Voice v2 + its e2e. #69's `@live` voice spec was not run, to avoid spending the shared Gemini quota.
- Capacitor Android.
- Real SMS OTP (#51), the launch blocker. Afterwards, empty `ECHO_ALLOWED_PHONES` and turn the echo off.
- VAPID go-live: run `npm run vapid:generate` and set the 3 variables on Railway.
- xlsx CVE: #23 / PR #30 (exceljs).
- Follow-ups from this run:
  - live refresh on `/people`;
  - end sessions on deactivation (#20);
  - delete the legacy `?location=` code once every environment is past its window;
  - #52's non-production proof.

---

## Appendix — how the run worked and per-phase notes

### Setup (Phase 0)
- Worktrees `C:\dev\ShiftSync-auto-*` sat next to the main checkout. Each phase branch had its upstream unset, so a bare `git push` could never target `master`. Each worktree was removed once its PR existed.
- DB: the local Docker `shiftsync-dev-postgres` via `npm run db:setup`, with a per-branch `dev_<branch>` schema (AGENTS.md §6).
- **Serialized e2e:** every worktree's Playwright config binds :4000 and :5173 with `reuseExistingServer`, and `server:dev` runs `kill-port 4000`. Parallel runs would have killed or reused each other's servers. All e2e runs went through a lock wrapper: an atomic mkdir lock that frees the ports and runs with `CI=1`.
- Not used: `npm run swarm`, `sparc` and `local` (AGENTS.md §4). The claude-flow MCP failed to connect, and these are outside this run's scope.
- **Stacking:** #62 is the base of the auth chain because its echo allowlist changes how every e2e spec gets a code. #61 and #63 are independent.
- #44 sits on #43, which branches from 7bad1f9, before master's E.164 phones (#59) and OTP caps (#56/#58). So Phase 6 ported #44 onto the chain on a new branch, rather than rebasing #44 itself. No force-push was allowed.

### Phase 1 — #62
- `server/src/lib/devOtpEcho.ts` replaces the three per-route echo constants. `devOtpEchoFor(e164)` reads the env on every call and normalizes each list entry with `toE164`. Unlisted numbers get neither `devCode` nor the plaintext log line.
- `server/src/lib/productionGuards.ts` `checkProductionEnv()` runs in `index.ts` before the app is built.
  - Production means `NODE_ENV=production` **or** `RAILWAY_ENVIRONMENT_NAME=production`.
  - Fatal: echo on with no valid allowlist entry; `ALLOW_DEV_OTP_BYPASS=true`; `ALLOW_DEV_ERROR_INJECTION=true`.
  - File and export names match #43's, so the two converge.
- e2e: a per-run pool of 300 `+97156…` numbers is passed as `ECHO_ALLOWED_PHONES`. `nextEchoPhone()` hands them out through a tmpdir counter, so a retried worker never reuses a number.
- Known: a refused boot happens after `prisma migrate deploy` has already run (harmless, the migrations are additive). Allowlisted numbers are password-less in production by design, so keep the list to demo accounts.

### Phase 2 — #61
- Closed #12–#15, citing #16 (each verified fixed on master first).
- Imported `docs/Deferred.md`, `Home.md` and `CLAUDE_HANDOFF.md` verbatim. The secret scan was clean.
- Phone on Add staff: the server already validated it; the form never sent it. Added an up-front 409 that also covers deactivated and other-venue holders.
- My Shifts' signed-out button now points to login instead of bare `/join`.
- Later fix `082db94`: the new spec accepts either login URL. The integration run found it pinned `/join?mode=login`, which the chain redirects.

### Phase 3 — #64
- `/login` (phone → code) for every role.
- `postLoginDestination`: a safe `returnTo` wins. Otherwise OWNER/MANAGER go to `/` and anything else to `/my-shifts`; it fails closed.
- `/join?mode=login` redirects to `/login`, keeping `returnTo` only if it's safe. Every link that pointed at `/join?mode=login` now points at `/login`.
- `isSafeReturnTo` is hardened: same origin after URL resolution, and `/join` and `/login` are rejected after decoding and dot-segment resolution, case-insensitive.
- Server unchanged. Also fixed a pre-existing race in `touch-targets.spec`.

### Phase 4 — #65
- Login codes now also go to deactivated users and pending/declined applicants. Their status is revealed only after the code verifies:
  - pending → "Waiting for <manager> to approve you at <venue>", with no token;
  - declined or deactivated → 403 with a clear message.
- A join re-verify with a PENDING request already filed doesn't create a duplicate or ping managers again.
- Approving a phone that already belongs to a user now returns 409 instead of a 500. It's race-safe, and voice approvals handle it too.
- Approval leaves a "You're in" in-app notice.

### Phase 5 — #66
- Join links are now `/join?invite=<token>` (32 random bytes). They have an expiry (default 30 days, range 1–90), optional max uses, revoke and regenerate. Each venue has at most one unrevoked link (per-venue advisory lock).
- The token is stored as-is so the panel can show it again. It's a broadcast link; the approval gate is the real control.
- Manager API: `/api/invites/:locationId` (requireManager + assertOwnsLocation, audit-logged). `InviteLinkPanel` appears on `/people` and on the onboarding Invite step.
- Public peek returns 410 with a human message.
- A use is consumed only when a request is filed or a user is signed in. It's one conditional UPDATE inside the same transaction, and mutation-tested.
- Migration `20261002112104_invite_links` (additive): the `invite_links` table, nullable `locations.legacy_join_links_until`, 2 audit values, and a backfill of `now() + 7 days`.
  - **Legacy window:** for each venue, it closes 7 days after that environment applies the migration. After that, old links return 410 and file nothing. Venues created later never accept `?location=`.

### Phase 6 — #67
- #44's 7 commits were cherry-picked in order on the first attempt, plus 6 follow-ups.
- **`LOGIN_METHODS` unset means phone codes and links both work.** Only an explicit `links` turns phone codes off (403). Tests cover both.
- Master won on behavior:
  - E.164 `findUserByPhone`;
  - `otpClientKey` limiters (issue 10/h per session; peek 60 and redeem 30 per 10 min);
  - the paste box moved to `/login`;
  - #44's old migration replaced by a fresh `20261002120036_login_links` (additive: `login_links` table, `users.is_platform_admin`, 4 audit values).
- Kept from #44:
  - only the sha256 of each token is stored;
  - the token travels in the URL fragment, which is scrubbed;
  - a link is redeemed only when tapped;
  - claim, session and audit happen in one atomic transaction;
  - the issuer scope matrix;
  - "Send login link" in the Staff Directory;
  - the CLI `admin:grant` and `org:create` (the platform-admin flag is CLI-only).
- Added: a deactivated issuer gets 404.

### Phase 7 — #68
- `e2e/golden-path.spec.ts` drives the real UI with three browser contexts:
  1. owner onboarding gets the invite link;
  2. claim by phone match → My Shifts;
  3. pending → "Waiting for <owner>" → approve in Pending Approvals → fresh code on `/login` → My Shifts, with "You're in" in the bell;
  4. returning staff signs in via `/login`;
  5. returning owner signs in via `/login` and lands on `/`.
- It passed 3 consecutive separate runs with retries off (55s cold, then 22s and 23s). No app bug was found.

### Phase 8 — #63 (refs #52, does not close it)
- Added a `start` script and `railpack.json`. The 2026-09-29 incident was reproduced locally with Railpack v0.40.1: master gave "vite static site"; this branch gave our build and start.
- `.railway/railway.ts` is a draft, scoped to `shiftsync-api` only. Railway reads it only through `railway config plan` / `apply`, never at deploy time.
- `docs/railway-deploy-procedure.md` covers pre-flight, the production procedure, a non-production proof of #52's "Done when" list, cutover and rollback, with cited Railway docs.
- VAPID: absent keys were already safe. Fixed:
  - a malformed key crashed the API at boot;
  - with only one key set, the server handed out an unusable public key;
  - an unhandled rejection in `notifyUser`.
- `npm run vapid:generate` prints a key pair to stdout only.

### Phase 9 — #69 (draft, base master)
- 13 of #42's 14 commits were cherry-picked with `-x`. One came out empty because master already has it.
- Conflicts:
  - `RotaBuilder.tsx`: kept the leave chip and master's `hit-44` overlap rule;
  - `NotificationBell.tsx` imports: kept both;
  - `MEMORY.md`: kept both;
  - touch-target gate: "Copy last week" now gets `hit-44`, and the department toggles get an allowlist entry.
- Both 2026-09-25 migrations are additive and keep their names. They apply cleanly out of order, and the drift check is clean.
- Against the auth chain, 3 files conflict: `e2e/golden-path.spec.ts` (same filename, different specs), the `AuditAction` enum tail, and `MEMORY.md`. Semantic overlap: #42's spec needs `nextEchoPhone()` and `/login` once the chain lands.
- Risks:
  - the leave-vs-shift rule is enforced only in app code (concurrent writes can both pass);
  - leave UI isn't covered by the touch-target spec;
  - the `@live` voice spec was not run.
