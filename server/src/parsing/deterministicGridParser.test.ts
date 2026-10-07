import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import { parseExcelGrid } from './deterministicGridParser.js';
import { buildMergeExpandedGrid } from './parseWorkbook.js';
import { printedWeekdayMismatch, resolveDayMonthDate } from './normalize.js';

const WEEK_START = '2026-08-17'; // Monday

function keys(rows: { employeeName: string; date: string; startTime: string; endTime: string }[]): string[] {
  return rows.map((r) => `${r.employeeName}|${r.date}|${r.startTime}-${r.endTime}`).sort();
}

test('day-grid with merged AM/PM headers and merged role-section headers', () => {
  // Mirrors the merge-expanded output of a real .xlsx: day headers spanning
  // AM/PM sub-columns, "SUPERVISORS"/"RUNNERS" section headers spanning the
  // full staff-block width — same shape validated against live Gemini
  // output previously (11/11 correct).
  const grid: unknown[][] = [
    ['', 'Monday', 'Monday', 'Tuesday', 'Tuesday'],
    ['', 'AM', 'PM', 'AM', 'PM'],
    ['SUPERVISORS', 'SUPERVISORS', 'SUPERVISORS', 'SUPERVISORS', 'SUPERVISORS'],
    ['Fatima', '9-13', '14-18', '9-13', '14-18'],
    ['Yusuf', '10-14', '15-19', '', ''],
    ['RUNNERS', 'RUNNERS', 'RUNNERS', 'RUNNERS', 'RUNNERS'],
    ['Chen', '9-13', '', '9-13', '14-18'],
    ['Divya', '', '14-18', '9-13', ''],
  ];

  const result = parseExcelGrid(grid, WEEK_START);
  assert.equal(result.anomalies.length, 0);

  const expected = [
    'Fatima|2026-08-17|09:00-13:00',
    'Fatima|2026-08-17|14:00-18:00',
    'Fatima|2026-08-18|09:00-13:00',
    'Fatima|2026-08-18|14:00-18:00',
    'Yusuf|2026-08-17|10:00-14:00',
    'Yusuf|2026-08-17|15:00-19:00',
    'Chen|2026-08-17|09:00-13:00',
    'Chen|2026-08-18|09:00-13:00',
    'Chen|2026-08-18|14:00-18:00',
    'Divya|2026-08-17|14:00-18:00',
    'Divya|2026-08-18|09:00-13:00',
  ].sort();
  assert.deepEqual(keys(result.rows), expected);
  const fatima = result.rows.filter((r) => r.employeeName === 'Fatima');
  assert.ok(fatima.every((r) => r.roleName === 'SUPERVISORS'));
  const chen = result.rows.filter((r) => r.employeeName === 'Chen');
  assert.ok(chen.every((r) => r.roleName === 'RUNNERS'));
});

test('single header row, 4-space-separated-number cells (AM start/end, PM start/end), decimal hours, and overnight rollover', () => {
  // Matches the real reference venue's PDF layout literally: "11 17 18 25"
  // in one cell = AM 11:00-17:00, PM 18:00-01:00 (25 % 24 = 1, overnight).
  // Also covers half-hour decimal notation ("18.5" = 18:30).
  const grid: unknown[][] = [
    ['', 'Monday', 'Tuesday'],
    ['Kalim', '11 17 18 25', '12 17 18 24'],
    ['SUPERVISORS', 'SUPERVISORS', 'SUPERVISORS'],
    ['Mibru', '16 18 18.5 26', '11 16 18 24'],
  ];

  const result = parseExcelGrid(grid, WEEK_START);
  assert.equal(result.anomalies.length, 0);

  const kalim = result.rows.filter((r) => r.employeeName === 'Kalim');
  assert.equal(kalim.length, 4);
  assert.deepEqual(
    kalim.map((r) => `${r.date} ${r.startTime}-${r.endTime} overnight=${r.overnight}`).sort(),
    [
      '2026-08-17 11:00-17:00 overnight=false',
      '2026-08-17 18:00-01:00 overnight=true',
      '2026-08-18 12:00-17:00 overnight=false',
      '2026-08-18 18:00-00:00 overnight=true',
    ].sort(),
  );
  // Kalim sits above any role header -> role stays unresolved, never
  // borrowed from elsewhere on the sheet — surfaced as a warning, not
  // silently guessed or silently dropped.
  assert.ok(kalim.every((r) => r.roleName === ''));
  assert.ok(result.issues.some((i) => i.severity === 'warning' && i.message.includes('Kalim')));

  const mibru = result.rows.filter((r) => r.employeeName === 'Mibru');
  assert.equal(mibru.length, 4);
  assert.ok(mibru.every((r) => r.roleName === 'SUPERVISORS'));
  assert.deepEqual(
    mibru.map((r) => `${r.date} ${r.startTime}-${r.endTime} overnight=${r.overnight}`).sort(),
    [
      '2026-08-17 16:00-18:00 overnight=false',
      '2026-08-17 18:30-02:00 overnight=true',
      '2026-08-18 11:00-16:00 overnight=false',
      '2026-08-18 18:00-00:00 overnight=true',
    ].sort(),
  );
});

test('a numeric first cell (totals/headcount row) is never treated as a staff name', () => {
  const grid: unknown[][] = [
    ['', 'Monday', 'Tuesday'],
    ['Kalim', '9-17', '9-17'],
    ['8', '5', '4'], // headcount summary row, as seen at the bottom of the real reference venue's rota
  ];
  const result = parseExcelGrid(grid, WEEK_START);
  assert.equal(result.rows.length, 2);
  assert.ok(result.rows.every((r) => r.employeeName === 'Kalim'));
});

test('unresolvable cell content becomes an anomaly, not a hallucinated shift', () => {
  // findHeaderRows requires >=2 date-like header cells to recognize a
  // day-header row at all (avoids false-positiving on a single stray
  // date-looking cell elsewhere on the sheet), so this needs 2 day columns
  // even though only one is exercised.
  const grid: unknown[][] = [
    ['', 'Monday', 'Tuesday'],
    ['Kalim', 'XyzGarbage', ''],
  ];
  const result = parseExcelGrid(grid, WEEK_START);
  assert.equal(result.rows.length, 0);
  assert.equal(result.anomalies.length, 1);
  assert.equal(result.anomalies[0].rawText, 'XyzGarbage');
});

test('leave/absence codes become leave records, not shifts or anomalies', () => {
  const grid: unknown[][] = [
    ['', 'Monday', 'Tuesday'],
    ['Kalim', 'OFF', 'PH'],
  ];
  const result = parseExcelGrid(grid, WEEK_START);
  assert.equal(result.rows.length, 0);
  assert.equal(result.anomalies.length, 0);
  assert.equal(result.leaveRecords.length, 2);
  assert.equal(result.leaveRecords[0].category, 'day_off');
  assert.equal(result.leaveRecords[1].category, 'public_holiday');
});

