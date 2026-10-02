# ShiftSync — Claude Code Handoff

You are now working on **ShiftSync**, a web app for Dubai/GCC hospitality shift scheduling: "WhatsApp-to-App" parsing, AI vision parsing, UAE MOHRE legal-compliance tracking, and service-charge pools. The core wedge is a frictionless roster parser (WhatsApp/Excel/screenshot → clean digital roster in <10s), one-click revocable live share links, and an automated compliance audit trail.

**Read these first:** `AGENTS.md` (dev/design rules — MUST follow), `MEMORY.md` (self-updating memory log — update it after every completed task), `SHIFTSYNC_PRD.md` (full product requirements).

---

## 1. How to run the app

```bash
npm run dev:all        # runs BOTH backend (port 4000) + frontend Vite (port 5173) via concurrently
npm run server:dev     # backend only: "kill-port 4000 && tsx watch server/src/index.ts"
npm run dev            # frontend only: vite
```

- **Backend** = Express + Prisma + PostgreSQL, entry `server/src/index.ts`, listens on port 4000.
- **Frontend** = React + Vite, entry `src/main.tsx` → `src/App.tsx`, port 5173. Vite proxies `/api` → `localhost:4000` (see `vite.config.ts`).
- `server:dev` auto-kills any zombie process on port 4000 via `kill-port` (fixes `EADDRINUSE`).
- **Env:** `.env` has `DATABASE_URL`, `GEMINI_API_KEY`, `VLM_MODEL`, `VLM_FALLBACK_MODEL`, `VLM_FALLBACK_MODE=auto`. See `.env.example` for all documented vars.

## 2. Verification commands (all currently GREEN)

```bash
npm run typecheck        # frontend TS
npm run server:typecheck # backend TS (tsc -p server/tsconfig.json --noEmit)
npm run build            # tsc -b && vite build
npm run lint             # eslint
npm test                 # frontend tests (11/11 pass)
node --import tsx --test server/src/parsing/*.test.ts   # server tests (16/16 pass)
```

## 3. Architecture

### Frontend (`src/`)
- `App.tsx` — main roster view. Holds `text` state → `parseRosterText()` → base `roster`. A `committed` state (employees + shifts) is merged into the displayed roster via `mergedRoster` so uploads populate the grid immediately. Renders a **categorized roster grid** grouped into collapsible role sections (Manager → Supervisor → Head Waiter → Waiter → Runner → Other) via `ROLE_SECTIONS` + `sectionForRole()`. Day cells render AM/PM split shifts as two compact labeled blocks via `periodOf()`.
- `components/ShiftUpload.tsx` — the upload/review/commit flow. `onConfirm` calls `confirmRoster()`, then flushes matched preview rows to the parent via `onCommitted`. On a 404 it shows a clear "Upload session expired, please re-upload" toast.
- `api/schedules.ts` — API client (`uploadRoster`, `confirmRoster`, `ApiError`).
- `engine/` — `parser.ts` (text-block parser), `time.ts` (`shiftHours`, `dayToDate`), `types.ts` (`Roster`, `Employee`, `Shift`, `VenueConfig`), `commitBinding.test.ts`, `parser.test.ts`.

### Backend (`server/src/`)
- `routes/schedules.ts` — `POST /api/schedules/upload` (multipart) and `POST /api/schedules/upload/:batchId/confirm`. Routes files by type: images → `parseRosterImage` (VLM), PDFs → try text parser then VLM, Excel/CSV → `parseWorkbookBuffer`.
- `parsing/` — the parsing engine:
  - `parseVision.ts` — VLM (Gemini) image/PDF ingestion. Retries on 503/429, falls back to a deterministic local parser (PDFs) or cached sample (images) when Gemini is unavailable. `mapVlmResponseToResult` maps model JSON → `ParsedVisionResult`.
  - `vlmPrompt.ts` — the Gemini system prompt + JSON schema. Now venue-agnostic: handles AM/PM sub-columns, multi-segmented split shifts ("10am/3pm-7pm/12am"), venue headers, and any role grouping.
  - `deterministicParser.ts` — venue-agnostic local parser (`parseRotaFile`) for Excel/CSV/PDF-text. Handles multi-segmented split shifts, 12h/24h times, leave codes, role categorization.
  - `resolveRows.ts` — resolves parsed rows against DB Role/User records. Has a `ROLE_ALIASES` map + `canonicalRoleName()` that normalizes free-form role strings ("Floor"→"Floor Staff", "Manager"/"GM"/"Floor Manager"→"Management") to canonical seeded roles.
  - `shiftConstraints.ts` — `enforceNoDoubleShifts` (accepts valid AM/PM splits, rejects overlaps/too-close/3+ splits).
  - `parseWorkbook.ts`, `parseText.ts`, `normalize.ts`, `templates.ts`, `persistShifts.ts`, `types.ts`.
