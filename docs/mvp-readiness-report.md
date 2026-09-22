# MVP readiness report — 2026-09-22

**Scope.** Everything a manager or staff member touches, from the Welcome intro to the
core scheduling loop, driven through the real UI with Playwright (real clicks, real file
picker, real uploads through the upload control — no API shortcuts on the positive
paths), against a fresh, isolated local Postgres schema, at both a desktop viewport
(1440×900, which renders the onboarding phone frame) and a phone viewport (390×844).
Master at `5364952` (`fix(parsing): stop findHeaderRows mistaking data rows for the
header (#22) (#27)`). No production system was touched; the only external calls were
read-only GitHub API reads and two HTTP GETs to Vercel URLs that both answered with an
SSO redirect.

**Final call (2026-09-22, end of session):**

- **App: GO** on merged `master` (`33408ba`). #37, #38 and #39 are merged; the fix PRs
  #31–#35 are still open and should be merged before the pitch. The onboarding flow,
  including the roster upload the founder hit, works end to end on both viewports; the
  one blocker-class product gap (no way to create a Role without a roster upload) is
  closed by #38; the announcement permission model is decided and enforced by #37.
- **Live production URL: NO-GO until three things happen, in this order** — none of
  them possible from the repo alone (see "Web deployment — final state" below): the
  Railway API host URL is provided and its `/api/health` verified; `vercel.json` gets that
  host; the Vercel Production Branch is flipped to `master`. Until then the production
  URL returns `404 DEPLOYMENT_NOT_FOUND` — **it has never been live**. Demo from a
  controlled environment (docker Postgres + `npm run dev:all`, which is exactly what this
  review verified) unless the three steps are completed and re-verified first.
- **Native app: NONE EXISTS.** No Capacitor project in any branch; this machine cannot
  build one (Windows, no Xcode/Android SDK). `docs/capacitor-setup.md` is the exact guide
  for doing it on a machine that can.
- **Demo-only settings — must be reverted after MBRIF:** `ALLOW_DEV_OTP_ECHO=true` on the
  Railway API (shows the real one-time code on screen — anyone with the URL can log in
  as any phone number while it is on), and the production URL itself while that flag is
  set. Remove the variable and redeploy the API immediately after the pitch; treat the
  URL as private until then.

---

## Go / no-go checklist

Legend: **PASS** verified working · **FIXED** bug found and fixed on its own PR (unmerged) ·
**FAIL** open problem · **DECIDE** needs a product decision · **UNVERIFIED** could not be
tested in this environment.

### Part 1 — the founder's bug: roster upload button in onboarding

| # | Item | Status | Detail |
|---|---|---|---|
| 1.1 | Tapping the "Upload your roster" zone opens the OS file picker | **PASS** | Real click → `filechooser` event → file set → upload → parse → Review. Desktop and phone. New spec `e2e/mvp-review-part1-upload-click.spec.ts` (the existing suite only drove the hidden `<input>` directly, which never exercised the click wiring). |
| 1.2 | Keyboard activation (Enter on the focused zone) | **PASS** | Same spec. |
| 1.3 | A real `.xlsx` uploads, parses and displays correctly in Review | **PASS** | `sample-roster.xlsx` → "3 staff found · 3 need your review", correct names/roles/times. Screenshots in the run. |
| 1.4 | A bad file (text saved as `.xlsx`) fails loud in the zone, Continue stays disabled | **PASS** | Zone subtitle shows the server's message ("No valid shift rows could be parsed from this file."). |
| 1.5 | No JS/page errors during the flow | **PASS** | Console/page-error listener attached for the whole flow. |
| 1.6 | Back from Review (or reload on Roster) keeps the attached file | **FIXED** | On master the zone went blank and Continue disabled — a needless re-upload. **PR #31.** |
| 1.7 | Root cause of what the founder saw last week | **UNVERIFIED** | The button works on master in a normal browser. Two plausible explanations, neither provable from here: (a) MEMORY.md (2026-09-16) records the exact symptom being caused by the Playwright-MCP-controlled Chrome window swallowing file-chooser events — a real browser is needed for manual file-picker QA; (b) the deployment gap in 3.5 below: if the Vercel site has no API behind `/api`, the upload (and every other API call, including signup OTP) fails there. |