test('end-to-end: real .xlsx with actual merged cells (!merges), not a pre-expanded array', () => {
  // Exercises the real pipeline a route handler would use: an actual
  // workbook buffer with genuine merge ranges (day header spanning AM/PM
  // sub-columns, role-section header spanning the full staff-block width),
  // through buildMergeExpandedGrid, then parseExcelGrid. Same shape/ground
  // truth as the live-Gemini-validated test from the previous session
  // (11/11 correct).
  const aoa: (string | number | null)[][] = [
    ['', 'Monday', '', 'Tuesday', ''],
    ['', 'AM', 'PM', 'AM', 'PM'],
    ['SUPERVISORS', '', '', '', ''],
    ['Fatima', '9-13', '14-18', '9-13', '14-18'],
    ['Yusuf', '10-14', '15-19', null, null],
    ['RUNNERS', '', '', '', ''],
    ['Chen', '9-13', null, '9-13', '14-18'],
    ['Divya', null, '14-18', '9-13', null],
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!merges'] = [
    { s: { r: 0, c: 1 }, e: { r: 0, c: 2 } },
    { s: { r: 0, c: 3 }, e: { r: 0, c: 4 } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: 4 } },
    { s: { r: 5, c: 0 }, e: { r: 5, c: 4 } },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Roster');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

  const grid = buildMergeExpandedGrid(buffer, 'test.xlsx');
  const result = parseExcelGrid(grid, WEEK_START);

  assert.equal(result.rows.length, 11);
  assert.equal(result.anomalies.length, 0);
  const fatima = result.rows.filter((r) => r.employeeName === 'Fatima');
  assert.equal(fatima.length, 4);
  assert.ok(fatima.every((r) => r.roleName === 'SUPERVISORS'));
  const divya = result.rows.filter((r) => r.employeeName === 'Divya');
  assert.equal(divya.length, 2);
  assert.ok(divya.every((r) => r.roleName === 'RUNNERS'));
});

test('a known leave code in a notes column outside the day-data range becomes a leave record for a shift-less employee', () => {
  const grid: unknown[][] = [
    ['', 'Monday', 'Tuesday', 'Notes'],
    ['Kalim', '9-17', '9-17', 'Closing'], // worked normally -> trailing note must NOT become a leave record
    ['Ruren', '', '', 'PH'], // zero shifts, notes column has a known leave code -> surfaced as a leave record
    ['Rumur', '', '', 'Request'],
    ['Lomur', '', '', ''], // zero shifts, no note at all -> correctly produces nothing
  ];
  const result = parseExcelGrid(grid, WEEK_START);

  assert.equal(result.rows.length, 2); // Kalim's 2 days x 1 shift each
  assert.ok(result.rows.every((r) => r.employeeName === 'Kalim'));

  assert.deepEqual(
    result.leaveRecords.map((r) => `${r.employeeName}:${r.leaveCode}:${r.category}`).sort(),
    ['Rumur:Request:day_off', 'Ruren:PH:public_holiday'],
  );
});

test('a venue-specific ALL-CAPS section label not in the known role vocabulary is still recognized as a header', () => {
  // "FOH TEAM" / "BAR CREW" are not in ROLE_ALIASES at all — this is the
  // actual generalization being tested: pattern-based (all-caps, inside
  // the staff listing), not a hardcoded word list.
  const grid: unknown[][] = [
    ['', 'Monday', 'Tuesday'],
    ['Priya', '9-17', '9-17'], // unlabeled top row, no header above it
    ['FOH TEAM', '', ''],
    ['Ahmed', '10-18', '10-18'],
    ['BAR CREW', '', ''],
    ['Lin', '11-19', '11-19'],
  ];
  const result = parseExcelGrid(grid, WEEK_START);
  assert.equal(result.rows.length, 6);
  assert.ok(result.rows.filter((r) => r.employeeName === 'Priya').every((r) => r.roleName === ''));
  assert.ok(result.rows.filter((r) => r.employeeName === 'Ahmed').every((r) => r.roleName === 'FOH TEAM'));
  assert.ok(result.rows.filter((r) => r.employeeName === 'Lin').every((r) => r.roleName === 'BAR CREW'));
});

test('an ALL-CAPS caption before any real staff row is NOT mistaken for a role header (the original "COVERS" bug)', () => {
  // Mirrors the real reference file: a covers-count panel title sitting
  // above the staff listing, in caps, with no real shift data in its row
  // — must not swallow the unlabeled management rows beneath it.
  const grid: unknown[][] = [
    ['', 'Monday', 'Tuesday'],
    ['COVERS', 'Sofia - 20pax', ''],
    ['Kalim', '9-17', '9-17'],
    ['RUNNERS', '', ''],
    ['Kadak', '13-21', '13-21'],
  ];
  const result = parseExcelGrid(grid, WEEK_START);
  const kalim = result.rows.filter((r) => r.employeeName === 'Kalim');
  assert.equal(kalim.length, 2);
  assert.ok(kalim.every((r) => r.roleName === ''));
  const kadak = result.rows.filter((r) => r.employeeName === 'Kadak');
  assert.ok(kadak.every((r) => r.roleName === 'RUNNERS'));
  // "COVERS" is a caption describing the day, not a person: neither a staff member nor a shift,
  // and its event note is not an anomaly about anyone.
  assert.deepEqual(result.people?.map((p) => p.name), ['Kalim', 'Kadak']);
  assert.ok(!result.anomalies.some((a) => a.employeeName === 'COVERS'));
});

test('per-row title column (Bar des Pres FOH style): role comes from column A, name from column B', () => {
  // Day columns start at index 2 (not 1) -> the parser should infer a
  // title column at 0 and a name column at 1, rather than assuming column
  // 0 is always the name.
  const grid: unknown[][] = [
    ['', '', 'Monday', 'Tuesday'],
    ['RM', 'Nedak Mizon', '9-17', '9-17'],
    ['Supervisor', 'Kagal Miren', '10-18', '10-18'],
    ['WAITER', '', '', ''], // section banner: title+name both blank, spans nothing useful
    ['Waiter 1', 'Neren Netel', '11-19', '11-19'],
  ];
  const result = parseExcelGrid(grid, WEEK_START);
  assert.equal(result.rows.length, 6);
  assert.ok(result.rows.filter((r) => r.employeeName === 'Nedak Mizon').every((r) => r.roleName === 'RM'));
  assert.ok(result.rows.filter((r) => r.employeeName === 'Kagal Miren').every((r) => r.roleName === 'Supervisor'));
  // Per-row title takes precedence over the section banner above it, even
  // though "WAITER" was itself independently recognized as a header.
  assert.ok(result.rows.filter((r) => r.employeeName === 'Neren Netel').every((r) => r.roleName === 'Waiter 1'));
});

test('per-row title falls back to the section-derived role when a row has no title of its own', () => {
  const grid: unknown[][] = [
    ['', '', 'Monday', 'Tuesday'],
    ['RUNNER', '', '', ''],
    ['', 'Kabru Migal', '9-17', '9-17'], // blank title cell -> should inherit "RUNNER"
  ];
  const result = parseExcelGrid(grid, WEEK_START);
  const kabru = result.rows.filter((r) => r.employeeName === 'Kabru Migal');
  assert.equal(kabru.length, 2);
  assert.ok(kabru.every((r) => r.roleName === 'RUNNER'));
});

test('"UL" is recognized as Unpaid Leave', () => {
  const grid: unknown[][] = [
    ['', 'Monday', 'Tuesday'],
    ['Rutel', 'UL', 'UL'],
  ];
  const result = parseExcelGrid(grid, WEEK_START);
  assert.equal(result.rows.length, 0);
  assert.equal(result.leaveRecords.length, 2);
  assert.ok(result.leaveRecords.every((r) => r.category === 'leave' && r.leaveCode === 'UL'));
});

test('open-ended ("<N>IN"), until-closing ("<N>CL"), and fully-flexible ("IN") shorthand are flagged with a clear reason, not forced into a fake shift', () => {
  const grid: unknown[][] = [
    ['', 'Monday', 'Tuesday', 'Wednesday'],
    ['Nedak Mizon', '10IN', '12CL', 'IN'],
  ];
  const result = parseExcelGrid(grid, WEEK_START);
  assert.equal(result.rows.length, 0, 'none of these should become a normal shift row');
  assert.equal(result.anomalies.length, 3);
  const [openEnded, untilClosing, flexible] = result.anomalies;
  assert.match(openEnded.reason, /open-ended/i);
  assert.match(openEnded.reason, /10:00/);
  assert.match(untilClosing.reason, /closing/i);
  assert.match(untilClosing.reason, /12:00/);
  assert.match(flexible.reason, /flexible|on-call/i);
  // Understood, not garbage — higher confidence than a genuine unresolved cell.
  assert.ok(result.anomalies.every((a) => a.confidence === 0.7));
});