- `store/uploadCache.ts` — in-memory + JSON-file-persisted upload batch cache (survives restarts).
- `scripts/` — `seed-gattopardo.ts`, `seed-test-data.ts` (DB seeds), plus verification scripts.

## 4. What has been achieved (recent work)

1. **Confirm & Commit state binding** — uploads now flush committed shifts into the main roster grid immediately (`onCommitted` → `setCommitted` → `mergedRoster`). Verified by `commitBinding.test.ts`.
2. **Vision parser date/header extraction** — prompt now explicitly parses the week-starting date range from the header and threads `weekStart` into Gemini.
3. **Role resolution on upload** — `ROLE_ALIASES` + `canonicalRoleName()` map free-form role strings to canonical seeded roles (management titles → "Management", "Floor" → "Floor Staff").
4. **AM/PM split-shift separation** — prompt + schema emit AM and PM as independent entries; `enforceNoDoubleShifts` correctly handles overnight PM splits.
5. **Missing management rows** — prompt's PASS 1 starts row detection at the top staff row beneath headers, capturing management/floor rows above supervisors.
6. **Manager role mapping** — management titles (Manager/GM/Floor Manager/etc.) resolve to "Management", not "Floor".
7. **Categorized roster grid** — flat list refactored into collapsible role sections with AM/PM split cells.
8. **Upload cache persistence** — batches survive server restarts via JSON file.
9. **`dev:all` script** — runs backend + frontend together via `concurrently`.
10. **`kill-port` on startup** — fixes `EADDRINUSE` zombie-process failures.
11. **Gemini 429/503 fallback** — retries on 429/503, falls back to deterministic local parser (PDFs) or cached sample (images) via `VLM_FALLBACK_MODE` (`auto`/`sample`/`off`).
12. **Multi-venue dynamic parsing** — prompt + deterministic parser handle varied layouts, multi-segmented split shifts, venue headers, any role grouping.

## 5. Where we are now

- All typechecks, build, lint, and tests (11 frontend + 16 server) pass.
- The live Gemini VLM pipeline is the default (`VLM_FALLBACK_MODE=auto`); the hardcoded sample is only used as a last-resort fallback for images.
- The deterministic local parser (`parseRotaFile`) is wired in as the PDF fallback and is venue-agnostic.
- The roster grid is categorized into role sections with AM/PM split support.

## 6. What we are trying to accomplish (next goals)

The product goal is a **7shifts-equivalent** roster experience for Dubai/GCC hospitality. Key open areas:

1. **Live end-to-end validation** — run a real image/PDF upload through the running server and confirm the parsed rows render correctly in the categorized grid (I have no browser/screenshot tool, so this needs manual or scripted verification).
2. **Multi-venue parsing robustness** — test against real rota formats beyond Il Gattopardo (e.g. Bar des Pres FOH with `10am/3pm-7pm/12am` split strings, different row groupings, venue headers). Confirm the VLM prompt + deterministic parser both handle them.
3. **Compliance engine (UAE MOHRE)** — the PRD calls for legal-compliance tracking (max hours, rest periods, overtime). The `VenueConfig`/`DEFAULT_MAINLAND_RULES` types exist but the compliance audit trail is not yet built.
4. **Service-charge pools** — PRD feature, not yet implemented.
5. **Live share links** — one-click revocable share links, not yet implemented.
6. **UI polish** — the categorized grid is functional but not visually verified; confirm the collapsible sections, AM/PM split cells, and dark-luxury styling render correctly.
7. **DB seeds** — `seed-gattopardo.ts` and `seed-test-data.ts` exist; confirm the seeded roles/users match what the parser emits so "Unmatched role" warnings are minimized.

## 7. Important gotchas

- **Windows shell** — PowerShell. Use `Get-ChildItem`, `Select-String`, `Select-Object`; no `grep`/`head`/`tail`/`sed`. `2>$null` not `2>/dev/null`. `$env:NAME='v'` not `export`.
- **dotenv does not override already-set env vars** — a shell `VLM_FALLBACK_MODE=sample` will override `.env`. Unset it if you see the sample being returned unexpectedly.
- **Upload cache is process-local + JSON-file** — a server restart wipes in-memory batches but the JSON file persists them. A 404 on confirm means the batch expired (15-min TTL) or the cache was cleared.
- **No browser/screenshot tool** — you cannot visually verify rendered UI. State exactly what you changed and how the user can check it; never claim visual output is "verified".
- **Update `MEMORY.md`** after every completed task (Phase 5 of the workflow per `AGENTS.md`).
- **`server/`, `prisma/`, `src/components/`, `src/api/` are untracked** in git (new work not yet committed). `server-dev.log`, `server-dev.err.log`, `server-dev-test.log` are stray log files that can be cleaned up.
