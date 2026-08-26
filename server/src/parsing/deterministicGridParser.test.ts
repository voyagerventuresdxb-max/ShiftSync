import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { parseExcelGrid } from './deterministicGridParser.js';
import { buildMergeExpandedGrid } from './parseWorkbook.js';

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
    ['Andrea', '11 17 18 25', '12 17 18 24'],
    ['SUPERVISORS', 'SUPERVISORS', 'SUPERVISORS'],
    ['Pratik', '16 18 18.5 26', '11 16 18 24'],
  ];

  const result = parseExcelGrid(grid, WEEK_START);
  assert.equal(result.anomalies.length, 0);

  const andrea = result.rows.filter((r) => r.employeeName === 'Andrea');
  assert.equal(andrea.length, 4);
  assert.deepEqual(
    andrea.map((r) => `${r.date} ${r.startTime}-${r.endTime} overnight=${r.overnight}`).sort(),
    [
      '2026-08-17 11:00-17:00 overnight=false',
      '2026-08-17 18:00-01:00 overnight=true',
      '2026-08-18 12:00-17:00 overnight=false',
      '2026-08-18 18:00-00:00 overnight=true',
    ].sort(),
  );
  // Andrea sits above any role header -> role stays unresolved, never
  // borrowed from elsewhere on the sheet — surfaced as a warning, not
  // silently guessed or silently dropped.
  assert.ok(andrea.every((r) => r.roleName === ''));
  assert.ok(result.issues.some((i) => i.severity === 'warning' && i.message.includes('Andrea')));

  const pratik = result.rows.filter((r) => r.employeeName === 'Pratik');
  assert.equal(pratik.length, 4);
  assert.ok(pratik.every((r) => r.roleName === 'SUPERVISORS'));
  assert.deepEqual(
    pratik.map((r) => `${r.date} ${r.startTime}-${r.endTime} overnight=${r.overnight}`).sort(),
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
    ['Andrea', '9-17', '9-17'],
    ['8', '5', '4'], // headcount summary row, as seen at the bottom of the real reference venue's rota
  ];
  const result = parseExcelGrid(grid, WEEK_START);
  assert.equal(result.rows.length, 2);
  assert.ok(result.rows.every((r) => r.employeeName === 'Andrea'));
});

test('unresolvable cell content becomes an anomaly, not a hallucinated shift', () => {
  // findHeaderRows requires >=2 date-like header cells to recognize a
  // day-header row at all (avoids false-positiving on a single stray
  // date-looking cell elsewhere on the sheet), so this needs 2 day columns
  // even though only one is exercised.
  const grid: unknown[][] = [
    ['', 'Monday', 'Tuesday'],
    ['Andrea', 'XyzGarbage', ''],
  ];
  const result = parseExcelGrid(grid, WEEK_START);
  assert.equal(result.rows.length, 0);
  assert.equal(result.anomalies.length, 1);
  assert.equal(result.anomalies[0].rawText, 'XyzGarbage');
});

test('leave/absence codes become leave records, not shifts or anomalies', () => {
  const grid: unknown[][] = [
    ['', 'Monday', 'Tuesday'],
    ['Andrea', 'OFF', 'PH'],
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
    ['Andrea', '9-17', '9-17', 'Closing'], // worked normally -> trailing note must NOT become a leave record
    ['Sintia', '', '', 'PH'], // zero shifts, notes column has a known leave code -> surfaced as a leave record
    ['Tomas', '', '', 'Request'],
    ['Irma', '', '', ''], // zero shifts, no note at all -> correctly produces nothing
  ];
  const result = parseExcelGrid(grid, WEEK_START);

  assert.equal(result.rows.length, 2); // Andrea's 2 days x 1 shift each
  assert.ok(result.rows.every((r) => r.employeeName === 'Andrea'));

  assert.deepEqual(
    result.leaveRecords.map((r) => `${r.employeeName}:${r.leaveCode}:${r.category}`).sort(),
    ['Sintia:PH:public_holiday', 'Tomas:Request:day_off'],
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
    ['Andrea', '9-17', '9-17'],
    ['RUNNERS', '', ''],
    ['Bashkar', '13-21', '13-21'],
  ];
  const result = parseExcelGrid(grid, WEEK_START);
  const andrea = result.rows.filter((r) => r.employeeName === 'Andrea');
  assert.equal(andrea.length, 2);
  assert.ok(andrea.every((r) => r.roleName === ''));
  const bashkar = result.rows.filter((r) => r.employeeName === 'Bashkar');
  assert.ok(bashkar.every((r) => r.roleName === 'RUNNERS'));
  // "COVERS" itself is treated as a (non-real) staff row, same as before,
  // producing an anomaly for its unparseable cell rather than a shift.
  assert.ok(result.anomalies.some((a) => a.employeeName === 'COVERS'));
});

