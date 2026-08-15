# ShiftSync — Project Memory

## Completed Core Components
- [x] Workspace scaffolded (Vite + React 19 + TypeScript strict)
- [x] Dark Luxury Speakeasy design tokens defined in src/styles/global.css
- [x] Tooling ported from prior workspace: claude-flow (ruflo), agent-reach, local Ollama bridge (scripts/ollama-exec.cjs), .claude skills and commands, .ai skills library
- [x] Master PRD placed at SHIFTSYNC_PRD.md
- [x] Consolidated master PRD created at ShiftSync/SHIFTSYNC_PRD.md (merged HOSPITALITY_SCHEDULING_GAP_ANALYSIS.md, SHIFTSYNC_UAE_WORKFORCE_RESEARCH.md, SHIFTSYNC_VALIDATION_ANALYSIS.md into one document)
- [x] Git repository initialized
- [x] Core parser engine built (src/engine/): canonical data contract (types.ts), time/date helpers (time.ts), text-block parser (parser.ts) with multi-language name/role/shift-type tokenization
- [x] Parser unit tests (src/engine/parser.test.ts) via node:test + tsx — 8 tests passing
- [x] Minimal dark-mode paste→preview→share UI wired in App.tsx (live roster grid, warnings, unparsed lines)

## Next Sprint Goals
- Extend parser to Excel (.xlsx) and screenshot/OCR ingestion paths
- Build the dark-mode weekly roster grid component (full compliance flags)
- Implement one-click revocable live share links
- Implement the UAE compliance rules engine (8/48 baseline, overtime multipliers, rest days, leave accrual)
- Implement the service-charge pool tracker tied to verified attendance