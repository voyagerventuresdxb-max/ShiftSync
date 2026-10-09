# SHIFTSYNC DEV & DESIGN ENGINE RULES

## 1. FRONTEND DESIGN SYSTEM
- Avoid generic AI UI ("AI slop"). Use distinct, intentional, luxury visual choices.
- Palette: one warm black-and-gold palette (the onboarding wizard's), defined ONLY in `src/styles/tokens.css`.
  - Surfaces: warm near-black page `#0d0b09`, cards `#14110d`, raised `#1e1913`, highest `#29231c`.
  - Text: bone `#efeae0`; stone `#9a9184` for secondary and muted text.
  - Borders: bone hairlines.
  - Accent: champagne gold `#c9a66b` (hover `#d9b37a`, pressed `#ac8d58`).
  - Semantic colours stay inside the same warm family: clay-red danger, sage success, ochre warning, cream-gold info.
  - No blue or purple anywhere.
- Never hard-code a colour.
  - Use the tokens: Tailwind classes such as `bg-surface`, `text-muted-foreground` and `border-border`, or `var(--token)`.
  - Canvas code reads tokens at runtime through `src/lib/cssToken.ts`.
  - `scripts/palette.mjs` runs in `npm run build` and `npm test`. It fails on any colour literal outside `tokens.css`; the few exceptions, each with its reason, are in `scripts/palette-allowlist.json`. It also fails on any token outside the measured OKLCH ranges: neutrals hue 60–95, chroma ≤ 0.03; gold hue 74–92, chroma 0.05–0.10. Evidence: `docs/color-evidence.md`.
- Zero-eye-strain dark mode:
  - warm dark surfaces, with elevation over shadows;
  - bone off-white text and muted, desaturated accents;
  - WCAG AA for every text pair (`scripts/palette-contrast.test.mjs`);
  - opacity-based text hierarchy;
  - a light-mode toggle for accessibility. It is not built yet; if added, it is a second set of values in `tokens.css`.
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
- **Local Ollama Offloading:** When asked to generate unit tests, docstrings/JSDoc, boilerplate types, or single-file refactors, automatically run local Ollama via:
  `npm run local -- <tests|docs|refactor> "<file path>" [instructions]`

## 5. PRODUCT CONTEXT (SHIFTSYNC)
- ShiftSync is a web app for Dubai/GCC hospitality shift scheduling: "WhatsApp-to-App" parsing, AI voice, legal-compliance tracking (UAE MOHRE), and service-charge pools.
- Core wedge: frictionless parser (WhatsApp/Excel/screenshot → clean digital roster in <10s), one-click revocable live share links, and an automated compliance audit trail.
- Build the backend as a configurable, rules-driven engine (compliance rules, credentials, attendance modes as data) for future retail/healthcare/fitness expansion.
- See `SHIFTSYNC_PRD.md` for the full product requirements.

## 6. PARALLEL-WORKTREE DEV ENVIRONMENT
Multiple git worktrees running in parallel is the normal working pattern for this repo, not a one-off. Two incidents (a migration in one branch's worktree silently dropping a column another branch depended on, twice) happened because worktrees used to share state that should be per-branch. That's fixed structurally, not by convention — every worktree, new or existing, MUST have all three of the following before real work starts in it:
- **Its own Postgres schema**, auto-selected by branch name — never touches `public` or another branch's schema. The database itself is the local Docker Postgres from `docker-compose.yml` (`npm run db:setup` starts it, migrates + seeds `public`, and bootstraps the branch schema — one command, no cloud auth, no tokens, no `.env` editing; `.env.example` ships the real local credentials). Do NOT pull `DATABASE_URL` from Vercel for local work — that's deployed-environment config only. Run any DB-touching command through `node scripts/with-branch-schema.mjs <command>` (already wired into `npm run prisma:migrate`/`prisma:generate`/`prisma:studio`/`server:dev`/`test:server`/`db:seed` — use those, don't call `npx prisma ...` bare). `db:setup` already runs `node scripts/bootstrap-branch-schema.mjs` for you; run it directly only if you need to re-bootstrap — it creates the schema, applies that branch's own migrations into it, and copies existing dev data in from `public` (read-only against `public`; prints every table/column that diverges between branches rather than silently reconciling it — read that output, don't ignore it).
- **Its own real `node_modules`** (`npm install`), never a symlink back to the main checkout. A shared `node_modules` means a shared generated `@prisma/client` — running `prisma generate` in one worktree silently repoints every other worktree's client at its schema until someone notices and regenerates. If you find a symlinked `node_modules` in an existing worktree, replace it with a real install before trusting anything in that worktree.
- **Its own `GEMINI_API_KEY`** in `.env`, not copied from another worktree's `.env`. The free tier is 20 requests/day shared per key — two worktrees sharing one key exhausts it for both, and voice-pipeline test failures from this look identical to `503`/`429 RESOURCE_EXHAUSTED` from the real quota, not a code defect. `.env` itself can't be read back by an agent in this repo (permission-denied by design) — write/edit is fine, reading isn't, so verify a key was actually set by asking the human partner or by a live call succeeding, never by re-reading the file.

**Never point a Prisma shadow database at a real schema.** Prisma RESETS whatever `--shadow-database-url` names (drops every object, then replays the migrations). Inside `with-branch-schema.mjs`, `$DATABASE_URL` *is* the branch's live schema, so `--shadow-database-url "$DATABASE_URL"` wipes that branch's dev data in one command — it happened on 2026-09-30. The wrapper now refuses it (exit 2, `REFUSED: ...`), refuses any shadow URL naming a non-`shadow_*` schema in the same database, and refuses `prisma migrate reset` / `db push --force-reset` unless you pass `--confirm-reset=<schema>` naming the schema it will wipe. To check that migrations match `schema.prisma`, run `npm run prisma:check-drift` (disposable `shadow_<branch>` schema, dropped afterwards). The guard is unit-tested in `scripts/with-branch-schema.test.mjs`; it only covers commands run through the wrapper, so bare `npx prisma` against a live URL is still on you.

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