test('four hyphen-chained numbers with no slash ("10:30-4:00-8:00-12") split into two back-to-back shifts', () => {
  const grid: unknown[][] = [
    ['', 'Monday', 'Tuesday'],
    ['Tavo Kelrin', '10:30-4:00-8:00-12', ''],
  ];
  const result = parseExcelGrid(grid, WEEK_START);
  assert.equal(result.rows.length, 2);
  // A 12-hour chain without am/pm reads forward in time (shiftText.ts): 10:30-16:00, then
  // 20:00-midnight — not the literal 10:30-04:00 (a 17.5-hour overnight) it used to give.
  assert.deepEqual(
    result.rows.map((r) => `${r.startTime}-${r.endTime}${r.overnight ? '+' : ''}`).sort(),
    ['10:30-16:00', '20:00-00:00+'],
  );
});

test('legend-code shifts: a footer legend block (code | label | time-range) resolves coded cells to real shift times', () => {
  // Mirrors the real stress-test reference fixture
  // (server/test-fixtures/stress/2-legend-code-shifts.xlsx) exactly: a
  // blank separator row, a "Shift Code Legend" caption, then one code per
  // row as three cells (code, label, time range). "OFF" has no time range
  // printed (it's a plain absence code) and is left to the existing
  // LEAVE_CODES resolution rather than the legend.
  const grid: unknown[][] = [
    ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    ['Ahmed Ali', 'M', 'M', 'E', 'OFF', 'N', 'M', 'E'],
    ['Noor Said', 'E', 'E', 'M', 'M', 'OFF', 'E', 'N'],
    ['Reem Fakhoury', 'M', 'OFF', 'M', 'E', 'E', 'N', 'M'],
    ['', '', '', '', '', '', '', ''],
    ['Shift Code Legend', '', '', '', '', '', '', ''],
    ['M', 'Morning', '07:00-15:00', '', '', '', '', ''],
    ['E', 'Evening', '15:00-23:00', '', '', '', '', ''],
    ['N', 'Night', '23:00-07:00', '', '', '', '', ''],
    ['G', 'General', '09:00-18:00', '', '', '', '', ''],
    ['OFF', 'Day Off', '', '', '', '', '', ''],
  ];

  const result = parseExcelGrid(grid, WEEK_START);
  assert.equal(result.anomalies.length, 0, 'every coded cell resolves via the legend or LEAVE_CODES, none unresolved');

  // Legend surfaced for the manager, same shape as the vision path's.
  // "G" is a real legend entry with no cell using it this week (harmless —
  // still surfaced) and "OFF" is correctly excluded (no time range to give).
  assert.deepEqual(
    result.legend.map((l) => l.code).sort(),
    ['E', 'G', 'M', 'N'].sort(),
  );
  assert.ok(result.legend.find((l) => l.code === 'M')!.meaning.includes('07:00-15:00'));

  const ahmed = result.rows.filter((r) => r.employeeName === 'Ahmed Ali');
  assert.deepEqual(
    ahmed.map((r) => `${r.date} ${r.startTime}-${r.endTime}`).sort(),
    [
      '2026-08-17 07:00-15:00', // Mon: M
      '2026-08-18 07:00-15:00', // Tue: M
      '2026-08-19 15:00-23:00', // Wed: E
      '2026-08-21 23:00-07:00', // Fri: N
      '2026-08-22 07:00-15:00', // Sat: M
      '2026-08-23 15:00-23:00', // Sun: E
    ].sort(),
  );
  assert.ok(ahmed.find((r) => r.date === '2026-08-21')!.overnight, 'Night shift (23:00-07:00) correctly flagged overnight');

  // Thu ("OFF") produced a leave record, not a shift row and not an anomaly.
  assert.ok(result.leaveRecords.some((r) => r.employeeName === 'Ahmed Ali' && r.date === '2026-08-20' && r.category === 'day_off'));

  const noor = result.rows.filter((r) => r.employeeName === 'Noor Said');
  assert.equal(noor.length, 6); // 7 days - 1 OFF day
  assert.ok(result.leaveRecords.some((r) => r.employeeName === 'Noor Said' && r.category === 'day_off'));
});

test('no legend block present: behavior is completely unchanged (regression) — unrecognized codes stay unresolved anomalies', () => {
  // Identical shift-code letters to the test above, but with NO footer
  // legend block at all. Without a detected legend, "M"/"E"/"N" have no
  // meaning and must fall through to 'unresolved', exactly as before this
  // feature existed — proves legend detection is additive, not a silent
  // behavior change for every file that happens to use short codes.
  const grid: unknown[][] = [
    ['', 'Mon', 'Tue'],
    ['Ahmed Ali', 'M', 'OFF'],
  ];
  const result = parseExcelGrid(grid, WEEK_START);
  assert.equal(result.rows.length, 0);
  assert.equal(result.anomalies.length, 1);
  assert.equal(result.anomalies[0].rawText, 'M');
  assert.equal(result.leaveRecords.length, 1);
  assert.equal(result.leaveRecords[0].category, 'day_off');
  assert.deepEqual(result.legend, []);
});

test('legend code overlapping a LEAVE_CODES name: the file\'s own legend wins (documented precedence)', () => {
  // "AL" is a fixed LEAVE_CODES entry (Annual Leave) everywhere else, but
  // this venue's own legend defines "AL" as a real shift code ("All Day",
  // 09:00-21:00). Precedence rule: a file-specific legend is more specific
  // than the generic hardcoded vocabulary, so it wins for cells in THIS
  // file — the venue's own printed meaning is trusted over the generic one.
  const grid: unknown[][] = [
    ['', 'Mon', 'Tue'],
    ['Priya', 'AL', 'SICK'], // SICK has no legend entry -> still resolves via LEAVE_CODES as before
    ['', '', ''],
    ['AL', 'All Day', '09:00-21:00'],
  ];
  const result = parseExcelGrid(grid, WEEK_START);
  assert.equal(result.anomalies.length, 0);

  const priya = result.rows.filter((r) => r.employeeName === 'Priya');
  assert.equal(priya.length, 1);
  assert.equal(priya[0].date, '2026-08-17');
  assert.equal(priya[0].startTime, '09:00');
  assert.equal(priya[0].endTime, '21:00');

  // SICK is untouched by the legend (not defined in it) and still resolves
  // the old way, via the fixed LEAVE_CODES table.
  assert.equal(result.leaveRecords.length, 1);
  assert.equal(result.leaveRecords[0].category, 'leave');
  assert.equal(result.leaveRecords[0].leaveCode, 'SICK');
});

