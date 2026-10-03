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

## The xlsx advisories (#23, #30, #75): upgraded to SheetJS 0.20.3 (2026-10-04)

`xlsx` now comes from SheetJS's official CDN, `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`
(0.20.3 is the current build per `cdn.sheetjs.com/xlsx-latest/package/package.json`, checked
2026-10-04). It is past the fixed-in versions of both published advisories against 0.18.5. The
lockfile pins the URL and its sha512 (`sha512-oLDq3jw7…H+3AJA==`, 2,409,319 bytes); that hash matches
both the one recorded in PR #75 and one computed independently from a fresh download. The lockfile
change is only the `xlsx` entry plus the eight transitive packages 0.20.3 no longer needs.

### What the upgrade needed

- **`UTC: true` on both `sheet_to_json` calls** (`buildMergeExpandedGrid`, `parseRotaFile`). From
  0.20 SheetJS re-expresses `Date` cells in host-local time unless told otherwise, which undid
  `materializeDateCells`'s UTC dates on a non-UTC host (Dubai: 09:00 read as 05:18). With the flag,
  output is unchanged on every host. The other two parser changes #75 listed (text left as text,
  month-name/AM-PM formats in `normalize.ts`) were already in place from the timezone fix above.
- **A probe fix, test-only.** The probe handed `parseRotaFile` a copy of a pooled `Buffer` sliced at
  the original's offset, so that one field parsed truncated bytes on both versions (and could change
  between runs). Production only calls `parseRotaFile` with PDF text, so no app code was affected.
- The synthetic CSV gained `22-Aug-26`, `1:00 PM`, `9:00:00 PM` and `21:00:00`, so every CSV/HTML
  date and time spelling from #75's notes is asserted exactly.

### Gate (all passed)

- The matrix test above, on 0.20.3: the three timezone documents are identical and every synthetic
  row matches exactly.
- Differential against 0.18.5 with the same code: the probe document (21 committed fixtures + 4
  synthetic inputs, every entry point) is **byte-identical** between the two versions, under
  `TZ=UTC`, `Asia/Dubai` and `America/Los_Angeles`, and identical across repeated runs.
- Full server suite, the roster-upload e2e specs, typecheck, lint and build.

### Things to know

- `npm audit` does not check URL dependencies, so `xlsx` simply disappears from its report; what
  shows the advisories are fixed is that 0.20.3 is past both fixed-in versions.
- Dependabot can't bump it either. Upgrades are a manual URL change; re-run this gate each time.
- Every `npm install` (Railway's build, Vercel's build) now needs `cdn.sheetjs.com` to be reachable.
  If that ever becomes a problem, vendor the tarball (`vendor/xlsx-0.20.3.tgz` with a `file:`
  dependency, as the SheetJS install docs suggest); the lockfile hash stays the same.
- Rolling back: `npm install xlsx@0.18.5` restores the registry version (and its two advisories).

### How to run the gate after a future SheetJS bump

```bash
npm install https://cdn.sheetjs.com/xlsx-<version>/xlsx-<version>.tgz   # pins URL + sha512 in the lockfile
npm run server:typecheck
node scripts/with-branch-schema.mjs --connection-limit=1 "node --import tsx --test 'server/src/parsing/*.test.ts'"
```

The matrix test (`parserTimezoneMatrix.test.ts`) is the gate: it must pass unchanged.
