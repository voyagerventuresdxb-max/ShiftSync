# Roster parser: timezone safety and the xlsx advisories (2026-10-03)

## What was wrong

The server read spreadsheets with SheetJS `cellDates: true`. SheetJS 0.18.5 builds those
`Date` objects through the **host's local clock**, and `normalize.ts` then read them back as UTC.
On a UTC host the two cancel out; on any other host every typed Excel time moved by the host's
offset (an Asia/Dubai host read 17:00 as 13:18 and could move a date back a day; a Los Angeles
host read it as 01:00 the next day). CSV and HTML-as-`.xls` text went through SheetJS's own date
guesser, which also used the host clock and turned a shift range such as `10-18` into the date
2001-10-18. The text sent to Gemini (`String(date)`) carried the host's zone name as well, so even
the prompt differed between hosts.

Railway containers run UTC, so production was unaffected only by that accident. Nothing pinned it.

## The fix (root cause, no behaviour change on a UTC host)

`server/src/parsing/parseWorkbook.ts` `readWorkbook` is now the only way a spreadsheet is read:

- `cellDates: false` — typed date/time cells come back as their Excel **serials**, the pure
  numbers in the file.
- `cellNF: true` — each cell keeps its number format, so `materializeDateCells` can tell a
  date/time serial from a plain number and turn it into a UTC `Date` itself
  (`excelSerialToUtcDate` in `normalize.ts`: pure arithmetic, rounded to the second).
- `raw: true` — CSV and HTML text stays text; `normalize.ts` parses it with its own locale-free
  formats, which now include `20-Aug-2026`, `20-Aug-26`, `Aug 20, 2026`, `9 AM`, `21:00:00` and
  `9:00:00 PM`.
- `cellToText` (`normalize.ts`) renders a `Date` from its UTC fields for every text path (the Gemini
  prompt, header detection, the local fallback parser), never `String(date)`.

`deterministicParser.ts`'s own `XLSX.read` goes through the same reader.

## Proof

`server/src/parsing/parserTimezoneMatrix.test.ts` runs `parserTimezoneMatrix.probe.ts` in a child
process under `TZ=UTC`, `Asia/Dubai` and `America/Los_Angeles`. The probe parses **all 21 committed
spreadsheet fixtures** plus four synthetic inputs (a CSV with month-name dates and AM/PM times, an
HTML table saved as `.xls`, a grid CSV of `10-18` hour ranges, and an `.xlsx` with typed date, time
and date-time cells written from serial numbers so its bytes are timezone-free) through every entry
point the upload route uses: `parseWorkbookBuffer`, `buildMergeExpandedGrid` + `gridToTsvText`,
`listOtherSheetNames`, `parseExcelGrid`, `processRowsIntoRoster` and `parseRotaFile`. The three
documents must be identical, and the synthetic cases must come out exactly as the sheet shows
(17:00 stays 17:00; `20-Aug-2026` is 2026-08-20; `10-18` is a 10:00–18:00 shift).

Before the fix the Dubai and Los Angeles documents differed from UTC on every typed time cell.

## The xlsx advisories (#23, #30, #75): not upgraded here

The decision was to upgrade only if the full corpus **and** the timezone matrix pass on the new
build. The fixed SheetJS builds (0.19.3+ / 0.20.2+) exist only on `cdn.sheetjs.com`, and that host
answered **403** from this sandbox's egress proxy (so did `git.sheetjs.com`); the npm registry still
stops at 0.18.5. The upgrade could not be attempted, so the gate was not run and `xlsx` stays at
0.18.5. `docs/xlsx-cve.md` (PR #75) records the earlier attempt and the three parser changes it
needed — two of those three (`UTC`-safe reading and the month-name date formats) are now in place
through this fix, which should make a later attempt smaller.

### Mitigations while on 0.18.5

- Roster upload already requires a signed-in manager (`requireSession` + the upload rate limiter);
  the parser only ever sees files a venue's own manager chose to upload.
- Multer caps the upload at 10 MB, and `MAX_ROWS` (5000) bounds the parsed grid.
- The prototype-pollution advisory concerns crafted workbook internals; the ReDoS advisory concerns
  pathological cell text. Both are bounded by the size caps above and by the fact that the file is
  parsed once, in a request that times out, not stored for re-parsing.
- `npm audit --omit=dev` will keep reporting the two advisories until the dependency changes; this
  is expected and documented in `docs/xlsx-cve.md`.

### How to run the gate when the CDN is reachable

```bash
npm install https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz   # pins URL + sha512 in the lockfile
npm run server:typecheck
node scripts/with-branch-schema.mjs --connection-limit=1 "node --import tsx --test 'server/src/parsing/*.test.ts'"
```

The matrix test (`parserTimezoneMatrix.test.ts`) is the gate: it must pass unchanged. If it fails,
`git checkout package.json package-lock.json && npm install` and stay on 0.18.5.