test('per-row title column (Bar des Pres FOH style): role comes from column A, name from column B', () => {
  // Day columns start at index 2 (not 1) -> the parser should infer a
  // title column at 0 and a name column at 1, rather than assuming column
  // 0 is always the name.
  const grid: unknown[][] = [
    ['', '', 'Monday', 'Tuesday'],
    ['RM', 'Robert Orgovan', '9-17', '9-17'],
    ['Supervisor', 'Eugeniu Mihalas', '10-18', '10-18'],
    ['WAITER', '', '', ''], // section banner: title+name both blank, spans nothing useful
    ['Waiter 1', 'Putri Rohmawati', '11-19', '11-19'],
  ];
  const result = parseExcelGrid(grid, WEEK_START);
  assert.equal(result.rows.length, 6);
  assert.ok(result.rows.filter((r) => r.employeeName === 'Robert Orgovan').every((r) => r.roleName === 'RM'));
  assert.ok(result.rows.filter((r) => r.employeeName === 'Eugeniu Mihalas').every((r) => r.roleName === 'Supervisor'));
  // Per-row title takes precedence over the section banner above it, even
  // though "WAITER" was itself independently recognized as a header.
  assert.ok(result.rows.filter((r) => r.employeeName === 'Putri Rohmawati').every((r) => r.roleName === 'Waiter 1'));
});

test('per-row title falls back to the section-derived role when a row has no title of its own', () => {
  const grid: unknown[][] = [
    ['', '', 'Monday', 'Tuesday'],
    ['RUNNER', '', '', ''],
    ['', 'Fernanda Paiva', '9-17', '9-17'], // blank title cell -> should inherit "RUNNER"
  ];
  const result = parseExcelGrid(grid, WEEK_START);
  const fernanda = result.rows.filter((r) => r.employeeName === 'Fernanda Paiva');
  assert.equal(fernanda.length, 2);
  assert.ok(fernanda.every((r) => r.roleName === 'RUNNER'));
});

test('"UL" is recognized as Unpaid Leave', () => {
  const grid: unknown[][] = [
    ['', 'Monday', 'Tuesday'],
    ['Tony', 'UL', 'UL'],
  ];
  const result = parseExcelGrid(grid, WEEK_START);
  assert.equal(result.rows.length, 0);
  assert.equal(result.leaveRecords.length, 2);
  assert.ok(result.leaveRecords.every((r) => r.category === 'leave' && r.leaveCode === 'UL'));
});

test('open-ended ("<N>IN"), until-closing ("<N>CL"), and fully-flexible ("IN") shorthand are flagged with a clear reason, not forced into a fake shift', () => {
  const grid: unknown[][] = [
    ['', 'Monday', 'Tuesday', 'Wednesday'],
    ['Robert Orgovan', '10IN', '12CL', 'IN'],
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
    ['Leandro De Souza', '10:30-4:00-8:00-12', ''],
  ];
  const result = parseExcelGrid(grid, WEEK_START);
  assert.equal(result.rows.length, 2);
  assert.deepEqual(
    result.rows.map((r) => `${r.startTime}-${r.endTime}`).sort(),
    ['08:00-12:00', '10:30-04:00'].sort(),
  );
  // Note: bare numbers are read as literal 24h hours (no am/pm inference),
  // consistent with how every other bare-number cell in this parser is
  // handled — see the honesty note in the report about this specific
  // example possibly not matching real intent (10:30am-4:00pm was almost
  // certainly meant, not 10:30pm-4:00am).
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
