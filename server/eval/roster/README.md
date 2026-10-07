# Roster parser eval harness

Scores the roster parsers against a synthetic corpus with ground truth. Every name is made up;
logs and reports carry roster ids and numbers only.

```bash
npm run eval:roster:generate            # (re)write corpus/ from spec.ts
npm run eval:roster:generate -- --families   # + render the layout families into out/families (Chromium)
npm run eval:roster                     # both corpora, offline: legacy deterministic + families with the mock AI reader
npm run eval:roster -- --vision=mock    # legacy: + the vision pipeline with a truth-echo mock (pipeline check, not a model score)
npm run eval:roster -- --vision=none --corpus=families   # families with no AI configured (what a manager gets without AI)
npm run eval:roster -- --vision=live --record --price-in=<USD/1M> --price-out=<USD/1M>
                                        # the configured provider; every call goes through the spend cap
                                        # (withAiBudget, branch schema via with-branch-schema); saves answers
npm run eval:roster -- --vision=recorded   # replays recorded answers, offline
```

Add `--vision-all` to send every legacy roster to the vision path, not only the ones the escalation
rules pick; `--only=A01,B1` to limit the families; `--now=2026-10-07T09:00:00+04:00` to fix the
reading's "today". `--dev-private` also reads the private DEV files (`SHIFTSYNC_PRIVATE_FIXTURES_DIR`)
against hand-verified truth in `SHIFTSYNC_DEV_TRUTH_DIR`; both stay outside the repository, and so
must the report (`--out=<path outside the repo>`); live recordings of them are saved beside the truth.

## Layout families (`families.ts` → `out/families/`, not committed)

36 rosters in the two layouts seen in real uploads, every name made up: **A** — a spreadsheet grid
with a date row over a weekday row, AM | PM sub-columns of decimal hours (`9.5`, `26` = 02:00),
a COVERS caption, banners (the first group has none), headcount rows, leave shown only by cell
colour with a colour key beside the rows, and people with no times all week; **B** — a title, a
DATE row and a DAY OF THE WEEK row, title + name columns and free-text cells (`4pm to 2am`,
`10am/3pm-7pm/12am`, `10:30-4:00-8:00-12`, `OFF`, `UL`, `4CL`, `10IN`). 18 variants each: XLSX,
CSV, text-layer PDF (Chromium print), photo, image-only PDF; merged cells, rotated headers, text
layer out of order, page breaks (2 pages, header repeated or not), footers, column order, 40+
people, `17-Aug` / `Mon 17/08` / `MONDAY 17 AUGUST` / `Aug 17` / `17th Aug` / weekday-only with a
title, weekday row above or below the date row, 12h / 24h / decimal / dot separators, and second
rosters for the following week. Truth comes from the semantic roster (`families.ts`); the printed
text is derived from it, never the other way round.

Each file is read through `parsing/readUpload.ts` (the function the upload route calls) with no
client weekStart. The mock AI reader (`mockVision.ts`) answers from the truth with a dropped row,
a swapped time, a misread name and, on 2-page files, a missing page; a strict page re-read lists
every row. Scores (`familyScore.ts`): staff recall / exact names / precision (people with no shifts
count; banners, headcounts, captions and the colour key must never become people), shift recall,
exact times, role, week, and **silent** drops (a person or shift neither read nor in unread rows,
anomalies or flags) and silently wrong times.

### Results (2026-10-07, mock AI reader, "today" 2026-10-07)

| | staff recall | precision | shift recall | exact time | week | silent drops | silent wrong times |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A before (18 rosters) | 53.8% | 100.0% | 50.8% | 50.8% | 9/18 | 102 people, 521 shifts | 0 |
| A after | 100.0% | 100.0% | 100.0% | 99.4% | 18/18 | 0 | 0 |
| B before (18 rosters) | 52.7% | 72.0% | 50.0% | 49.2% | 13/18 | 97 people, 406 shifts | 13 |
| B after | 100.0% | 100.0% | 100.0% | 99.0% | 18/18 | 0 | 0 |

The remaining inexact times are the mock's deliberately swapped cell, kept with the AI's reading and
flagged (`times_differ` against the table reader, or a 14-hour-plus `low_confidence` check on
photos). On the two private DEV files (one per layout, hand-verified truth outside the repo) the
reading is likewise 100% of people (21 — 5 of them with no times all week — and 18; before: 18
and 17), 100% of shifts (before: 100% and 94%), the right week, 0 silent drops (before: 3 people;
1 person and 4 shifts). Largest mock answer ≈ 1,100 output tokens (cap 16,384).

With no AI configured, every spreadsheet and text-layer PDF variant still reads 100% (people,
shifts, week); photos and scans are refused with `vision_unconfigured` (nothing to read locally).

### Round 2 (after the holdout grade): 43 rosters

Seven variants added, one per failure the independent holdout found: A19 (a "Total staff on rota"
line with per-day counts), A20 / A21 (photo and scan with coloured cells that hold times, PM-only
days), B19 / B21 (name column before the title column, NAME / TITLE headings), B20 (ff / fi / fl
split into separate text items, plus a totals line), B22 (a photo whose last row sits at the page
edge). The mock AI reader gained the matching failures: the title column read as the names, the
totals line listed as a person, coloured cells with times read as colour only, a PM-only day's
values slipped into the next day, an "18" read as "18.5", a person with no times left out and not
counted, the last row reported as cut off. Photos and scans are now read twice (person by person
and day column by day column) and the readings compared; the column read has its own independent
mistakes (a different misread name, a missed cell).