### Part 2.1 — onboarding walkthrough (every screen, both viewports)

| # | Item | Status | Detail |
|---|---|---|---|
| 2.1.1 | Welcome intro: hold → reveal → carousel → "Let's set up your venue" → Continue | **PASS** | Via `passWelcomeIntro`. |
| 2.1.2 | Account: phone → OTP → name + venue → session minted → Venue | **PASS** | |
| 2.1.3 | Account: 409 on an already-registered phone → "You're already here." → Log in link → login works → lands on Venue | **PASS** | Login via `/join?mode=login&returnTo=/onboarding/venue` verified end to end. |
| 2.1.4 | Venue: name summary shows the Account-collected name; Rename reveals the prefilled input; blur collapses; persists on Continue with type + city | **PASS** | Persisted `name`/`venueType`/`emirate` checked in the DB. |
| 2.1.5 | Venue: clear the name, then type a new one | **FIXED** | The empty-name fallback input was not an edit session: the first keystroke made the name non-empty and swapped the input for the summary mid-typing — one-letter venue names. **PR #32.** |
| 2.1.6 | Venue: Continue gated until city and type are picked; sections stepper and "Set up later" | **PASS** | |
| 2.1.7 | Venue: Back → Welcome → intro Continue → back on Venue (signed in) | **PASS** | |
| 2.1.8 | Roster: Skip → Invite directly (Review skipped); Back from Invite → Review "Nothing to review yet" → Back → Roster | **PASS** | |
| 2.1.9 | Review: flagged rows gate Confirm; "Flagged only" filter; Remove drops a person; custom role via "+ Custom"; Looks right/Done; Confirm persists the right shifts | **PASS** | DB checked: shifts belong to the venue, removed person has none, custom `Role` "Sommelier" created. |
| 2.1.10 | Invite: join link + Copy → "Copied"; QR renders; "invite someone individually" lists the owner | **PASS** | WhatsApp share/direct-invite deep links are covered by the existing `onboarding.spec.ts` (aborted before the network). |
| 2.1.11 | Invite: Finish → "You're set up." → dashboard with the venue name in the shell | **PASS** | |
| 2.1.12 | Invite: Skip — invite later → "Your room, your pace." → dashboard | **PASS** | |
| 2.1.13 | Phone-frame stage (desktop) and full-bleed (phone) render correctly on every screen | **PASS** | Screenshots reviewed for Account, Venue, Roster (empty/bad-file/ready), Review, Invite, Done at both viewports. |

### Part 2.2 — manager core loop

