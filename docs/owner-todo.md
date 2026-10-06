# Owner to-do

Only the steps that need you (accounts, sign-ins, phones, decisions), in the order to do them.
Everything else is done or tracked in [`launch-checklist.md`](launch-checklist.md). Written
2026-10-05; tick each item and add the date.

1. [ ] **Production web address is public.** On your phone (not signed in to Vercel), open
   `https://shift-sync-two-ashy.vercel.app`. It must show ShiftSync, not a Vercel login. If it asks
   for Vercel: Vercel → the `shift-sync` project → Settings → Deployment Protection → **Standard
   Protection** (previews stay protected). See [`deployment.md`](deployment.md) §3.
2. [ ] **Sign up on production** with your own number and real venue name (the onboarding wizard).
   You become the venue **owner**.
3. [ ] **Test AI connection:** Profile → **AI connection** → **Test AI connection**. Both lines
   must say *Working* (roster photo reading and voice commands, Vertex AI, `eu`). If one says
   *Not working*, the reason says what to fix ([`vlm-go-live.md`](vlm-go-live.md) §5).
4. [ ] **Roster photo test:** Scheduling → upload a photo of a printed roster with made-up names
   ([`vlm-go-live.md`](vlm-go-live.md) §6). Your venue may use AI roster reading up to 5 times in
   any 7 days.
5. [ ] **Voice test** on a real phone with [`voice-test-script.md`](voice-test-script.md): the
   first mic tap shows the notice, then run the table and fill in the results log.
6. [ ] **Google Billing check:** Google Cloud → Billing → Reports for the AI project: charges match
   what you tested, and the USD 5 budget alert exists ([`vlm-go-live.md`](vlm-go-live.md) §2).
7. [ ] **Delete the local copy of the Vertex key file** you downloaded when setting up Vertex,
   now that Railway holds it. Keep no copy on any laptop.
8. [ ] **Delete the old Gemini Developer API key** (Google AI Studio) that production voice used to
   need. Production no longer uses one: voice runs on Vertex. Keep only keys you still use for
   local development, one per worktree.
9. [ ] **Rota stack:** review #69 → #78 → #84 → #108–#111 with
   [`rota-review-guide.md`](rota-review-guide.md). When you're happy, set the switch
   `ROTA_STACK_APPROVED = YES` in the next run's prompt so it can merge and deploy them in order.
10. [ ] **Legal review** of the draft `/privacy` and `/terms` pages (retention, backups, the AI
    providers); then the DRAFT banner can come off ([`store-readiness.md`](store-readiness.md) §1–2).
11. [ ] **Decide on the older roster sample files in the repository history** (see "Fixture
    privacy" in `MEMORY.md`): leave them, or have the history rewritten. A rewrite changes every
    commit id and needs everyone to re-clone.
12. [ ] **Railway settings before 2026-12-01:** move the build and deploy settings off
    `railway.json` (#52), or the API deploys without a healthcheck after that date
    ([`railway-deploy-procedure.md`](railway-deploy-procedure.md) §3).
13. [ ] **Open pull requests waiting on you:** #91 (run-4 log: merge or close), #36 (MVP readiness
    report: its optional audit tests no longer match the app), #30 (superseded by the xlsx CDN
    pin), #42 (superseded by #69).
14. [ ] **Run 10 pull requests:** #124–#129, after tonight's test. Merge order and expected
    conflicts are in [`AUTONOMOUS_RUN.md`](AUTONOMOUS_RUN.md) (run 10). Before #127 deploys, check
    `AI_DAILY_CALL_LIMIT` in Railway: when unset it now means 150 calls a day, not unlimited.
15. [ ] **Run 10 security follow-ups** from the run 10 chat report, including one credential check
    left open since run 4.
