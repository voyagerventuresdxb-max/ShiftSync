# Roster parser eval harness

Scores the roster parsers against a synthetic corpus with ground truth. Every name is made up;
logs and reports carry roster ids and numbers only.

```bash
npm run eval:roster:generate            # (re)write corpus/ from spec.ts
npm run eval:roster                     # deterministic path, offline → out/report.md (gitignored)
npm run eval:roster -- --vision=mock    # + the vision pipeline with a truth-echo mock (pipeline check, not a model score)
npm run eval:roster -- --vision=live --record --price-in=<USD/1M> --price-out=<USD/1M>
                                        # + the configured provider (needs credentials); saves answers to recorded/
npm run eval:roster -- --vision=recorded   # replays recorded/ answers, offline
```

Add `--vision-all` to send every roster to the vision path, not only the ones the escalation rules
pick.

## Corpus (`spec.ts` → `corpus/`)

14 rosters, week of Monday 2026-08-17: day grid, per-row title column, long-format template,
merged AM/PM day headers, CSV, text-layer PDF, multi-sheet (roster first / notes first); ALL-CAPS
names; Arabic, Filipino, Indian and Western name styles; split shifts (`11 17 18 25`,
`10-14/18-23`, AM/PM sub-columns); leave codes (`UL`, `AL`, `SL`, `PH`, `OFF`) and open-ended
`IN`/`CL` cells; header vocabulary (`Team member`, `Staff`, `Mon`, `Monday`, `17-Aug`,
`Mon 17/08`). Ground truth (`<id>.truth.json`) comes from `truthOfCell`, an interpreter that is
independent of the parsers under test. A test fails if `corpus/` drifts from `spec.ts`.

## Scores

Per field: **name** (staff found at all), **day** (truth shift has a predicted shift for that
person and day), **start**, **end**, **role** (of shifts found on the right day), **leave**
(person + day + code), **flagged** (open-ended cells surfaced for review), plus **extra shifts**
(predicted shifts matching nothing). Totals are micro-averaged. **Escalation rate** is the share
of rosters the rules in `server/src/parsing/escalation.ts` would send to the AI reader, compared
with the expected escalation in the spec.

Vision rows add latency, input/output tokens and an estimated cost per roster (only when prices
are passed — none are hard-coded, because they change).

## First results (2026-10-04, deterministic, offline)

day 88% · start 88% · end 88% · role 97% · leave 84% · flagged 100% · 4 extra shifts;
escalation 4/14, agreeing with the expected escalation on 13/14.

- **Gap found:** day headers written as `Mon 17/08` are not recognised by the grid parser; that
  roster falls back to the local parser (day 37%, roles lost) and is escalated as an
  unrecognised layout.
- `multi-sheet-notes-first` (the roster on the second tab) reads nothing locally — expected; the
  manager is told other sheets were ignored, and the roster escalates.
- No live model numbers yet: production has no vision credentials (see `docs/vlm-go-live.md`);
  run `--vision=live --record` once they exist.
