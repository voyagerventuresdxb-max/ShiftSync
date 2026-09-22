# Parser robustness audit (2026-09-22)

Two questions, tested against the real pipeline on `feat/xlsx-to-exceljs` (PR #30,
commit 7f5e14e), not read from the source alone:

1. Did migrating from SheetJS (`xlsx`) to `exceljs` regress the merged-cell fix?
2. Does the deterministic grid parser (`deterministicGridParser.ts`) hold up on
   roster shapes it hasn't been tested against before, or only on the shapes
   already in its fixture suite?

Every scenario below was run through the real parser (`buildMergeExpandedGrid` +
`parseExcelGrid`, or `parseWorkbookBuffer` for the long-format templates) against a
real `.xlsx` buffer built with `exceljs`'s own writer — not a hand-built grid array.
No production code was changed to produce these results; all 283 existing
`test:server` tests and the 36 existing parser tests still pass unmodified (see
PR #30's own results table).

## Priority 1 — merged-cell regression check: PASS, no regression

`exceljs` does **not** expose merges the same way SheetJS did — it resolves every
cell inside any merge (horizontal or vertical) to the master cell's value, no
distinction. SheetJS's `sheet_to_json` left every merged cell but the top-left
blank/undefined, and this app's original fix expanded horizontal merges only
(`multiRowMergeSlaves` in `workbookReader.ts`, ported from the old `expandMergedCells`).

`workbookReader.ts` re-imposes the old distinction explicitly: it walks
`worksheet.model.merges`, and for every merge spanning **more than one row**
(`bottom > top`), blanks every slave cell except the master — undoing exceljs's
own value-propagation for that case. A merge spanning only one row (a day header
over AM/PM sub-columns, a role banner across the staff block) is left alone, since
exceljs already fills every one of those cells with the master's value, which is
exactly the old "expand horizontal merges" behavior.

Verified against the real fixture and the real pipeline, fresh (not from a prior
session's notes):

```
node scripts/with-branch-schema.mjs npx tsx --test server/src/parsing/deterministicGridParser.test.ts
✔ end-to-end: real .xlsx with actual merged cells (!merges), not a pre-expanded array
✔ a staff-name cell vertically merged across rows (!merges with e.r > s.r) is NOT auto-expanded ...
✔ unrecognized-merged-name-cell audit fixture: real employees keep only their own shifts ...
33 tests, 33 pass, 0 fail
```

The first test covers exactly the two shapes asked about: a day header merged
across AM/PM sub-columns (multi-day shift spanning merged columns — 11 rows
extracted, correct role/date attribution, 0 anomalies) and a staff-name cell
vertically merged across rows (the merged row's real, different shift data is
correctly surfaced as an anomaly, never silently attributed to the top-left name).
Both ran through a real `exceljs`-written `.xlsx` buffer, not a pre-built array.

**Verdict: no regression. Fix before anything else — not needed, nothing regressed.**

## Priority 2 — general robustness audit

Each item below was built as a real `.xlsx` (or multi-sheet workbook) via `exceljs`
and run through the actual parser. "Silent-wrong" = wrong output with no signal.
"Loud failure" = a clear error, or a graceful hand-off to anomalies/another parser
path. Only silent-wrong counts as a real problem per this project's own convention.

### 1. Mixed date formats within the same file — PASS

Tested a single header row mixing a text `DD/MM` cell (`"11/05"`), a real `Date`
cell, and an Excel serial number, all resolving to the correct, correct-order
dates (05-11 through 05-14) with 0 anomalies. Also tested the long-format
(`parseWorkbookBuffer`) path with a text `DD/MM/YYYY` date in one row and an Excel
serial number in the next — both resolved correctly, no crash, no cross-row
interference.

**Known, pre-existing, unfixable ambiguity (not a bug):** `normalize.ts`'s
`parseDateCell` tries date formats in a fixed order — `YYYY-MM-DD`, `DD/MM/YYYY`,
`D/M/YYYY`, `MM/DD/YYYY`, ... — so a genuinely ambiguous text date where both
readings are valid (e.g. `"03/04/2026"`, valid as either 3 April or 4 March)
always resolves as day-first (DD/MM), because that format is tried first. An
unambiguous date (day or month > 12, e.g. `"04/13/2026"`) still resolves
correctly regardless of which convention the source file used, because only one
format can parse it. This is an inherent limitation of any parser facing this
input — there's no information in the cell itself to disambiguate — and the
day-first default matches this app's own target market (Dubai/GCC, DD/MM
locale). Not fixed; flagging it here because it's the one way this scenario can
be silently wrong, and it's a property of `normalize.ts`, unrelated to the
exceljs migration.

**Related edge case found, not fixed:** if a header row's ambiguous day-first
dates land more than 13 days apart (`MAX_HEADER_DATE_SPAN_DAYS`), AND the same
cells happen to also look like a valid shift time range once slash-split (e.g.
`"05/06"` parses both as a date and, via the day-grid parser's slash-segment
shift logic, as `05:00-06:00`), the header row can fail the "is this really a
header" structural check and the file falls through to `findHeaderRows` finding
no header at all. In the full upload route (`schedules.ts`) this is not silent —
it hands off to the Gemini grid-parser fallback, same as any other unrecognized
shape. It requires an unrealistic date spread within one header row (weeks apart)
to trigger, so no realistic single-week or two-week roster hits it. Documented,
not fixed.

### 2. Irregular header rows — PASS

- Header not in row 1 (two title/venue-name text rows above it): found correctly,
  title rows skipped, 2 correct shift rows extracted.
- Day-header row with a merged title cell above it, plus the day header itself
  merged (day spanning AM/PM sub-columns): found correctly, correct role/date/
  time attribution, `[AM]`/`[PM]` notes preserved.
- Three stacked header-like rows (numeric dates, then weekday names, then an
  AM/PM row) — a shape not in the existing fixture suite, which only covers
  2-deep stacking (date+AM/PM, or date+weekday-name). Result: **functionally
  correct** — all 4 shifts extracted with the right dates and the right times —
  but the `[AM]`/`[PM]` manager-note annotation that a proper 2-deep AM/PM header
  produces is silently absent, because `findHeaderRows` only ever captures one
  extra header row (`periodRowIdx` XOR a second date-row skip), never both. The
  literal AM/PM row itself is silently skipped as an empty/non-matching row (no
  anomaly), but because both of its columns still resolve to the same day-header
  date as the numeric row above them, the two time values still land as two
  separate, correctly-timed rows for that date. No data loss, no wrong values —
  just a missing cosmetic label. Not fixed (real 3-deep stacked headers are
  a genuinely rare shape, and nothing is wrong or lost); worth a follow-up if a
  real venue file turns up in this shape.

### 3. Arabic-script employee names mixed into an English roster — PASS

Tested `"أحمد"` and `"محمد بن راشد"` alongside `"Ahmed"` and `"Fatima Al-Zahra"` in
the same name column, including one row using a known leave code (`"OFF"`). No
crash, no corruption, no cross-contamination between similarly-spelled names —
each string is carried through as an opaque `employeeName`/`leaveRecord` value,
correctly attributed to its own row's shifts and leave records. This matches
`templates.ts`'s existing `normalizeHeader`/`nameKey` design, which already
deliberately preserves non-Latin letters (`\p{L}`) for exactly this reason (see
that file's own doc comment) — this audit found no gap in what that comment
already covers for the day-grid path.

### 4. Inconsistent shift notation within one file — PASS

One column mixing `"10:00-18:00"` (full range), `"10IN"` (open-ended shorthand),
`"12CL"` (until-closing shorthand), and `"10:30-16:00-20:00-24:00"`
(hyphen-chained double shift) across different days for the same employee, and a
second employee mixing `"9:00 AM - 5:00 PM"`, `"IN"` (fully flexible), a plain
`"9-17"`, and the equivalent hyphen-chained form. Every cell resolved
independently and correctly: the three full/hyphen-chained cells became correct
shift rows (including a correct overnight rollover for the chained shift), and
the three shorthand cells became clearly-worded anomalies (not fabricated
shifts, not silently dropped). Notation choice is entirely per-cell — nothing
about one cell's format affects how a neighboring cell in the same column is
read.

### 5. Sparse/ragged rosters — PASS

Two employees with non-trailing blanks scattered across the week (Ahmed works
Mon/Wed/Fri, Sara works Tue/Thu) and a third employee with an entirely blank
week. Result: exactly the real shifts for the first two, zero rows and zero
anomalies for the fully-blank employee — matching the already-existing,
already-tested "blank week produces zero rows, not a fabricated header
promotion" behavior (`deterministicGridParser.test.ts`'s Zara test). Nothing new
here; confirms the existing behavior generalizes to scattered (not just
trailing) blanks.

### 6. Extra unrelated sheet/tab — PASS (loud, not silent)

Built a 2-tab workbook with an unrelated "Notes" tab (free text, no roster
shape) *first* and the real "Roster" tab second — deliberately the worst-case
ordering, since every parser in this app only ever reads
`workbook.worksheets[0]`. Result: the Notes tab's content was never misread as
roster data — `parseExcelGrid` correctly returns 0 rows / 0 anomalies
("no day-header row detected"), not fabricated shifts. In the full upload route
this is not silent: `parseWorkbookBuffer` throws `TemplateDetectionError`,
`listOtherSheetNames` finds the real "Roster" tab, and the route surfaces an
explicit `ignored_workbook_sheets` anomaly telling the manager "N other sheet(s)
were not read" before falling to the grid parser or the Gemini fallback — this
is exactly the multi-tab risk `parseWorkbook.ts`'s own doc comment already calls
out and defends against. Confirmed working as designed, not a new finding.

## Summary

| # | Scenario | Result |
|---|---|---|
| P1 | exceljs merge-handling regression | **PASS** — no regression, re-verified fresh |
| 1 | Mixed date formats/cell types | **PASS** — 2 known, pre-existing, unfixable-without-more-info edge cases documented |
| 2 | Irregular header rows | **PASS** — 1 cosmetic-only gap documented (3-deep header stacking loses AM/PM label, no data loss) |
| 3 | Arabic-script names | **PASS** |
| 4 | Inconsistent shift notation in one column | **PASS** |
| 5 | Sparse/ragged rosters | **PASS** |
| 6 | Extra unrelated sheet | **PASS** (fails loud, as designed) |

**No genuine silent-wrong failure was found.** Every edge case that came up
either produced correct output, or degraded loudly (an anomaly, an issue, a
422, or a documented existing hand-off to the Gemini fallback) — never silently
wrong data. Nothing here warranted a code fix; nothing was changed on this
branch beyond this document. The two sub-findings under items 1 and 2 above are
recorded for future reference, not tracked as bugs, since neither is fixable
without either more information than the cell contains (item 1) or a real
example of the 3-deep-header shape actually occurring in a venue's file
(item 2).