| | staff recall | precision | shift recall | exact time | week | silent drops | silent wrong times |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A before (21 rosters) | 100.0% | 99.8% | 99.3% | 99.0% | 21/21 | 0 people, 21 shifts | 5 |
| A after | 100.0% | 100.0% | 100.0% | 99.7% | 21/21 | 0 | 0 |
| B before (22 rosters) | 99.5% | 91.4% | 99.0% | 98.7% | 22/22 | 2 people, 17 shifts | 0 |
| B after | 100.0% | 100.0% | 100.0% | 99.6% | 22/22 | 0 | 0 |

Per feature, before → after: name-first layouts (B06, B19) precision 50% → 100% (20 titles had
become people); totals line (A19) precision 95.6% → 100%; ligature splits (B20) 18 → 20 people,
17 → 0 silent shifts, precision 78% → 100%; photos and scans of the decimal-hour layout (A10, A11,
A18, A20, A21) 4–5 silent shifts and one silently wrong time each → 0 (what only one reading saw is
kept and flagged; the 18 / 18.5 cell keeps the first reading's value with both attached). The
largest mock answer is now ≈ 1,600 output tokens (a column read; it writes about 1.6× the row
read), far under the 16,384 cap.

### Round 3 (after a fresh holdout): 52 rosters

Nine variants added, each a new form of a failure class a fresh holdout found: B23 (STAFF NAME |
POSITION set tight, with issued-by and signature lines), B24 (# | EMPLOYEE | ROLE on a row of
their own, a generated-by footer), B29 (title column right before the name, no headings), B25 / B26
/ B28 (No. | NAME | POSITION, Position | S/N | Staff and Employee Full Name | Emp ID | Designation;
one-word department and area banners in the name column, AGM / HOD / Senior Server titles), B27 (a
faint scan whose two readings spell one name differently), A22 / A23 (a 42-person photo and an
angled scan with many half days, where the two readings disagree on many cells). "Saved exact" is
exact times out of the shifts imported; "exact or shown" counts a shift not imported but shown to
the manager as a cell to look at (both readings) as covered.

| | staff recall | precision | shift recall | exact time | saved exact | week | silent drops | wrong times saved | shown to check |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A before (23 rosters) | 100.0% | 100.0% | 100.0% | 99.6% | 99.6% | 23/23 | 0 | 15 | 0 |
| A after | 100.0% | 100.0% | 96.9% | 96.9% | 100.0% | 23/23 | 0 | 0 | 118 |
| B before (29 rosters) | 98.0% | 93.2% | 98.1% | 97.7% | 99.6% | 29/29 | 12 people, 44 shifts | 9 | 0 |
| B after | 100.0% | 100.0% | 99.3% | 99.3% | 100.0% | 29/29 | 0 | 0 | 16 |

Per class, before → after: tight name | title columns (B23, B24) 19 and 12 of 20 people, precision
47.5% and 42.8%, 9 silent people → 20 / 20 each, 100%, 0 silent; department and area banners and
index columns (B25, B26, B28) precision 83.3%, 90.9% and 94.4%, 3 silent people → 100%, 0 silent;
photos the two readings disagree on (A22, A23) 5 wrong times saved → 0 (79 cells shown to check
with both readings instead); a name spelled two ways (B27 and the mock's misread names) 3 kept
silently → 0 (both spellings kept, "check the spelling"). The lower shift recall on photos is by
design: a cell the two readings read differently is never imported, it is shown.

## Corpus (`spec.ts` → `corpus/`)

18 rosters, week of Monday 2026-08-17: day grid, per-row title column, long-format template,
merged AM/PM day headers, CSV, text-layer PDF, multi-sheet (roster first / notes first); ALL-CAPS
names; Arabic, Filipino, Indian and Western name styles; split shifts (`11 17 18 25`,
`10-14/18-23`, AM/PM sub-columns); leave codes (`UL`, `AL`, `SL`, `PH`, `OFF`) and open-ended
`IN`/`CL` cells; header vocabulary (`Team member`, `Staff`, `Mon`, `Monday`, `17-Aug`,
`Mon 17/08`, `MON 17-08`, `Mon 17 Aug`, `17/08 Mon`), and a header whose weekday disagrees with
its date (`Thu 19/08` over a Wednesday: every entry under it must be flagged). Ground truth (`<id>.truth.json`) comes from `truthOfCell`, an interpreter that is
independent of the parsers under test. A test fails if `corpus/` drifts from `spec.ts`.

## Scores

Per field: **name** (staff found at all), **day** (truth shift has a predicted shift for that
person and day), **start**, **end**, **role** (of shifts found on the right day), **leave**
(person + day + code), **flagged** (open-ended cells, and entries under a header whose weekday
disagrees with its date, surfaced for review), plus **extra shifts**
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
  unrecognised layout. **Fixed 2026-10-04** (below).
- `multi-sheet-notes-first` (the roster on the second tab) reads nothing locally — expected; the
  manager is told other sheets were ignored, and the roster escalates.
- No live model numbers yet: production has no vision credentials (see `docs/vlm-go-live.md`);
  run `--vision=live --record` once they exist.

## After day headers with a weekday (2026-10-04, deterministic, offline)

The grid parser now reads a weekday before or after a day-month date (`Mon 17/08`, `MON 17-08`,
`Mon 17 Aug`, `17/08 Mon`; numeric dates are always day first), infers the year from the roster
week, and flags every entry under a header whose weekday disagrees with its date.

day 94% · start 94% · end 94% · role 100% · leave 94% · flagged 100% · 0 extra shifts, over 18
rosters; escalation 3/18, agreeing with the expected escalation on 18/18. Every roster from the
first run scores the same or better (`header-vocab-weekday-date`: day 37% → 100%); the four new
rosters score 100%. The only roster below 100% is still `multi-sheet-notes-first`, as expected.
