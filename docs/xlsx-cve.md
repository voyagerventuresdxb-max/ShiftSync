# xlsx advisories (#23): SheetJS CDN 0.20.3 tried and reverted

Written 2026-10-02. Status: **not adopted.** The CDN build fixes both
advisories, but it changes how CSV and HTML-as-`.xls` uploads parse. The
dependency is still `xlsx` 0.18.5 from npm. This file records what was
measured so the choice between this path and #30 (exceljs) can be made on
evidence.

## The advisories

| Advisory | CVE | Affects | Fixed in |
|---|---|---|---|
| GHSA-4r6h-8v6p-xvw6 prototype pollution (high, 7.8) | CVE-2023-30533 | SheetJS CE ≤ 0.19.2 | 0.19.3 |
| GHSA-5pgg-2g8v-p4x9 ReDoS (high, 7.5) | CVE-2024-22363 | SheetJS CE < 0.20.2 | 0.20.2 |

The npm registry stops at 0.18.5 and won't get fixes. SheetJS publishes
fixed builds only on its CDN. The current build (checked 2026-10-02 at
`cdn.sheetjs.com/xlsx-latest/package/package.json` and the SheetJS Node
install docs) is **0.20.3**:
`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, 2,409,319 bytes,
`sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==`
(sha256 `8dc73fc3…bb99fe8`). Both advisories only matter when reading
untrusted files. Roster upload (`POST /api/schedules/upload`) does exactly
that.

## Install mechanics (these worked)

- `npm install <cdn url>` wrote `resolved` = the CDN URL plus the sha512 above
  into `package-lock.json`. That hash matches one computed independently
  from the downloaded tarball. The lock diff was small (+5 / −96): the xlsx
  entry changed, and the 8 transitive deps of 0.18.5 that nothing else uses
  were dropped (adler-32, cfb, codepage, crc-32, frac, ssf, wmf, word).
- `npm install` and `npm ci` both work from an empty npm cache. A lockfile
  with a tampered hash fails `npm ci` with `EINTEGRITY`.
- `npm run server:typecheck` passes with the 0.20.3 types. No code change was
  needed to compile.
- `npm audit --omit=dev` went from 13 vulnerabilities (6 high, with xlsx
  listed as "No fix available") to 12 (5 high). npm audit doesn't check URL
  dependencies at all. So xlsx disappears from the report because it is no
  longer audited, not because audit confirmed it clean. What shows both
  advisories are fixed is that 0.20.3 is past both fixed-in versions above.

## How the regression check was run

Two input sets, run with 0.18.5 and with 0.20.3, in four host timezones
(UTC, Asia/Dubai, America/Los_Angeles, Asia/Kolkata):

- **All 21 committed spreadsheet fixtures** (`server/test-fixtures/**/*.xlsx`).
- **30 synthetic inputs.** These were generated once, so both versions read
  identical bytes:
  - an Excel-style xlsx with shared strings, rich text, formulas with cached
    values, `t="d"` ISO cells, and typed date and time cells
  - an Excel-style grid with date-cell headers, horizontal and vertical
    merges, and an empty-string legend separator
  - xlsx files written by SheetJS with `cellDates` and with shared strings
  - legacy BIFF8 `.xls` and XML-2003 `.xls`
  - HTML saved as `.xls`
  - 16 CSV files (comma, semicolon, `sep=`, tab, BOM, UTF-16, CRLF and
    quoting, month-name dates, `9-17`-style ranges, an empty file, a
    whitespace-only file)
  - corrupt, truncated and wrong-format files

Every entry point that consumes xlsx was captured as normalized JSON:
`parseWorkbookBuffer`, `buildMergeExpandedGrid`, `listOtherSheetNames`,
`gridToTsvText` (the text sent to Gemini), `parseExcelGrid`,
`processRowsIntoRoster`, and `parseRotaFile`'s xlsx branch. The results were
then reduced to what the upload route actually returns
(`schedules.ts:262-334`):

1. the template result,
2. otherwise the grid result,
3. otherwise the Gemini prompt text and its deterministic fallback.

The baseline was deterministic: two runs gave byte-identical output.

## Results

**Committed fixtures: 0 differences.** All 21 fixtures matched in all four
timezones, in every captured output, including the raw grid. The existing
tests agree. `npm run test:server` gave 346 tests / 345 pass / 0 fail / 1 skip
(the Docling sidecar test) on both versions. Neither the fixtures nor the
tests include a CSV, an HTML `.xls`, or a typed Excel date or time cell. So
they cannot see the differences below.

**Synthetic inputs: the upload route returns something different for 2
inputs on a UTC host, and 3 on the other hosts.** The probe below is a
one-row long-format file per spelling, run through `parseWorkbookBuffer`.

| Input | 0.18.5 (today) | 0.20.3 | |
|---|---|---|---|
| CSV / HTML date `20-Aug-2026`, `20-Aug-26`, `Aug 20, 2026` | parsed (2026-08-20) | row rejected: "Could not parse date value" | **regression** |
| HTML `.xls` time in `h:mm AM/PM` form (`9:00 AM`, `5:00 PM`) | parsed | row rejected: `Could not parse start time "Invalid Date"` | **regression** |
| CSV time `9 AM`, `21:00:00`, `9:00:00 PM`; HTML `21:00:00` | rejected | parsed | improvement |
| Every other probed date/time spelling | same | same | — |

Non-UTC hosts are much worse. In 0.20.3, `sheet_to_json` returns dates in
**local** time unless `UTC: true` is passed (xlsx.js:27396). CSV and HTML
time strings now come back as Date objects, where 0.18.5 left them as text.
`normalize.ts` reads those Dates as UTC. On an Asia/Dubai host, every CSV and
HTML shift time is silently shifted: `09:00` becomes `05:18` and `17:00`
becomes `13:18` (the 1899 Dubai offset is +3:41:12). Dates can also move back
a day. Under 0.18.5, time strings stayed text and parsed correctly on any
host. The API's
production timezone hasn't been checked. Railway defaults to UTC, but
`TZ=Asia/Dubai` would be an easy setting for a Dubai product to pick.

Causes in 0.20.3 (line numbers are in the tarball's `xlsx.js`):

- **Month-name dates.** `fuzzydate` rejects any string containing a letter
  (xlsx.js:3496). `20-Aug-2026` therefore stays a string, and
  `normalize.ts` `DATE_FORMATS` doesn't accept that spelling. 0.18.5 handed
  it to V8's lenient `Date` parser instead.
- **HTML AM/PM times.** `html_to_sheet` checks the cell with `fuzzydate` but
  stores `parseDate(m)` (xlsx.js:22550). `parseDate` can't read `9:00 AM`, so
  the cell becomes an Invalid Date.
- **Non-UTC hosts.** These are the local-time Dates from `sheet_to_json`
  described above.

## Why it was reverted

The phase rule was: any parser regression means revert and document. Both
regressions are on supported upload types. `RosterScreen` and `ShiftUpload`
accept `.csv` and `.xls`, and many POS/HR exports save an HTML table as
`.xls`. The non-UTC behaviour corrupts data silently.

## If the CDN path is chosen anyway

It needs parser changes, not just a dependency swap:

1. `UTC: true` in `buildMergeExpandedGrid`'s `sheet_to_json` call. This was
   tested: it removes the timezone dependence. Non-UTC rows, dates and times
   then match the UTC ones. The only remaining difference is the zone suffix
   in the text of cells SheetJS had already mis-typed as dates. As a side
   effect, it fixes the existing bug below for typed Excel cells. UTC-host
   output is unchanged.
2. Repair Invalid-Date cells from HTML input. For example, re-read the
   original text, or parse HTML with `raw: true`.
3. Add month-name spellings (`D-MMM-YYYY`, `D-MMM-YY`, `MMM D, YYYY`) to
   `DATE_FORMATS`.
4. Add CSV, HTML `.xls` and typed-date-cell fixtures to the corpus, whichever
   path is chosen. The current fixtures would have passed this regression
   unnoticed.

Then re-run the same differential. The target is 0 route-level differences on
UTC, with every non-UTC difference being a correction.

**Supply-chain cost of the CDN tarball:**

- It sits outside the npm registry, so there's no npm provenance.
- npm audit and Dependabot can't see it or bump it.
- Upgrades become manual URL edits.
- Every `npm install`/`npm ci` on Vercel and on Railway (Nixpacks install
  plus `railway.json`'s `npm install`) needs cdn.sheetjs.com to be reachable.
  Neither platform restricts outbound traffic by default.

The lockfile hash pins the exact bytes. Copying the tarball into the repo
(`vendor/xlsx-0.20.3.tgz` with `file:` in `package.json`, as the SheetJS docs
recommend) removes the CDN availability risk.

## Bugs found that exist today (both versions, not fixed here)

- **Typed Excel cells on non-UTC hosts.** Under 0.18.5, typed Excel
  date/time cells are read in local time and then read back as UTC. On an
  Asia/Dubai host, 17:00 becomes 13:18 and the date moves back a day. This
  machine is Asia/Dubai. Production is unaffected only if the API host runs
  UTC.
- **Hour ranges in CSV and HTML.** SheetJS turns CSV/HTML shift ranges such
  as `10-18`, `9-17` and `1-2` into 2001 dates. In a grid CSV, a first staff
  row made of these is taken as a second header row. That employee's whole
  week disappears with no anomaly (synthetic `grid-comma.csv`).