// 2026-09-05 — the final whole-branch review caught this: detectLegend's
// scan used to permanently stop at the FIRST non-matching row once at least
// one real entry had been found — so a timeless/caption line (e.g. "OFF =
// Day Off", which never matches since it has no resolvable time range)
// sitting BETWEEN two real codes, not just after all of them, silently
// truncated the legend and dropped every real code listed after it. A real
// venue's own legend has no guaranteed ordering (OFF could be listed
// alphabetically in the middle, not always last, as it happens to be in
// this file's own real reference fixture). Fixed with a consecutive-streak
// tolerance: a single non-matching line is tolerated and resets on the next
// real match, so order no longer matters — only two non-matching lines IN A
// ROW aborts detection.
test('legend detection is order-independent: a timeless code (OFF) sitting BETWEEN two real legend entries does not truncate the ones after it', () => {
  const grid: unknown[][] = [
    ['', 'Mon', 'Tue', 'Wed'],
    ['Ahmed Ali', 'M', 'OFF', 'N'],
    ['', '', '', ''],
    ['M', 'Morning', '07:00-15:00', ''],
    ['OFF', 'Day Off', '', ''], // no resolvable time range -> never matches matchLegendRow, sits BETWEEN two real entries
    ['N', 'Night', '23:00-07:00', ''],
  ];
  const result = parseExcelGrid(grid, WEEK_START);

  assert.deepEqual(
    result.legend.map((l) => l.code).sort(),
    ['M', 'N'],
    'N must still be captured even though a non-matching line (OFF) came before it',
  );
  const ahmed = result.rows.filter((r) => r.employeeName === 'Ahmed Ali');
  assert.deepEqual(
    ahmed.map((r) => `${r.date} ${r.startTime}-${r.endTime}`).sort(),
    ['2026-08-17 07:00-15:00', '2026-08-19 23:00-07:00'].sort(),
    'both M (Mon) and N (Wed) must resolve via the legend, not just M',
  );
  assert.ok(result.leaveRecords.some((r) => r.employeeName === 'Ahmed Ali' && r.category === 'day_off'), 'Tue (OFF) still resolves as a leave record via LEAVE_CODES, as before');
});

// 2026-09-05 — also caught by the final whole-branch review: matchLegendRow's
// CODE_TOKEN previously allowed up to 6 characters, so an ordinary short
// English word ("TOTAL") sitting alone in the footer, next to a cell that
// happens to contain a real time range, still satisfied the multi-column
// legend shape and got fabricated into a bogus legend entry — even with the
// contiguity fix above, since this row is the very FIRST thing after the
// separator (nothing before it to trip the non-match streak). Fixed by
// capping CODE_TOKEN at 3 characters total, matching every real
// shift-code convention found in research and the actual reference fixture
// (all single-letter or short abbreviations — M/E/N/G, OFF, AL — never a
// whole word).
test('a lone footer line that only coincidentally looks like a legend entry (a "TOTAL" summary row) is not fabricated into a bogus legend', () => {
  const grid: unknown[][] = [
    ['', 'Mon', 'Tue'],
    ['Ahmed Ali', '9-17', '9-17'],
    ['', '', ''],
    ['TOTAL', 'Hours', '09:00-17:00'],
  ];
  const result = parseExcelGrid(grid, WEEK_START);
  assert.deepEqual(result.legend, [], 'a 5-letter word must never be read as a real venue shift code');
});

test('legend detection ignores a bare short code/time-range pair inside the real staff grid (no false positive above the blank separator)', () => {
  // "Al" (a plausible short staff name) sitting next to a real shift cell
  // ("9-17") could, taken out of context, look like a legend line
  // ("Al" + a resolvable time range). Requiring the footer block to start
  // below a fully-blank row (never scanning the staff-data region itself)
  // is what prevents this from ever being misread as a legend entry.
  const grid: unknown[][] = [
    ['', 'Monday', 'Tuesday'],
    ['Al', '9-17', '9-17'],
  ];
  const result = parseExcelGrid(grid, WEEK_START);
  assert.deepEqual(result.legend, []);
  const al = result.rows.filter((r) => r.employeeName === 'Al');
  assert.equal(al.length, 2);
  assert.ok(al.every((r) => r.startTime === '09:00' && r.endTime === '17:00'));
});

// 2026-09-05 — code review caught this: detectLegend used to treat the
// FIRST fully-blank row anywhere below the header as the permanent start of
// an excluded "footer" region, then scanned all the way to grid end looking
// for a legend-shaped match — even through an unrelated, blank-row-separated
// mid-sheet section (a role header + its own real staff rows). That could
// (a) silently drop real staff rows between the first blank row and end of
// file from result.rows, and (b) fabricate a bogus legend entry out of
// unrelated footer text (e.g. a totals line) that only coincidentally has a
// code-shaped first cell and a resolvable time range. Fixed by requiring the
// legend block to be genuinely contiguous: once a real entry is found, the
// scan stops at the next non-matching, non-blank row instead of skipping
// past it, and more than one leading non-legend line before any entry is
// ever found aborts detection entirely.
test('legend detection does not treat an unrelated mid-sheet blank-separated section as the legend footer — real staff rows in between are never dropped', () => {
  const grid: unknown[][] = [
    ['', 'Mon', 'Tue'],
    ['Ahmed Ali', '9-17', '9-17'],
    ['', '', ''],
    ['BACK OF HOUSE', '', ''],
    ['Noor Said', '10-18', '10-18'],
    ['', '', ''],
    ['Reem Fakhoury', '11-19', '11-19'],
    ['', '', ''],
    ['TOTAL', 'Hours', '09:00-17:00'],
  ];
  const result = parseExcelGrid(grid, WEEK_START);

  assert.deepEqual(result.legend, [], 'unrelated footer text must never be fabricated into a legend entry');
  assert.deepEqual(
    result.rows.map((r) => r.employeeName).sort(),
    ['Ahmed Ali', 'Noor Said', 'Noor Said', 'Reem Fakhoury', 'Reem Fakhoury', 'Ahmed Ali'].sort(),
    'Noor Said and Reem Fakhoury must not be silently dropped as if they were footer/legend content',
  );
});

// 2026-09-05 — code review caught this: `lower in fileLegend` (and the
// pre-existing `lower in LEAVE_CODES` checks) use the `in` operator on a
// plain object literal, which also matches inherited Object.prototype
// property names. A day-cell reading exactly "constructor" would otherwise
// silently "resolve" against the real Object constructor function (whose
// .start/.end are undefined) instead of correctly falling through to
// 'unresolved'. Fixed via a hasOwnProperty-based lookup.
test('a cell reading a reserved Object.prototype property name ("constructor") is an unresolved anomaly, not a bogus resolved shift', () => {
  const grid: unknown[][] = [
    ['', 'Mon', 'Tue'],
    ['Ahmed Ali', 'constructor', '9-17'],
  ];
  const result = parseExcelGrid(grid, WEEK_START);
  assert.equal(result.rows.length, 1, 'only the real "9-17" Tue cell resolves; "constructor" must not fabricate a shift row with undefined start/end times');
  assert.equal(result.anomalies.length, 1);
  assert.equal(result.anomalies[0].rawText, 'constructor');
});

test('returns 0 rows with no throw when the grid has no recognizable day-header row', () => {
  const grid: unknown[][] = [
    ['Team Member', 'Job Title', 'Shift Date'],
    ['Amara', 'Bartender', '2026-08-17'],
  ];
  const result = parseExcelGrid(grid, WEEK_START);
  assert.equal(result.rows.length, 0);
  assert.equal(result.anomalies.length, 0);
});

