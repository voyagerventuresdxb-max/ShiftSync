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

**Verdict: not quite — one blocker-class product gap and one deployment unknown stand
between this and "submit".** The onboarding flow, including the roster upload the founder
hit, works end to end on both viewports. Five real bugs were found and fixed, each on its
own PR. Two things need the founder's decision before this is honestly "ready": a venue
that skips the roster upload can never create a shift (no way to create a Role), and the
repo contains nothing that deploys the API, so whether the Vercel site has a working
backend at all could not be verified from here.

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
| 2.2.9 | **A venue that skipped the roster upload can never create a shift** | **DECIDE (blocker-class)** | The only code path that ever creates a `Role` is roster-confirm (`server/src/routes/schedules.ts:520`). With no upload there are no roles, the Staff Directory can't assign one (job title only; `roleId` is read-only), and the rota builder's New-shift sheet says "No roles found — assign roles to staff in the Staff Directory first", pointing at a control that doesn't exist. The Shift Editor needs a `roleId` too. A minimal role picker/creator in the directory, or seeding the canonical roles at signup, are both small — but which one is a product call. The click-through worked around it by inserting a role directly in the DB. |
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
| 2.3.9 | STAFF can edit and delete any announcement in their venue | **DECIDE (medium)** | PATCH/DELETE are session + venue-scoped only; the UI shows edit/delete controls to staff on "Broadcast · one-way" posts. Almost certainly not intended, but the route comments say "any signed-in user can post" was deliberate, so this needs a decision (author-only? manager-only?). |
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

## PRs opened (all unmerged — merging is your call)

| PR | Fix | Severity |
|---|---|---|
| [#31](https://github.com/voyagerventuresdxb-max/ShiftSync/pull/31) | Onboarding: Roster keeps the uploaded file on Back from Review / reload | medium |
| [#32](https://github.com/voyagerventuresdxb-max/ShiftSync/pull/32) | Onboarding: Venue name input no longer collapses after the first keystroke | medium |
| [#33](https://github.com/voyagerventuresdxb-max/ShiftSync/pull/33) | Scheduling: STAFF Personal Rota defaults to the signed-in user | medium |
| [#34](https://github.com/voyagerventuresdxb-max/ShiftSync/pull/34) | People: StaffDirectory no longer sets parent state during its own render | low |
| [#35](https://github.com/voyagerventuresdxb-max/ShiftSync/pull/35) | Announcements/shoutouts: author is the session user, not the "Viewing" employee | medium |
| [#30](https://github.com/voyagerventuresdxb-max/ShiftSync/pull/30) | (earlier tonight) xlsx → exceljs migration + parser robustness audit | — |

Each PR carries a regression test that was confirmed to fail without its fix. The
review's own click-through specs (`e2e/mvp-review-part1-upload-click.spec.ts` — kept as a
permanent regression test for the founder's bug; `e2e/mvp-review-part2-*.spec.ts` —
opt-in audit scripts, run with `MVP_AUDIT=1`) and this report are on
`chore/mvp-readiness-review`.

## Decisions needed before "ready"

1. **Roles for venues that skip the roster (2.2.9).** Pick one: seed the 9 canonical roles at
   signup, add a role picker to the Staff Directory, or make the rota builder's role field
   free-text-with-create. Without one of these, "skip roster → add staff → build rota" is a
   dead end.
2. **Production API hosting (3.5).** Confirm where the Express server runs for the Vercel
   site, and redeploy Production from current master (it is a week and 7 commits stale).
3. **Who may edit/delete announcements (2.3.9)** and **who counts as a cover candidate (2.3.8).**
4. **Voice end-to-end (2.4.1)** needs a live Gemini key on a real device before it is
   demoed as working; the execute paths are unit-verified, the listening path is not.

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
