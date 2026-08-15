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
