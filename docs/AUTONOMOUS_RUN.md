# Autonomous run — 2026-10-02

Orchestrated multi-phase run against `origin/master @ 32edfc5` (= production). Source of truth: gap audit of 2026-10-01. Each phase = own worktree + branch + PR; nothing merged, nothing deployed.

## Run setup (Phase 0)

- Worktrees (siblings of the main checkout, which was never edited): `C:\dev\ShiftSync-auto-{baseline,p1,p2,...,report}`. Each phase branch had its upstream unset so a bare `git push` can never target `master`.
- DB: local Docker `shiftsync-dev-postgres` (localhost:5432) via `npm run db:setup`; per-branch `dev_<branch>` schemas (AGENTS.md §6). No Supabase/Railway DB touched.
- e2e serialization: every worktree's Playwright config binds API :4000 and Vite :5173 with `reuseExistingServer`, and `server:dev` runs `kill-port 4000` — parallel e2e runs would kill/reuse each other's servers and test the wrong code. All e2e runs went through a lock wrapper (`e2e-run.mjs`: atomic mkdir lock at `C:\dev\.shiftsync-e2e.lock`, frees the ports, runs with `CI=1` so Playwright refuses to reuse a stray server).
- Not used: `npm run swarm` / `sparc` / `local` (AGENTS.md §4) — claude-flow MCP failed to connect at session start, and nested swarms are outside this run's scope rules.
- Stacking plan: P1 (security) is the base of the auth chain because its echo allowlist changes how every e2e spec obtains an OTP. Chain: P1 → P3 → P4 → P5 → P6 → P7. P2 and P8 are independent (base `master`). P9 only if 1–8 finish.

## Phase log