// Audit finding #3 (server/test-fixtures/edge-case-audit/, MEMORY.md): a
// novel Title-Case section header not in ROLE_ALIASES ("Poolside Detail")
// previously parsed correctly (times, names preserved) but left every
// affected row's roleName blank, with only a warning buried in `issues`.
test('unrecognized-section-header audit fixture: rows stay correctly grouped under the header\'s own raw text (never blank), each unique header surfaces as exactly one blocking anomaly', () => {
  const buffer = readFileSync('server/test-fixtures/edge-case-audit/2-novel-header-vocab.xlsx');
  const grid = buildMergeExpandedGrid(buffer, '2-novel-header-vocab.xlsx');
  const result = parseExcelGrid(grid, '2026-08-24'); // Monday

  assert.equal(result.templateLabel, 'Deterministic Grid Parser');
  assert.equal(result.rows.length, 20, 'no data lost — every shift under every novel header still parses');
  // No more silent "No role/section header precedes X" warnings for this
  // case — replaced by the explicit blocking anomaly below, not
  // double-flagged via both mechanisms at once.
  assert.equal(result.issues.length, 0);

  const roleOf = (name: string) => [...new Set(result.rows.filter((r) => r.employeeName === name).map((r) => r.roleName))];
  assert.deepEqual(roleOf('Amira Saleh'), ['Poolside Detail']);
  assert.deepEqual(roleOf('Bilal Rahman'), ['Poolside Detail']);
  assert.deepEqual(roleOf('Nadia Farouk'), ['Shisha Terrace']);
  assert.deepEqual(roleOf('Hamza Idris'), ['Valet & Door']);

  assert.equal(result.anomalies.length, 3, 'one anomaly per unique unrecognized header, not one per row');
  const byText = new Map(result.anomalies.map((a) => [a.rawText, a]));
  assert.equal(byText.get('Poolside Detail')?.kind, 'unrecognized_section_header');
  assert.deepEqual(byText.get('Poolside Detail')?.affectedRowNumbers, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(byText.get('Shisha Terrace')?.affectedRowNumbers, [11, 12, 13, 14, 15]);
  assert.deepEqual(byText.get('Valet & Door')?.affectedRowNumbers, [16, 17, 18, 19, 20]);
  // Never auto-guessed/fuzzy-matched to an existing role — confidence 0,
  // no employeeName (it isn't any one person's anomaly), reason names the
  // header and the real blast radius so a manager knows what's at stake.
  for (const a of result.anomalies) {
    assert.equal(a.confidence, 0);
    assert.equal(a.employeeName, null);
    assert.match(a.reason, /is not a known role/);
  }
});

test('unrecognized-section-header promotion never overwrites an already-REAL recognized header (regression case: a blank-week employee sitting inside an existing section)', () => {
  // Mirrors the real Gattopardo reference fixture's Lomur/Nelim/Nedak
  // shape (see pdfTableExtractor.test.ts) in miniature: a blank-week
  // employee with no leave-code note either, sitting between two other
  // real HEAD WAITERS rows. The first version of this fix (no provisional/
  // real distinction) silently overwrote HEAD WAITERS with "Zara" here,
  // corrupting the employee listed after her — caught by re-running the
  // full suite against the real fixture before this test existed.
  const grid: unknown[][] = [
    ['', 'Mon', 'Tue'],
    ['HEAD WAITERS', '', ''],
    ['Nelim', '9-17', '9-17'],
    ['Zara', '', ''], // blank week, no leave note — structurally identical to a novel header
    ['Nedak', '10-18', '10-18'],
  ];
  const result = parseExcelGrid(grid, WEEK_START);

  const roleOf = (name: string) => [...new Set(result.rows.filter((r) => r.employeeName === name).map((r) => r.roleName))];
  assert.deepEqual(roleOf('Nelim'), ['HEAD WAITERS']);
  assert.deepEqual(roleOf('Nedak'), ['HEAD WAITERS'], 'must NOT have been silently reassigned to "Zara"');
  assert.equal(result.rows.some((r) => r.employeeName === 'Zara'), false, 'Zara herself produces zero rows, same as before this feature existed');
  assert.equal(result.anomalies.length, 0, 'Zara is never promoted to a header at all — currentRole was already REAL when her blank row was seen');
});

// Round-2 audit finding: a staff-name cell vertically merged across
// multiple rows (a real Excel authoring pattern — merging for visual
// grouping, each row still carrying its own real, different shift data)
// was silently attributing every merged row's shifts to whoever the
// merge's top-left name happened to be, with zero anomaly. Two levels of
// coverage: the synthetic case below pins the exact mechanism
// (expandMergedCells must never propagate a VERTICAL merge's value down),
// and the fixture-based test after it proves the full pipeline on the
// audit's own real file.
test('a staff-name cell vertically merged across rows (!merges with e.r > s.r) is NOT auto-expanded — each row keeps its own real, different shift data, surfaced as an anomaly instead of silently merged into one identity', () => {
  const aoa: (string | number | null)[][] = [
    ['', 'Monday', 'Tuesday'],
    ['Karim El-Sayed', '10-18', '10-18'],
    [null, '14-22', '14-22'], // vertically merged with the row above — a DIFFERENT real shift pattern underneath
    ['Reem Fakhoury', '9-17', 'OFF'],
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!merges'] = [{ s: { r: 1, c: 0 }, e: { r: 2, c: 0 } }]; // vertical: e.r (2) > s.r (1)
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Roster');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

  const grid = buildMergeExpandedGrid(buffer, 'test.xlsx');
  // The mechanism itself: row 2's name cell must still read blank/null —
  // never silently filled in with "Karim El-Sayed" the way a horizontal
  // merge (see the test above) IS correctly expected to expand.
  assert.equal(grid[2][0], null);

  const result = parseExcelGrid(grid, WEEK_START);
  const byEmployee = (name: string) => result.rows.filter((r) => r.employeeName === name);
  assert.equal(byEmployee('Karim El-Sayed').length, 2, 'only his OWN row\'s 2 shifts — not also the merged row\'s 2');
  assert.equal(byEmployee('Reem Fakhoury').length, 1);
  assert.equal(result.rows.length, 3, 'the merged row\'s 2 real shifts are surfaced as an anomaly, not silently dropped nor misattributed');

  assert.equal(result.anomalies.length, 1);
  assert.equal(result.anomalies[0].kind, 'unrecognized_merged_name_cell');
  assert.equal(result.anomalies[0].employeeName, null, 'never guessed/attributed to Karim, Reem, or anyone else');
  assert.match(result.anomalies[0].rawText, /14-22/);
});

test('unrecognized-merged-name-cell audit fixture: real employees keep only their own shifts, the 2 orphaned merged rows surface as distinct anomalies (before this fix: 20 rows, all attributed to 2 names, 0 anomalies)', () => {
  const buffer = readFileSync('server/test-fixtures/edge-case-audit-round2/2b-merged-staff-rows.xlsx');
  const grid = buildMergeExpandedGrid(buffer, '2b-merged-staff-rows.xlsx');
  const result = parseExcelGrid(grid, '2026-08-24'); // Monday

  const byEmployee = (name: string) => result.rows.filter((r) => r.employeeName === name);
  assert.equal(byEmployee('Karim El-Sayed').length, 5, 'his own row only — was 15 (3 merged rows worth) before this fix');
  assert.equal(byEmployee('Reem Fakhoury').length, 5);
  assert.equal(result.rows.length, 10, 'was 20 before this fix');

  assert.equal(result.anomalies.length, 2, 'one per orphaned merged row — was 0 before this fix');
  for (const a of result.anomalies) {
    assert.equal(a.kind, 'unrecognized_merged_name_cell');
    assert.equal(a.employeeName, null);
    assert.equal(a.confidence, 0);
  }
});

// --- findHeaderRows structural gate (Issue #22) -----------------------------
//
// findHeaderRows used to take the FIRST row in the top 15 with >=2 cells that
// resolve as a date. But resolveDayMonthDate accepts numeric pairs, so a shift
// range whose end hour is <=12 ("9-12", "8-11") reads as a calendar date
// (Dec 9, Nov 8) — and a data row holding two of them was taken for the
// header, silently re-dating every shift in the file. The same content test
// also decided whether the row under the header was a "second header row", so
// a real first employee with two such cells was swallowed and vanished.

test('Issue #22: an early row whose shift ranges read as dates ("9-12", "8-11") is not mistaken for the header', () => {
  const grid: unknown[][] = [
    ['Opening cover', '9-12', '8-11', '9-12'], // date-shaped, but really shifts — NOT the header
    ['', 'Monday', 'Tuesday', 'Wednesday'], // the real header
    ['Fatima', '9-17', '9-17', 'OFF'],
  ];
  const result = parseExcelGrid(grid, WEEK_START);
  assert.equal(result.templateLabel, 'Deterministic Grid Parser');
  assert.equal(result.anomalies.length, 0);
  // Dated from the REAL header (Mon/Tue 2026-08-17/18), not Dec 9 / Nov 8.
  assert.deepEqual(keys(result.rows), ['Fatima|2026-08-17|09:00-17:00', 'Fatima|2026-08-18|09:00-17:00']);
});

test('Issue #22: one shift repeated across an early row ("9-12" x3 = a single distinct date) is not mistaken for the header', () => {
  const grid: unknown[][] = [
    ['Cover', '9-12', '9-12', '9-12'],
    ['', 'Monday', 'Tuesday', 'Wednesday'],
    ['Fatima', '9-17', '9-17', 'OFF'],
  ];
  const result = parseExcelGrid(grid, WEEK_START);
  assert.deepEqual(keys(result.rows), ['Fatima|2026-08-17|09:00-17:00', 'Fatima|2026-08-18|09:00-17:00']);
});

test('Issue #22: the first staff row directly under the header is not swallowed as a "second header row" when its shift ranges read as dates', () => {
  const grid: unknown[][] = [
    ['', 'Monday', 'Tuesday', 'Wednesday'],
    ['Layla', '6-10', '7-11', '8-12'], // three date-shaped cells — but a real employee
    ['Fatima', '9-17', '9-17', 'OFF'],
  ];
  const result = parseExcelGrid(grid, WEEK_START);
  assert.deepEqual(keys(result.rows), [
    'Fatima|2026-08-17|09:00-17:00',
    'Fatima|2026-08-18|09:00-17:00',
    'Layla|2026-08-17|06:00-10:00',
    'Layla|2026-08-18|07:00-11:00',
    'Layla|2026-08-19|08:00-12:00',
  ]);
});

// Guards: shapes that ALSO look header-ish/date-ish and must keep working
// exactly as before the gate existed.

test('a numeric day-month header row ("17/08 | 18/08 | 19/08") is still the header even though each cell also parses as a shift', () => {
  const grid: unknown[][] = [
    ['', '17/08', '18/08', '19/08'],
    ['Fatima', '9-17', '9-17', 'OFF'],
  ];
  const result = parseExcelGrid(grid, WEEK_START);
  assert.deepEqual(keys(result.rows), ['Fatima|2026-08-17|09:00-17:00', 'Fatima|2026-08-18|09:00-17:00']);
});

test('a real second header row (weekday names beneath numeric dates) is still skipped, not read as the first staff row', () => {
  const grid: unknown[][] = [
    ['', '17-Aug', '18-Aug', '19-Aug'],
    ['', 'Monday', 'Tuesday', 'Wednesday'],
    ['Fatima', '9-17', '9-17', 'OFF'],
  ];
  const result = parseExcelGrid(grid, WEEK_START);
  assert.equal(result.anomalies.length, 0);
  assert.deepEqual(keys(result.rows), ['Fatima|2026-08-17|09:00-17:00', 'Fatima|2026-08-18|09:00-17:00']);
});

test('a header row that labels its own name column ("Name | Monday | Tuesday | Wednesday") is still recognized', () => {
  const grid: unknown[][] = [
    ['Name', 'Monday', 'Tuesday', 'Wednesday'],
    ['Fatima', '9-17', '9-17', 'OFF'],
  ];
  const result = parseExcelGrid(grid, WEEK_START);
  assert.deepEqual(keys(result.rows), ['Fatima|2026-08-17|09:00-17:00', 'Fatima|2026-08-18|09:00-17:00']);
});

test('ALL-CAPS venue: a blank-week staff member is never silently taken as a real section header', () => {
  // Every name is in capitals, so "written in caps" can't tell a header from a person. Before
  // the fix, the blank-week row below became a REAL role and relabelled the next staff member
  // with no warning; now it is grouped provisionally and flagged for the manager.
  const grid: unknown[][] = [
    ['', 'Monday', 'Tuesday'],
    ['SUPERVISORS', '', ''],
    ['TEST ALPHA', '9-17', '9-17'],
    ['TEST BLANKWEEK', '', ''],
    ['TEST GAMMA', '10-18', '10-18'],
  ];
  const result = parseExcelGrid(grid, WEEK_START);
  assert.equal(result.rows.length, 4);
  assert.ok(result.rows.filter((r) => r.employeeName === 'TEST ALPHA').every((r) => r.roleName === 'Supervisor' || r.roleName === 'SUPERVISORS'));
  const flagged = result.anomalies.find((a) => a.kind === 'unrecognized_section_header' && a.rawText === 'TEST BLANKWEEK');
  assert.ok(flagged, 'the ambiguous caps label is surfaced as a blocking anomaly');
  assert.match(flagged!.reason, /TEST GAMMA/);
});

test('ALL-CAPS venue: vocabulary headers still apply normally (no new anomalies)', () => {
  const grid: unknown[][] = [
    ['', 'Monday', 'Tuesday'],
    ['SUPERVISORS', '', ''],
    ['TEST ALPHA', '9-17', '9-17'],
    ['RUNNERS', '', ''],
    ['TEST BETA', '10-18', '10-18'],
  ];
  const result = parseExcelGrid(grid, WEEK_START);
  assert.equal(result.rows.length, 4);
  assert.equal(result.anomalies.length, 0);
  assert.ok(result.rows.filter((r) => r.employeeName === 'TEST BETA').every((r) => /RUNNER/i.test(r.roleName)));
});

test('mixed-case venue: an ALL-CAPS header inside the listing is still a real header (unchanged)', () => {
  const grid: unknown[][] = [
    ['', 'Monday', 'Tuesday'],
    ['Test Alpha', '9-17', '9-17'],
    ['FOH TEAM', '', ''],
    ['Test Beta', '10-18', '10-18'],
  ];
  const result = parseExcelGrid(grid, WEEK_START);
  assert.ok(result.rows.filter((r) => r.employeeName === 'Test Beta').every((r) => r.roleName === 'FOH TEAM'));
  assert.equal(result.anomalies.filter((a) => a.kind === 'unrecognized_section_header').length, 0);
});

test('per-row title shape: a novel first section header with no staff above groups the untitled rows below and is flagged', () => {
  const grid: unknown[][] = [
    ['', '', 'Monday', 'Tuesday'],
    ['Poolside Crew', '', '', ''], // novel vocabulary, title case, very first label
    ['', 'Test Person One', '9-17', '9-17'],
    ['', 'Test Person Two', '10-18', ''],
    ['Supervisor', 'Test Person Three', '11-19', '11-19'], // own title wins
  ];
  const result = parseExcelGrid(grid, WEEK_START);
  assert.ok(result.rows.filter((r) => r.employeeName === 'Test Person One').every((r) => r.roleName === 'Poolside Crew'));
  assert.ok(result.rows.filter((r) => r.employeeName === 'Test Person Two').every((r) => r.roleName === 'Poolside Crew'));
  assert.ok(result.rows.filter((r) => r.employeeName === 'Test Person Three').every((r) => r.roleName === 'Supervisor'));
  const flagged = result.anomalies.find((a) => a.kind === 'unrecognized_section_header' && a.rawText === 'Poolside Crew');
  assert.ok(flagged);
  assert.equal(flagged!.affectedRowNumbers?.length, 3);
});

test('per-row title shape: a trailing caption with nobody below it produces no anomaly', () => {
  const grid: unknown[][] = [
    ['', '', 'Monday', 'Tuesday'],
    ['Supervisor', 'Test Person One', '9-17', '9-17'],
    ['Prepared by the office', '', '', ''],
  ];
  const result = parseExcelGrid(grid, WEEK_START);
  assert.equal(result.rows.length, 2);
  assert.equal(result.anomalies.filter((a) => a.kind === 'unrecognized_section_header').length, 0);
});

test('day headers with a weekday: "Mon 17/08", "MON 17-08", "Mon 17 Aug", "Monday, 17/08", "17/08 Mon" all read as 17 August (DD/MM)', () => {
  for (const header of ['Mon 17/08', 'MON 17-08', 'Mon 17 Aug', 'Monday, 17/08', '17/08 Mon', '17-Aug MONDAY']) {
    assert.equal(resolveDayMonthDate(header, '2026-08-17'), '2026-08-17', header);
    assert.equal(printedWeekdayMismatch(header, '2026-08-17'), null, header);
  }
  // Day first, always: 08/17 is not a date (there is no month 17).
  assert.equal(resolveDayMonthDate('Mon 08/17', '2026-08-17'), null);
  // A weekday alone, or a name that starts like one, is not a day-month date.
  assert.equal(resolveDayMonthDate('Monday', '2026-08-17'), null);
  assert.equal(resolveDayMonthDate('Sun Li', '2026-08-17'), null);
});

test('day headers with a weekday: the year comes from the roster week, across New Year too', () => {
  assert.equal(resolveDayMonthDate('Fri 01/01', '2026-12-28'), '2027-01-01');
  assert.equal(printedWeekdayMismatch('Fri 01/01', '2027-01-01'), null);
  assert.equal(resolveDayMonthDate('Wed 31/12', '2026-01-05'), '2025-12-31');
  assert.equal(printedWeekdayMismatch('Wed 31/12', '2025-12-31'), null);
});

test('a header whose weekday disagrees with its date keeps the date and flags every entry under it', () => {
  assert.deepEqual(printedWeekdayMismatch('Thu 19/08', '2026-08-19'), { printed: 'Thursday', actual: 'Wednesday' });
  const grid = [
    ['', 'Mon 17/08', 'Tue 18/08', 'Thu 19/08'],
    ['SUPERVISORS', '', '', ''],
    ['Test Alpha', '9-17', '9-17', '9-17'],
    ['Test Beta', '', 'OFF', 'OFF'],
  ];
  const result = parseExcelGrid(grid, '2026-08-17');
  assert.deepEqual(result.rows.map((r) => `${r.employeeName}|${r.date}`), ['Test Alpha|2026-08-17', 'Test Alpha|2026-08-18', 'Test Alpha|2026-08-19']);
  const flagged = result.anomalies.filter((a) => a.reason.includes('day header says Thursday'));
  assert.deepEqual(flagged.map((a) => `${a.employeeName}|${a.date}|${a.rawText}`), ['Test Alpha|2026-08-19|Thu 19/08', 'Test Beta|2026-08-19|Thu 19/08']);
  const alphaRow = result.rows.find((r) => r.date === '2026-08-19')!;
  assert.equal(flagged[0]!.rowNumber, alphaRow.rowNumber, 'the flag is linked to the shift row it applies to');
  assert.equal(flagged[1]!.rowNumber, null, 'a leave entry has no shift row to link to');
});

// --- Reading the printed week and every person (roster reading rework) ----------------------

const TODAY = '2026-10-07';
const today = { today: TODAY, clientWeekStart: null };

test('a weekday row ABOVE the date row: shifts are dated in the printed week, not the upload week', () => {
  // Before: the weekday row was taken as THE header and anchored to the current week (the
  // "landed in the week of 28 Sep" bug); the date row beneath it was skipped.
  const grid = [
    ['', 'MONDAY', 'TUESDAY', 'WEDNESDAY'],
    ['', '24-Aug', '25-Aug', '26-Aug'],
    ['Test Alpha', '9-17', '', '10-18'],
  ];
  const result = parseExcelGrid(grid, '2026-09-28', today);
  assert.deepEqual(result.rows.map((r) => r.date), ['2026-08-24', '2026-08-26']);
  assert.equal(result.week?.weekStart, '2026-08-24');
  assert.equal(result.week?.source, 'printed_dates');
});

test('two rosters in the same format for different printed weeks land in their own weeks', () => {
  const roster = (d: number) => [
    ['', `${d}-Aug`, `${d + 1}-Aug`],
    ['', 'MONDAY', 'TUESDAY'],
    ['Test Alpha', '9-17', '9-17'],
  ];
  assert.equal(parseExcelGrid(roster(17), TODAY, today).week?.weekStart, '2026-08-17');
  assert.equal(parseExcelGrid(roster(24), TODAY, today).week?.weekStart, '2026-08-24');
});

test('weekday-only headers take the week from a title above the grid; with nothing printed they ask for confirmation', () => {
  const titled = [['Rota 24 - 30 Aug', '', ''], ['', 'Mon', 'Tue'], ['Test Alpha', '9-17', '9-17']];
  const r1 = parseExcelGrid(titled, TODAY, today);
  assert.deepEqual(r1.rows.map((r) => r.date), ['2026-08-24', '2026-08-25']);
  assert.equal(r1.week?.source, 'title');
  const bare = parseExcelGrid([['', 'Mon', 'Tue'], ['Test Alpha', '9-17', '9-17']], TODAY, today);
  assert.equal(bare.week?.source, 'weekday_only');
  assert.equal(bare.week?.needsConfirmation, true);
  assert.equal(bare.week?.weekStart, '2026-10-12', 'the coming Monday, never silently the current week');
});

test('"Aug 17", "17th Aug" and "MONDAY 17 AUGUST" headers are day headers', () => {
  for (const [a, b] of [['Aug 17', 'Aug 18'], ['17th Aug', '18th Aug'], ['MONDAY 17 AUGUST', 'TUESDAY 18 AUGUST']]) {
    const result = parseExcelGrid([['', a, b], ['Test Alpha', '9-17', '9-17']], TODAY, today);
    assert.deepEqual(result.rows.map((r) => r.date), ['2026-08-17', '2026-08-18'], a);
  }
});

test('every person is listed, including people with no times all week; banners, headcounts and captions are not people', () => {
  // Family-A shape: a COVERS caption, a first group with no banner, banners printed across the
  // days (merged), a headcount row after each group, and people whose week is colour only.
  const banner = (label: string) => ['', label, label, label];
  const grid = [
    ['', '17-Aug', '18-Aug', '19-Aug'],
    ['', 'MONDAY', 'TUESDAY', 'WEDNESDAY'],
    ['COVERS', '', 'Party - 20pax', ''],
    ['Test Lead One', '11 17 18 25', '', '12 16 18 24'],
    ['Test Lead Blank', '', '', ''],
    ['Test Lead Two', '9.5 15.5 18 23', '', ''],
    ['3', '2', '1', '1'],
    banner('SUPERVISORS'),
    ['Test Sup Blank', '', '', ''],
    ['Test Sup One', '16 18 18.5 26', '', ''],
    ['2', '1', '0', '0'],
  ];
  const result = parseExcelGrid(grid, TODAY, today);
  assert.deepEqual(
    result.people?.map((p) => `${p.name}|${p.section ?? ''}`),
    ['Test Lead One|', 'Test Lead Blank|', 'Test Lead Two|', 'Test Sup Blank|SUPERVISORS', 'Test Sup One|SUPERVISORS'],
  );
  assert.ok(result.people?.every((p) => p.readerSource === 'table' && p.personKey));
  assert.deepEqual(result.unreadRows, []);
  const one = result.rows.filter((r) => r.employeeName === 'Test Lead One');
  assert.ok(one.every((r) => r.personKey === result.people![0]!.personKey && r.readerSource === 'table'));
  assert.deepEqual(result.rows.filter((r) => r.employeeName === 'Test Sup One').map((r) => `${r.startTime}-${r.endTime}`), ['16:00-18:00', '18:30-02:00']);
});

test('day sub-columns saved without their merge (CSV): the blank-headed columns belong to the day before them', () => {
  const grid = [
    ['', '17-Aug', '', '', '', '18-Aug', '', '', ''],
    ['', 'AM', '', 'PM', '', 'AM', '', 'PM', ''],
    ['Test Alpha', '11', '17', '18', '25', '', '', '18', '26'],
  ];
  const result = parseExcelGrid(grid, TODAY, today);
  assert.deepEqual(
    result.rows.map((r) => `${r.date} ${r.startTime}-${r.endTime} ${r.managerNotes}`),
    ['2026-08-17 11:00-17:00 [AM]', '2026-08-17 18:00-01:00 [PM]', '2026-08-18 18:00-02:00 [PM]'],
  );
});

test('title column vs name column is decided by content: numbered titles and abbreviations are titles', () => {
  const grid = [
    ['', '', 'Mon', 'Tue'],
    ['Test Name One', 'RM', '4pm to 2am', 'OFF'],
    ['Test Name Two', 'Waiter 3', '1pm to 11pm', 'UL'],
    ['Test Name Three', 'HW 2', 'OFF', '10am/3pm-7pm/12am'],
  ];
  const result = parseExcelGrid(grid, '2026-08-17');
  assert.deepEqual(result.people?.map((p) => `${p.name}|${p.roleLabel}`), ['Test Name One|RM', 'Test Name Two|Waiter 3', 'Test Name Three|HW 2']);
  assert.deepEqual(result.rows.map((r) => `${r.employeeName} ${r.startTime}-${r.endTime}`), [
    'Test Name One 16:00-02:00',
    'Test Name Two 13:00-23:00',
    'Test Name Three 10:00-15:00',
    'Test Name Three 19:00-00:00',
  ]);
});

test('a banner merged across a title-column sheet is a section, never a person', () => {
  const grid = [
    ['', '', 'Mon', 'Tue'],
    ['RM', 'Test Name One', '9-17', 'OFF'],
    ['WAITER', 'WAITER', 'WAITER', 'WAITER'],
    ['Waiter 1', 'Test Name Two', 'OFF', '9-17'],
  ];
  const result = parseExcelGrid(grid, '2026-08-17');
  assert.deepEqual(result.people?.map((p) => `${p.name}|${p.section ?? ''}`), ['Test Name One|', 'Test Name Two|WAITER']);
});

test('dot separators read as hours.minutes when the sheet shows minutes; decimal hours otherwise', () => {
  const minutes = parseExcelGrid([['', 'Mon', 'Tue'], ['Test Alpha', '18.30-01.00', '10.00-15.00/19.00-00.00']], '2026-08-17');
  assert.deepEqual(minutes.rows.map((r) => `${r.startTime}-${r.endTime}`), ['18:30-01:00', '10:00-15:00', '19:00-00:00']);
  const decimal = parseExcelGrid([['', 'Mon', 'Tue'], ['Test Alpha', '9.5 15.5 18 23', '18.5 26']], '2026-08-17');
  assert.deepEqual(decimal.rows.map((r) => `${r.startTime}-${r.endTime}`), ['09:30-15:30', '18:00-23:00', '18:30-02:00']);
});

test('an ambiguous blank-week label that opens the listing is grouped as a heading AND listed as an unread row, never dropped', () => {
  const grid = [
    ['', 'Mon', 'Tue'],
    ['Poolside Detail', '', ''],
    ['Test Alpha', '9-17', '9-17'],
  ];
  const result = parseExcelGrid(grid, '2026-08-17');
  assert.deepEqual(result.unreadRows?.map((u) => u.text), ['Poolside Detail']);
  assert.match(result.unreadRows![0]!.reason, /section heading/);
});

test('a headcount number alone in the title column is not a section heading (the old /^d+/ typo let it become one)', () => {
  const grid = [
    ['', '', 'Mon', 'Tue'],
    ['RM', 'Test Alpha', '9-17', '9-17'],
    ['12', '', '', ''],
    ['', 'Test Beta', '10-18', ''],
  ];
  const result = parseExcelGrid(grid, '2026-08-17');
  assert.deepEqual(result.rows.filter((r) => r.employeeName === 'Test Beta').map((r) => r.roleName), ['']);
  assert.ok(!result.anomalies.some((a) => a.rawText === '12'));
});

test('an employee-ID column before the names is not a title column', () => {
  const grid = [
    ['', '', 'Mon', 'Tue'],
    ['SUPERVISORS', '', '', ''],
    ['1042', 'Test Alpha', '9-17', ''],
    ['1043', 'Test Beta', '', '10-18'],
  ];
  const result = parseExcelGrid(grid, '2026-08-17');
  assert.deepEqual(result.people?.map((p) => `${p.name}|${p.roleLabel}`), ['Test Alpha|SUPERVISORS', 'Test Beta|SUPERVISORS']);
});

// --- round 2: column order, totals lines and titles in the name column -------------------------

test('NAME / TITLE headings over the leading columns decide which is which, in either order', () => {
  for (const nameFirst of [true, false]) {
    const lead = (name: string, title: string) => (nameFirst ? [name, title] : [title, name]);
    const grid = [
      [...lead('NAME', 'TITLE'), 'Mon 13/04', 'Tue 14/04'],
      [...lead('Test Alpha', 'Supervisor'), '9-17', 'OFF'],
      [...lead('Test Beta', 'Head waiter 1'), 'OFF', '4pm to 2am'],
      [...lead('Test Gamma', 'Bartender'), 'UL', 'UL'],
    ];
    const result = parseExcelGrid(grid, '2026-04-13', { today: '2026-10-07', clientWeekStart: null });
    assert.deepEqual(result.people?.map((p) => `${p.name}|${p.roleLabel}`), ['Test Alpha|Supervisor', 'Test Beta|Head waiter 1', 'Test Gamma|Bartender'], `name first: ${nameFirst}`);
  }
});

test('a totals line under the grid ("Total staff on rota 22" with per-day counts) is never a person', () => {
  const grid = [
    ['', '17-Aug', '18-Aug'],
    ['Test Alpha', '9-17', ''],
    ['Test Beta', '', '10-18'],
    ['Total staff on rota 2', '1', '1'],
    ['Number of staff', '1', '1'],
  ];
  const result = parseExcelGrid(grid, '2026-08-17');
  assert.deepEqual(result.people?.map((p) => p.name), ['Test Alpha', 'Test Beta']);
  assert.deepEqual(result.anomalies, []);
});

test('a title where a name should be is never a person: its shifts are an unread row; a row with the two the other way round is read', () => {
  const single = parseExcelGrid([['', 'Mon', 'Tue'], ['Test Alpha', '9-17', ''], ['Waiter 3', '10-18', '']], '2026-08-17');
  assert.deepEqual(single.people?.map((p) => p.name), ['Test Alpha']);
  assert.match(single.unreadRows![0]!.reason, /title or role/);
  const twoCols = parseExcelGrid(
    [
      ['', '', 'Mon', 'Tue'],
      ['RM', 'Test Alpha', '9-17', ''],
      ['Test Beta', 'Waiter 2', '', '10-18'], // this one row has name and title the other way round
      ['Runner 1', 'Test Gamma', '11-19', ''],
    ],
    '2026-08-17',
  );
  assert.deepEqual(twoCols.people?.map((p) => `${p.name}|${p.roleLabel}`), ['Test Alpha|RM', 'Test Beta|Waiter 2', 'Test Gamma|Runner 1']);
});
