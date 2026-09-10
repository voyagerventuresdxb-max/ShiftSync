# SHIFTSYNC DEV & DESIGN ENGINE RULES

## 1. FRONTEND DESIGN SYSTEM
- Avoid generic AI UI ("AI slop"). Use distinct, intentional, luxury visual choices.
- Target Palette: Dark Luxury Speakeasy (#0F0F12 background, charcoal card surfaces #1A1A22, soft gold typography #E5A93C).
- Zero-eye-strain dark mode: use dark-gray surfaces (#121212, #1E1E1E, #181818), off-white text (#E0E0E0), muted/desaturated accents, surface elevation over shadows, opacity-based text hierarchy (87/60/38%), and a light-mode toggle for accessibility.
- Use intentional spacing, high contrast, and smooth micro-interactions (e.g., dynamic glass filling, soft modal transitions).
- The roster is a live, interactive object, not a static export. Never render schedules as static images.

## 2. 4-PHASE SYSTEMATIC DEBUGGING
- Phase 1 (Root Cause Analysis): Trace error stacks back to fundamental component state before editing code.
- Phase 2 (Isolation): Verify whether errors stem from React component state, Vite/TypeScript build config, or missing data/parser inputs.
- Phase 3 (Minimal Fix): Write the smallest code modification required. Never rewrite full files if a 3-line patch works.
- Phase 4 (Verification): Ensure `npm run build` and `npm run typecheck` compile cleanly without silent runtime crashes.

## 3. AUTOMATIC MEMORY & STATE TRACKING
- **Self-Updating Memory:** After completing any major component, bug fix, or visual feature refactor, you MUST automatically update `MEMORY.md`.
- **Formatting Standard:** Update `MEMORY.md` by checking off completed tasks under `## Completed Core Components` and appending new architectural notes or upcoming goals under `## Next Sprint Goals`.
- **Zero Prompting Required:** Do not wait for the user to ask to update `MEMORY.md`. Treat maintaining `MEMORY.md` as an obligatory Phase 5 step of your coding workflow.

## 4. AUTONOMOUS TOOL EXECUTION TRIGGERS
- **Swarm Requests:** When asked to build complex, multi-file features or refactor modules, automatically run:
  `npm run swarm -- "<task instructions>"`
- **SPARC Workflows:** When asked to write tests, create architecture specs, or run TDD cycles, automatically run:
  `npm run sparc -- run code "<task instructions>"`
- **Research Requests:** When asked to lookup external documentation, Github repos, or API references, automatically run:
  `npm run reach -- "<query>"`
- **Local Ollama Offloading:** When asked to generate unit tests, docstrings/JSDoc, boilerplate types, or single-file refactors, automatically run local Ollama via:
  `npm run local -- <tests|docs|refactor> "<file path>" [instructions]`

## 5. PRODUCT CONTEXT (SHIFTSYNC)
- ShiftSync is a web app for Dubai/GCC hospitality shift scheduling: "WhatsApp-to-App" parsing, AI voice, legal-compliance tracking (UAE MOHRE), and service-charge pools.
- Core wedge: frictionless parser (WhatsApp/Excel/screenshot → clean digital roster in <10s), one-click revocable live share links, and an automated compliance audit trail.
- Build the backend as a configurable, rules-driven engine (compliance rules, credentials, attendance modes as data) for future retail/healthcare/fitness expansion.
- See `SHIFTSYNC_PRD.md` for the full product requirements.

## 6. PARALLEL-WORKTREE DEV ENVIRONMENT
Multiple git worktrees running in parallel is the normal working pattern for this repo, not a one-off. Two incidents (a migration in one branch's worktree silently dropping a column another branch depended on, twice) happened because worktrees used to share state that should be per-branch. That's fixed structurally, not by convention — every worktree, new or existing, MUST have all three of the following before real work starts in it:
- **Its own Postgres schema**, auto-selected by branch name — never touches `public` or another branch's schema. Run any DB-touching command through `node scripts/with-branch-schema.mjs <command>` (already wired into `npm run prisma:migrate`/`prisma:generate`/`prisma:studio`/`server:dev`/`test:server`/`db:seed` — use those, don't call `npx prisma ...` bare). First time in a new worktree: `node scripts/bootstrap-branch-schema.mjs` creates the schema, applies that branch's own migrations into it, and copies existing dev data in from `public` (read-only against `public`; prints every table/column that diverges between branches rather than silently reconciling it — read that output, don't ignore it).
- **Its own real `node_modules`** (`npm install`), never a symlink back to the main checkout. A shared `node_modules` means a shared generated `@prisma/client` — running `prisma generate` in one worktree silently repoints every other worktree's client at its schema until someone notices and regenerates. If you find a symlinked `node_modules` in an existing worktree, replace it with a real install before trusting anything in that worktree.
- **Its own `GEMINI_API_KEY`** in `.env`, not copied from another worktree's `.env`. The free tier is 20 requests/day shared per key — two worktrees sharing one key exhausts it for both, and voice-pipeline test failures from this look identical to `503`/`429 RESOURCE_EXHAUSTED` from the real quota, not a code defect. `.env` itself can't be read back by an agent in this repo (permission-denied by design) — write/edit is fine, reading isn't, so verify a key was actually set by asking the human partner or by a live call succeeding, never by re-reading the file.

`test:server` also caps its own connection pool (`connection_limit=1` via the same wrapper) — this repo's test suite opens 13-17+ separate `PrismaClient`s (one per file, none disconnect until the run ends) against a Supabase pooler capped at 15 real connections, which is a pre-existing fragility independent of per-branch schemas. A `PrismaClientInitializationError` mid-suite (vs. a real assertion failure) is this, not a regression — don't chase it as a code bug.

Respond terse like smart caveman. All technical substance stay. Only fluff die.

Rules:
- Drop: articles (a/an/the), filler (just/really/basically), pleasantries, hedging
- Fragments OK. Short synonyms. Technical terms exact. Code unchanged.
- Pattern: [thing] [action] [reason]. [next step].
- Not: "Sure! I'd be happy to help you with that."
- Yes: "Bug in auth middleware. Fix:"

Switch level: /caveman lite|full|ultra|wenyan-lite|wenyan-full|wenyan-ultra
Stop: "stop caveman" or "normal mode"

Auto-Clarity: drop caveman for security warnings, irreversible actions, user confused. Resume after.

Boundaries: code/commits/PRs written normal.