| # | Item | Status | Detail |
|---|---|---|---|
| 2.2.1 | Dashboard renders (POS banner, Announcements, Shoutouts, Approvals, Floor Feedback) | **PASS** | Both viewports. |
| 2.2.2 | Announcements: post, edit (shows "edited"), delete | **PASS** | |
| 2.2.3 | Announcement/shoutout author attribution | **FIXED** | Author came from the request body, which the client filled from its "Viewing" employee (or nothing on a fresh venue); author-less rows then rendered under the *reader's* name — a staff member saw the manager's announcement as posted by themselves. Server now attributes to the session user. **PR #35.** |
| 2.2.4 | Staff Directory: add a member with a job title; inline edit persists | **PASS** | |
| 2.2.5 | Staff Directory: React "setState during render" warning on every add/edit | **FIXED** | `onChanged` was called inside a `setStaff` updater. **PR #34.** |
| 2.2.6 | Staff Directory list refreshes after approving a join request on the same page | **FAIL (low)** | The new member only appears after a reload. Not fixed — cosmetic, and the two panels don't share state today. |
| 2.2.7 | Pending Approvals: a real join request appears; Approve creates an active STAFF user | **PASS** | |
| 2.2.8 | Rota builder: add a shift (role, times, briefing note) → draft chip → Publish & notify → "Published · locked"; DB status PUBLISHED | **PASS** | |
| 2.2.9 | **A venue that skipped the roster upload can never create a shift** | **FIXED (blocker-class → closed by #38)** | First pass: the only code path that ever created a `Role` was roster-confirm (`server/src/routes/schedules.ts:520`); with no upload there were no roles, the Staff Directory couldn't assign one, and the rota builder's New-shift sheet pointed at a Staff Directory control that didn't exist. **#38** seeds a default, fully editable role set at signup (`shared/defaultRoles.ts`), adds a Roles API (create / rename / remove-with-no-orphaned-shifts), a Role column + Roles panel in the Staff Directory, and makes the rota builder and Shift Editor list the venue's roles. Verified by `e2e/zero-setup-scheduling.spec.ts`: fresh signup → shift created with zero roster upload → rename/remove/add stay in sync with the rota. See "Follow-up build" below. |
| 2.2.10 | Personal Rota (manager viewing a staff member): shift, briefing, Confirmed badge | **PASS** | |
| 2.2.11 | Hours tracking: clock in / clock out on the viewed employee; attendance log closed | **PASS** | |
| 2.2.12 | Swap approval: pending request shows requester, shift, proposed cover; Approve → "Approved · shift reassigned"; shift's `userId` reassigned; requester's My Shifts no longer lists it | **PASS** | The panel flips optimistically before the write lands (~1 s); the DB catches up. |
| 2.2.13 | Shoutout: pick colleague → pick shift → note → appears in feed | **PASS** | |
| 2.2.14 | Profile → Sign out → gated pages redirect to login | **PASS** | |

### Part 2.3 — staff-side experience

| # | Item | Status | Detail |
|---|---|---|---|
| 2.3.1 | Join via the real invite link (`/join?location=…`): phone → OTP → name → "submitted for review" | **PASS** | |
| 2.3.2 | Login as STAFF after approval → redirect to `/my-shifts`; "Welcome back, <name>"; upcoming shift listed | **PASS** | |
| 2.3.3 | Availability strip: unmarked → unavailable → preferred off | **PASS** | |
| 2.3.4 | Announcements visible on My Shifts | **PASS** | (see 2.2.3 for the attribution fix) |
| 2.3.5 | `/schedule` and `/onboarding` bounce STAFF to `/my-shifts`; `/people` renders read-only (no Pending Approvals, no add form, plain rows); no "Shift editor" link on Scheduling | **PASS** | |
| 2.3.6 | `/scheduling` for STAFF opens on **their own** rota | **FIXED** | The "Viewing" dropdown defaulted to the first roster entry, so staff landed on a colleague's rota with a Request-cover button that could only 404. **PR #33.** Residual: a staff member with no shift this week is not on the roster at all and still falls back to a colleague. |
| 2.3.7 | Request cover: pick a colleague → Send → "Cover request sent"; card shows "Swap pending" | **PASS** | |
| 2.3.8 | Request cover is only offered when another colleague also has a shift that week | **DECIDE (medium)** | Cover candidates come from the week's roster, not the Staff Directory — a staff member scheduled alone that week has no way to ask for cover. Not changed: whether candidates should be "anyone active at the venue" is a product call (it also affects who a manager can propose). |
| 2.3.9 | STAFF can edit and delete any announcement in their venue | **DECIDED + FIXED (#37)** | First pass: PATCH/DELETE were session + venue-scoped only, and the UI showed edit/delete controls to staff. Decided policy (deliberately more permissive than 7shifts, where employees are read-only): **anyone signed in may post; only MANAGER/OWNER may edit or delete, with no author exception; managers stay venue-scoped.** **#37** enforces this server-side (announcements PATCH/DELETE + a new manager-only shoutout DELETE) and hides the controls from staff. See "Follow-up build" below. |
| 2.3.10 | Staff-side times render in the browser's locale/timezone (12h `05:00 PM–11:00 PM`), manager side is 24h `17:00 – 23:00` | **FAIL (low)** | `MyShiftsRoute` uses `toLocaleTimeString` with no venue timezone — a staff phone set to another zone shows the wrong wall-clock time. Not fixed this pass. |

### Part 2.4 — AI voice layer

| # | Item | Status | Detail |
|---|---|---|---|
| 2.4.1 | CREATE_SHIFT / EDIT_SHIFT / ASSIGN_SECTION / QUERY_MY_SCHEDULE execute correctly end to end | **UNVERIFIED (partial)** | The **execute** half is covered by the server suite (`voice.test.ts`: CREATE_SHIFT creates a real Shift + audit row, EDIT_SHIFT updates only the given field, ASSIGN_SECTION creates a real SectionAssignment, QUERY_MY_SCHEDULE resolves and logs ANSWERED) and passed in the master run. The **transcribe → parse-intent** half needs a live Gemini key, which this review worktree deliberately does not have (per AGENTS.md each worktree needs its own key and the free tier is 20 req/day); the mic capture cannot be driven headlessly either. Not claiming this as tested. |

### Part 3 — integration sweep

| # | Item | Status | Detail |
|---|---|---|---|
| 3.1 | Full existing suite on master `5364952`: typecheck ×2, lint, build, `npm test`, `test:server` | **PASS** | typecheck clean · lint 0 errors / 16 pre-existing warnings · build OK · unit 52/52 · server 262/263 (1 skip: Docling sidecar not running). |
| 3.2 | Tonight's fixes together on master: parser structural gate (#27), tenant isolation (#25), e2e flake fix (#26), local Postgres (#24) | **PASS** | All exercised by the click-throughs above on the same schema: roster upload parses through the new header gate; venue B could not read, edit, delete, or shout into venue A's feed while A's own edit still worked (`tenant isolation` scenario); the venue-name check that #26 de-flaked ran 10+ times without a strict-mode collision; everything ran on the docker Postgres via per-branch schemas. |
| 3.3 | Venue-name summary UI still renders correctly alongside the other frontend changes | **PASS** (+ **FIXED** 2.1.5) | Renders and persists; the one defect found is the clear-then-type collapse, fixed in #32. |
| 3.4 | xlsx → exceljs migration (**PR #30, still unmerged**) | **PASS on its branch** | Not on master, so not part of this master click-through. Its own PR run: full suite green, parser robustness audit in `docs/parser-robustness-audit.md`. The upload click-through here ran against master's SheetJS path. Recommend merging #30 and re-running `e2e/mvp-review-part1-upload-click.spec.ts` before submission. |
| 3.5 | **Where does the API run in production?** | **DECIDE / UNVERIFIED (critical)** | The frontend calls relative `/api/...`; locally Vite proxies that to `localhost:4000`. The repo has **no** `vercel.json`, no `api/` serverless directory, no rewrite, and no other deploy config for the Express server. GitHub shows 29 Vercel *Preview* deployments and **one Production deployment, from `1a8220e` on 2026-09-15 — 7 commits behind master, before every fix listed in this report**. Every deployment URL answers with a Vercel SSO redirect, so `/api/health` could not be probed. If production is a static Vite build with nothing behind `/api`, nothing in this app works there — which would also fully explain "the upload button doesn't work". This must be confirmed by whoever owns the Vercel project before any demo. |
| 3.6 | All five fix PRs merged together on top of master | **see below** | Results of the combined run are in the "Integration run" section. |

---

## PRs opened (#37, #38, #39 merged on 2026-09-22; #30–#35 still open — merging those is your call)

| PR | Fix | Severity |
|---|---|---|
| [#31](https://github.com/voyagerventuresdxb-max/ShiftSync/pull/31) | Onboarding: Roster keeps the uploaded file on Back from Review / reload | medium |
| [#32](https://github.com/voyagerventuresdxb-max/ShiftSync/pull/32) | Onboarding: Venue name input no longer collapses after the first keystroke | medium |
| [#33](https://github.com/voyagerventuresdxb-max/ShiftSync/pull/33) | Scheduling: STAFF Personal Rota defaults to the signed-in user | medium |
| [#34](https://github.com/voyagerventuresdxb-max/ShiftSync/pull/34) | People: StaffDirectory no longer sets parent state during its own render | low |
| [#35](https://github.com/voyagerventuresdxb-max/ShiftSync/pull/35) | Announcements/shoutouts: author is the session user, not the "Viewing" employee | medium |
| [#37](https://github.com/voyagerventuresdxb-max/ShiftSync/pull/37) | Announcements/shoutouts permission model: anyone posts, only managers edit/delete (no author exception), venue-scoped | feature (closes 2.3.9) |
| [#38](https://github.com/voyagerventuresdxb-max/ShiftSync/pull/38) | Zero-setup scheduling: default roles at signup + Roles API + Staff Directory role control + rota-builder/Shift-Editor sync | feature (closes 2.2.9) |
| [#39](https://github.com/voyagerventuresdxb-max/ShiftSync/pull/39) | Deployment: `vercel.json` rewrites to the Railway API, `railway.json`, `server:start` (migrate deploy + tsx), regenerated lockfile, `docs/deployment.md` — **merged** | infra (closes 3.5 once Railway is live) |
| [#30](https://github.com/voyagerventuresdxb-max/ShiftSync/pull/30) | (earlier tonight) xlsx → exceljs migration + parser robustness audit | — |

Each PR carries a regression test that was confirmed to fail without its fix. The
review's own click-through specs (`e2e/mvp-review-part1-upload-click.spec.ts` — kept as a
permanent regression test for the founder's bug; `e2e/mvp-review-part2-*.spec.ts` —
opt-in audit scripts, run with `MVP_AUDIT=1`) and this report are on
`chore/mvp-readiness-review`.

## Decisions needed before "ready"

1. ~~**Roles for venues that skip the roster (2.2.9).**~~ **Done — #38** seeds default roles at
   signup and adds the Staff Directory role control. Merge order note: #38 is independent of
   #31–#35, but its e2e spec temporarily excludes the React warning that #34 fixes.
2. ~~**Production API hosting (3.5).**~~ **Decided — Railway for the API, Vercel keeps the
   frontend (#39, merged).** Remaining steps are on the founder's side; see "Web
   deployment — final state".
3. ~~**Who may edit/delete announcements (2.3.9)**~~ **Decided and enforced — #37** (anyone
   posts, managers moderate, no author exception). **Who counts as a cover candidate (2.3.8)**
   is still open.
4. **Voice end-to-end (2.4.1)** needs a live Gemini key on a real device before it is
   demoed as working; the execute paths are unit-verified, the listening path is not.

## Follow-up build (same night): the two gaps turned into features

Both built after the first pass, each on its own PR, each verified against local Postgres
with a clean run before being opened. Neither is merged.

### #38 — Zero-setup scheduling (closes 2.2.9)

Positioning: 7shifts requires an admin to build Locations → Departments → Roles by hand
before any shift can be scheduled. ShiftSync now seeds a default, fully editable role set
at signup, so a brand-new venue builds its first rota the moment onboarding ends — with or
without a roster upload.

| Check | Result |
|---|---|
| Signup seeds `Waiter, Head Waiter, Bartender, Host, Chef, Runner, Supervisor, Management` as active `Role` rows (canonical spellings, so a later roster upload matches them instead of duplicating) | **PASS** — `signup.test.ts` |
| Roles API: create (dup → 409, re-adding a removed name reactivates the same row), rename (staff + shifts follow), remove (deactivate: staff unassigned, existing shifts keep the role, hidden from `GET /api/roles`, new shift on it → 404, assigning it → 404) | **PASS** — `roles.test.ts` |
| Permissions: STAFF create/rename/remove → 403; cross-venue manager rename/remove → 404; cross-venue role assignment → 404 | **PASS** — `roles.test.ts` |
| Staff Directory `roleId` assign / clear / foreign role → 404 | **PASS** — `staffDirectory.test.ts` |
| **Playwright click-through**: fresh signup → skip roster → defaults visible in the directory's Roles panel → assign Bartender to the owner → rename to Mixologist (owner's row follows without reload) → rota builder offers Mixologist, not Bartender → **shift created with zero roster upload** → remove Mixologist (owner unassigned) + add Sommelier → rota builder: existing shift intact and still labelled, Mixologist no longer offered, Sommelier is | **PASS** — `e2e/zero-setup-scheduling.spec.ts` |
| Existing suites | `npm test` 52/52 · `test:server` 265/266 (Docling skip) · `onboarding` + `review-persistence` specs pass (roster confirm now matches seeded roles instead of creating them) · typecheck ×2 · lint |

Residual: the Shift Editor (`/schedule`) and rota builder both list the venue's roles now;
a removed role stays selectable only on the shift that already has it.

### #37 — Announcement / shoutout permission model (closes 2.3.9)

Policy, deliberately more permissive than 7shifts (employees read-only there): **any
authenticated user posts in their own venue; only MANAGER/OWNER edit or delete, with no
author exception; managers stay venue-scoped.**

| Check | Result |
|---|---|
| STAFF can create an announcement / a shoutout (201) | **PASS** |
| STAFF editing or deleting their **own** announcement → 403, row untouched; STAFF deleting their own shoutout → 403 | **PASS** |
| Own-venue manager edits (200) and deletes (204) a STAFF-authored announcement; deletes a STAFF-authored shoutout (204) | **PASS** |
| Manager from another venue editing/deleting → 404, row untouched (tenant-isolation regression check) | **PASS** |
| UI: edit/delete controls render only for a manager/owner session (server enforces regardless); Shoutouts gains a manager-only Delete | **PASS** (existing core-loop click-through still green) |
| Suites | announcements + shoutouts + voice + communicationActions 59/59; new tests fail without the route change · typecheck ×2 · lint |

Note: shoutouts had no removal route at all before; #37 adds manager-only `DELETE`. No
edit route for shoutouts — a wrong one is removed and re-posted.

## Web deployment — final state

What was actually established, using the owner's already-logged-in Vercel CLI (read-only
inspection) plus HTTP GETs:

| Fact | Evidence |
|---|---|
| **The production URL has never been live.** `https://shift-sync-shift-sync1.vercel.app` (the project's "Latest Production URL") returns `404 DEPLOYMENT_NOT_FOUND`. | `curl`; `vercel ls --prod` shows exactly one Production deployment, status **Canceled** ("Canceled from the Vercel Dashboard"), `1a8220e`, 2026-09-15. |
| Every push to `master` builds successfully but as a **preview** (`target: preview`, alias `shift-sync-git-master-…`). | `vercel inspect` on the latest master deployment. So the project's Production Branch is not `master`; no build failure is involved. |
| The Vercel project deployed the **frontend only**: `tsc -b && vite build` → `dist/`. No serverless function, no `vercel.json`, no `DATABASE_URL`/`GEMINI_API_KEY` in the project env (only `UPLOAD_CACHE_FILE`, `VAPID_*`). The Express API was never hosted anywhere. | Build log of the latest master deployment; `vercel env ls production`. This is why every `/api` call on any Vercel URL fails — and the most likely cause of what the founder saw last week. |
| Previews sit behind Vercel Deployment Protection (SSO redirect). Not touched, per instruction. | Every preview URL → `302` to `vercel.com/sso-api`. |

Decision taken (founder, with full tradeoffs): **Railway hosts the Express API, Vercel keeps
the static frontend**, `/api/*` and `/uploads/*` rewritten to Railway (**#39, merged**).
Sequencing, per the founder: API first, verify it live, **then** flip Production Branch — so
the first thing that goes live is a working combination.

Verified so far:

- `npm run server:start` (`prisma migrate deploy && tsx server/src/index.ts`) applies the
  migration history and answers `/api/health` in ~4 s (local, through the branch-schema wrapper).
- `master` with the new `vercel.json` builds and deploys cleanly on Vercel (preview, `Ready`).
- The regenerated lockfile passes the dependency check the old one failed.

**Still pending on the founder's side (nothing further can be verified without them):**

1. Create the Railway service from the repo (`master`, root `/`), add Railway Postgres, set
   `DATABASE_URL`, `FRONTEND_ORIGIN=https://shift-sync-shift-sync1.vercel.app`,
   `GEMINI_API_KEY`, `ALLOW_DEV_OTP_ECHO=true` (demo only), generate a domain — and **send
   the `https://<service>.up.railway.app` host**. Two messages so far carried only the
   literal placeholder text, so `vercel.json` still contains `RAILWAY_API_HOST`.
2. Then: `/api/health` on the Railway domain → a full live signup against it (real OTP echo,
   real venue/owner rows) → patch the host into `vercel.json` on `master`.
3. Then: Vercel Settings → Git → Production Branch = `master` (dashboard-only).
4. Then: production URL end to end — `/api/health` through the rewrite, a live signup
   through the Vercel URL, and a deep-link reload (`/onboarding/venue`) to prove the SPA
   fallback, not just the root path.

Only after step 4 passes should the live URL be shown at MBRIF; until then, demo locally.

### Native app (Capacitor) — final state

- **No native app exists.** Searched every branch and worktree: no `capacitor.config.*`,
  no `ios/` / `android/`, no `@capacitor/*` dependency. The only "capacitor" strings in the
  repo are inside vendored lockfiles under `.ai/skills/`.
- **This machine cannot build one.** Windows host; no Xcode (macOS-only), no Android
  Studio, no Android SDK (`ANDROID_HOME` unset, no SDK directory), no JDK, no Gradle. Per
  the agreed rule, no build was attempted.
- **What was produced instead:** `docs/capacitor-setup.md` — the exact setup for a machine
  with the toolchains: install `@capacitor/core|cli|ios|android`, `cap init`, the
  `capacitor.config.ts` to use, `cap add ios/android`, `cap sync`, the native permissions
  the app needs (microphone for voice, camera/photo for roster photos), first-run checks,
  and the one design decision — for MBRIF, a thin wrapper that loads the deployed site
  (`server.url`), because the web app uses relative `/api` URLs; bundling `dist/` needs a
  `VITE_API_BASE_URL` change across `src/api/*` first. Two known native caveats are called
  out: WebView microphone permission bridging (test on a real device first), and web push
  not working inside a WebView.
- **Prerequisite:** the production web deployment must be live before the thin-wrapper
  app has anything to load.

## What was not covered

- Floor Plan page and section assignment UI (beyond the voice execute test).
- Policy documents, notification settings, floor feedback — rendered, not driven
  (policy documents have their own existing spec).
- Image / scanned-PDF roster ingestion (Gemini vision path) — needs a key and a weekly
  quota; the deterministic Excel/CSV/PDF-text path is what was tested.
- Push notifications (VAPID keys not set in this environment).

## Integration run (all five fixes merged onto master)

A throwaway local branch with #31–#35 merged onto master `5364952` (no conflicts), fresh
branch schema:

| Check | Result |
|---|---|
| `npm run typecheck` / `server:typecheck` | clean |
| `npm run lint` | 0 errors (pre-existing warnings only) |
| `npm run build` | OK |
| `npm test` | 57/57 (52 + 5 new) |
| `npm run test:server` | 265 tests: 264 pass, 0 fail, 1 skip (Docling sidecar) — includes the 2 new author-attribution tests |
| Playwright: existing 6 specs + `venue-name-rename`, `staff-directory`, `mvp-review-part1-upload-click` | 13/13 |
| Audit scenario: manager → staff → swap → approval → hours → shoutout (desktop), incl. the console-error check | pass ("staff Personal Rota defaulted to self: true") |
| Audit scenario: tenant isolation (venue B vs venue A) | pass |

Nothing regressed between the fixes, and the click-throughs that failed on master for
each bug pass with all five together.

## How to re-run this review

```
npm run db:setup                                   # once per worktree
npm run test:e2e                                   # existing suite + the real-click upload spec
MVP_AUDIT=1 npx playwright test e2e/mvp-review-part2-onboarding.spec.ts   # every onboarding screen, both viewports (~9 min)
MVP_AUDIT=1 npx playwright test e2e/mvp-review-part2-core-loop.spec.ts    # core loop + staff side + tenant isolation (~3 min)
```

Set `MVP_SHOTS_DIR=<folder>` to capture the screenshots reviewed above. The two Part 2
scripts seed a `Role` and one extra shift directly in the DB to get past the two product
gaps in 2.2.9 and 2.3.8 — those workarounds are commented at the point of use and should
be removed once the gaps are closed.