| Phase | Status | Branch | PR | Tests |
|---|---|---|---|---|
| 0 Setup | done | `chore/auto-baseline` (local only, removed after) | — | master @ 32edfc5: typecheck ✔, server:typecheck ✔, lint ✔ (0 errors), unit 62/62, server 283 pass / 0 fail / 1 skip (284), build ✔, e2e 20 passed + 1 flaky (policy-documents upload hit ENOSPC, passed on retry) |
| 1 Security | done | `feat/otp-echo-allowlist` (base master) | [#62](https://github.com/voyagerventuresdxb-max/ShiftSync/pull/62) | typecheck ✔ ×2, lint 0 errors (19 pre-existing warnings), unit 62/62, server 301 pass / 1 skip (302; 18 new incl. a real `index.ts` boot-refusal spawn), build ✔, e2e full 21/21 (0 flaky) |
| 2 Housekeeping | done | `chore/housekeeping-staff-phone` (base master) | [#61](https://github.com/voyagerventuresdxb-max/ShiftSync/pull/61) | typecheck ✔ ×2, lint 0 errors (19 pre-existing warnings), unit 62/62, server 284 pass / 1 skip (285), build ✔, e2e full 23/23 |
| 8 Deploy-safety prep | done | `chore/railway-config-as-code-vapid` (base master) | [#63](https://github.com/voyagerventuresdxb-max/ShiftSync/pull/63) | typecheck ✔ ×2, lint 0 errors (19 pre-existing warnings), unit 66/66, server 287 pass / 1 skip, build ✔, e2e full 21/21 |

### Phase 8 notes (deploy-safety prep — nothing deployed, no Railway/Vercel command run against any project)
- PR #63 "Refs #52" (does not close it). `railway.json` unchanged, so today's GitHub-source deploys behave exactly as before.
- Added `"start": "npm run server:start"` + `railpack.json` (build `npx prisma generate`, start `npm run server:start`). Reproduced the 2026-09-29 incident locally with Railpack v0.40.1 in Docker: master → "Deploying as vite static site"; this branch → our build/start. High confidence.
- `.railway/railway.ts`: DRAFT Infrastructure-as-Code for `shiftsync-api` only (named partial so an apply can't delete Postgres). Per Railway docs it is never read at deploy time — only by `railway config plan/apply`, run by a person. Typechecked against `railway@3.12.0` in a scratch dir (not a repo dependency). Medium confidence until tried on a non-prod environment.
- `docs/railway-deploy-procedure.md`: pre-flight env list, production procedure until #52 closes, non-production proof of #52's "Done when" list, cutover, rollback, and what the docs do/don't say (flags `railway redeploy --from-source` as undocumented — check `--help` before relying on it).
- VAPID: absent keys were already safe. Fixed real gaps: a malformed key / bad `VAPID_SUBJECT` crashed the API at boot (now push off + log line); one-key-only served an unusable public key (now empty); a DB error inside `notifyUser` could become an unhandled rejection (now caught). `npm run vapid:generate` prints a pair + instructions to stdout only.
- Discovered: `server/src/lib/prisma.ts` only uses `DATABASE_URL` verbatim when `NODE_ENV=production` (else it may derive a `dev_<branch>` schema), and Railpack's plan sets `NODE_ENV=production` — so production very likely already has `NODE_ENV=production`, i.e. PR #62's boot guard will be active on its first deploy.
- Risk: `npm start` (new) runs `prisma migrate deploy` + backfill against whatever `.env` points at, without the per-branch wrapper — same as `npm run server:start` already did. Don't run it locally.

### Phase 1 notes
- `server/src/lib/devOtpEcho.ts` (`devOtpEchoFor(e164)`, env read per call, list entries normalized with `toE164`) replaces the three per-route `DEV_OTP_ECHO` constants; unlisted numbers get neither `devCode` nor the plaintext log line.
- `server/src/lib/productionGuards.ts` `checkProductionEnv()` runs in `index.ts` before the app is built. Production = `NODE_ENV=production` **or** `RAILWAY_ENVIRONMENT_NAME=production`. Fatal: echo on with no valid allowlist entry; `ALLOW_DEV_OTP_BYPASS=true`; `ALLOW_DEV_ERROR_INJECTION=true`. File/export names deliberately match open PR #43's versions so the two converge; behavior is this run's decisions (allowlist, Railway signal, no FRONTEND_ORIGIN rule).
- e2e: `playwright.config.ts` builds a per-run 300-number `+97156…` pool passed as `ECHO_ALLOWED_PHONES`; `nextEchoPhone()` hands them out via a tmpdir counter so retried workers never reuse a number (OTP resend caps, unique `User.phone`).
- Known gaps: `.env.example` not updated (permission-denied to agents) — local devs must add `ECHO_ALLOWED_PHONES` or echo silently stops (startup warns). A refused boot happens after `prisma migrate deploy` has already run (migrations are additive, so harmless). Allowlisted numbers remain password-less in prod by design — keep the list to demo accounts.
- Observed once in e2e API log: `Inconsistent query result: Field user is required` in `resolveSession` during teardown (`cleanupTestOrgs` deleting users while a request is in flight). No test failed; pre-existing race, not chased.

### Phase 2 notes
- Closed #12, #13, #14, #15 with a comment citing #16 (each verified fixed on master first).
- `docs/Deferred.md`, `docs/Home.md`, `docs/CLAUDE_HANDOFF.md` copied verbatim from the main checkout (read-only); secret scan clean (agent + orchestrator regex pass).
- Add-staff phone: server already validated with `toE164` + P2002→409; the form just never sent it. Added the input and an up-front `findUserByPhone` 409 (covers deactivated / other-venue holders). Known: a mistyped phone on an active record lets that number's owner claim the account after OTP — inherent to phone-match claim.
- My Shifts signed-out button → `/join?mode=login&returnTo=%2Fmy-shifts` (Phase 3 redirects this to `/login`). AccountScreen's bare `/join` "Join instead" left as is (intentional "ask your manager for an invite" page).
- **Gap:** the repo `MEMORY.md` entry (AGENTS.md §3) was refused by the permission classifier; not retried. Human to add, or accept the PR body as the record.

### Phase 0 notes
- **Disk:** C: had ~7 GB free; the baseline e2e hit `ENOSPC` writing an upload. Each worktree's own `node_modules` (AGENTS.md §6 forbids symlinking) costs ~1 GB+. Mitigation: baseline worktree removed once green; npm cache (11.6 GB, regenerable) cleared once no install was running; each finished phase's worktree is removed after its PR exists (the branch stays on GitHub). Note for the human: 15+ older `C:\dev\ShiftSync-*` worktrees from earlier sessions each hold a `node_modules` — not touched, but they are where the disk went.
- **PR #43 / #44 base:** #44 (login links) is stacked on #43 (iOS hardening), and #43 branches from 7bad1f9 — before master's E.164 phone model (#59) and OTP caps (#56/#58). Literal rebase is not viable; Phase 6 ports #44's feature onto the auth chain with master's behavior winning, on a new branch (no force-push allowed, so #44's own branch is left untouched).
- **NODE_ENV:** comments in `identity.ts`/`join.ts`/`signup.ts` state nothing in this repo or its start command sets `NODE_ENV=production`. Phase 1 therefore also treats `RAILWAY_ENVIRONMENT_NAME=production` (injected by Railway) as production, so the boot guard can't be silently inert.
