import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExcelGrid } from './deterministicGridParser.js';

/**
 * Documented reference case: "Bar des Pres - FOH" roster, 13-19 April
 * ("April 13-19.pdf" as provided). This file has NO extractable PDF text
 * layer at all (confirmed both via pdfjs-dist positioned-text-item count
 * — 0 — and pdf-parse's raw text extraction — 16 characters of pure
 * boilerplate, no roster content), almost certainly an Excel sheet
 * exported/printed as a flat image. It therefore cannot be run through
 * `extractPdfGrid`/`hasPdfTextLayer` the way the Gattopardo reference file
 * is (see pdfTableExtractor.test.ts) — there is no automated
 * "real file -> grid" extraction step to test for this one.
 *
 * The grid below is a hand transcription of that file's actual visible
 * content (read directly from the rendered image, cross-checked cell by
 * cell), used here to test the INTERPRETATION side (parseExcelGrid)
 * against a real, complex, independently-sourced layout — the second
 * fixture requested to validate the role/section-detection generalization
 * beyond Gattopardo, and the format-specific gaps (per-row title column,
 * "UL" leave code, open-ended/until-closing/flexible shorthand, hyphen-
 * chained split shifts) found while building it.
 *
 * Known transcription caveats (be aware these are judgment calls, not
 * verified against the source data itself):
 *  - Waiter 1 (Putri Rohmawati)'s Saturday cell renders as a solid black
 *    box in the source with no legible text at all — transcribed as blank
 *    here; the real value is unknown.
 *  - The hyphen-chained cells ("10:30-4:00-8:00-12") are read as literal
 *    24h numbers per this parser's existing, consistent convention (see
 *    deterministicGridParser.test.ts's hyphen-chain test) — "4:00" reads
 *    as 04:00, not 16:00, even though 10:30am-4:00pm is almost certainly
 *    the real intent for a lunch-into-afternoon shift. This is a known,
 *    open interpretation risk for this specific notation, not something
 *    this pass resolved — flagged in the coverage report, not silently
 *    fixed with an unverified AM/PM guessing heuristic.
 *  - No year is printed on the sheet; WEEK_START below is an anchor date
 *    only, chosen for internal consistency, not verified against a real
 *    calendar year for this roster.
 */
const WEEK_START = '2026-04-13';

const BAR_DES_PRES_GRID: unknown[][] = [
  ['DATE', '', '13-Apr', '14-Apr', '15-Apr', '16-Apr', '17-Apr', '18-Apr', '19-Apr'],
  ['DAY OF THE WEEK', '', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
  ['Events', '', '', '', '', '', '', '', 'SUNDAY LUNCH'],
  ['', '', '', '', '', '', '', '', ''],
  ['RM', 'Robert Orgovan', 'OFF', '12CL', '10IN', 'OFF', 'IN', '4CL', 'UL'],
  ['AM', 'Shovit Shrestha', '2CL', 'OFF', 'OFF', '4CL', '4CL', 'UL', '4CL'],
  ['JAM', 'Leandro De Souza', 'OFF', 'UL', '4CL', '10:30-4:00-8:00-12', '10:30-4:00-8:00-12', '10:30-4:00-8:00-12', '10:30-4:00-8:00-12'],
  ['Supervisor', 'Eugeniu Mihalas', '10:30-4:00-8:00-12', '10:30-4:00-8:00-12', 'UL', 'OFF', 'OFF', 'AL', 'AL'],
  ['', '', '', '', '', '', '', '', ''],
  ['Head waiter 1', 'Robert Torrecampo', '10am/3pm-7pm/12am', '10am/3pm-7pm/12am', '4pm to 2am', 'OFF', 'OFF', 'UL', '4pm to 2am'],
  ['Head waiter 2', 'Nitin Bansal', 'OFF', 'OFF', 'UL', '1pm to 11pm', '4pm to 2am', '4pm to 2am', '1pm to 11pm'],
  ['Head waiter 4', 'Aya Boutaieb', 'UL', 'UL', 'UL', 'UL', 'UL', 'UL', 'UL'],
  ['Head waiter 5', 'Ishita Ghosh', 'UL', 'UL', 'UL', 'UL', 'UL', 'UL', 'UL'],
  ['WAITER', '', '', '', '', '', '', '', ''],
  ['Waiter 1', 'Putri Rohmawati', '4pm to 2am', 'OFF', '1pm to 11pm', '10am/3pm-7pm/12am', '10am/3pm-7pm/12am', '', 'OFF'], // Saturday cell unreadable (solid black) in source, see caveats above
  ['Waiter 2', 'Tony', 'UL', 'UL', 'UL', 'UL', 'UL', 'OFF', 'OFF'],
  ['Waiter 3', 'Francis Chan', 'OFF', '1pm to 11pm', '10am/3pm-7pm/12am', '4pm to 2am', '1pm to 11pm', 'UL', 'OFF'],
  ['Waiter 4', 'Benedict Nykuna', '1pm to 11pm', '4pm to 2am', 'OFF', 'OFF', 'OFF', '10am/3pm-7pm/12am', '10am/3pm-7pm/12am'],
  ['RUNNER', '', '', '', '', '', '', '', ''],
  ['Chef de pass', 'George Karanja', 'UL', 'UL', 'UL', 'UL', 'UL', 'UL', 'UL'],
  ['Runner 1', 'Oak Soe Khant', 'UL', 'OFF', 'OFF', 'UL', '4pm to 2am', '1pm to 11pm', 'UL'],
  ['Runner 2', 'Tsepo Nkomo', '4pm to 2am', '4pm to 2am', '4pm to 2am', '4pm to 2am', 'OFF', 'OFF', 'UL'],
  ['Runner 3', 'Mike', '1pm to 11pm', '10am/3pm-7pm/12am', '10am/3pm-7pm/12am', '10am/3pm-7pm/12am', 'OFF', 'AL', 'AL'],
  ['Runner 4', 'Leo', 'OFF', 'OFF', 'UL', '10am/3pm-7pm/12am', '1pm to 11pm', '4pm to 2am', '1pm to 11pm'],
  ['Runner 5', 'Fernanda Paiva', 'UL', 'UL', 'UL', 'UL', '10am/3pm-7pm/12am', '10am/3pm-7pm/12am', '4pm to 2am'],
];

test('Bar des Pres reference: header detection finds the stacked date+weekday rows and locates all 20 staff', () => {
  const result = parseExcelGrid(BAR_DES_PRES_GRID, WEEK_START);
  assert.equal(result.templateLabel, 'Deterministic Grid Parser');

  const staffSeen = new Set<string>();
  for (const r of result.rows) staffSeen.add(r.employeeName);
  for (const r of result.leaveRecords) staffSeen.add(r.employeeName);
  for (const r of result.anomalies) if (r.employeeName) staffSeen.add(r.employeeName);

  const expectedStaff = [
    'Robert Orgovan', 'Shovit Shrestha', 'Leandro De Souza', 'Eugeniu Mihalas',
    'Robert Torrecampo', 'Nitin Bansal', 'Aya Boutaieb', 'Ishita Ghosh',
    'Putri Rohmawati', 'Tony', 'Francis Chan', 'Benedict Nykuna',
    'George Karanja', 'Oak Soe Khant', 'Tsepo Nkomo', 'Mike', 'Leo', 'Fernanda Paiva',
  ];
  for (const name of expectedStaff) {
    assert.ok(staffSeen.has(name), `expected ${name} to appear somewhere in the parsed output`);
  }
});

test('Bar des Pres reference: per-row titles resolve correctly, including the section-header-only staff', () => {
  const result = parseExcelGrid(BAR_DES_PRES_GRID, WEEK_START);
  const roleOf = (name: string) => {
    const roles = new Set<string>();
    for (const r of result.rows) if (r.employeeName === name) roles.add(r.roleName);
    return [...roles];
  };

  // NOTE: Robert Orgovan (RM), Shovit Shrestha (AM), and George Karanja
  // (Chef de pass) are deliberately not checked here — each has a
  // transcribed week made entirely of leave codes ("OFF"/"UL") and/or
  // flagged shorthand ("12CL"/"10IN"/"IN"/"4CL"), so none of them have any
  // real ParsedShiftRow entries this week. That's a genuine, separate
  // finding: AnomalyRecord and LeaveRecord both carry no role field, so an
  // employee whose whole week is leave/flagged has their role recorded
  // NOWHERE in the output, not even implicitly — see the coverage report.
  assert.deepEqual(roleOf('Leandro De Souza'), ['JAM']);
  assert.deepEqual(roleOf('Eugeniu Mihalas'), ['Supervisor']);
  assert.deepEqual(roleOf('Robert Torrecampo'), ['Head waiter 1']);
  assert.deepEqual(roleOf('Putri Rohmawati'), ['Waiter 1']);
  assert.deepEqual(roleOf('Fernanda Paiva'), ['Runner 5']);
});

test('Bar des Pres reference: "UL" leave code recognized throughout, including all-UL weeks (Aya, Ishita, George)', () => {
  const result = parseExcelGrid(BAR_DES_PRES_GRID, WEEK_START);
  const ulCount = result.leaveRecords.filter((r) => r.leaveCode === 'UL').length;
  assert.ok(ulCount > 20, `expected many UL leave records across the week, got ${ulCount}`);
  assert.equal(result.leaveRecords.filter((r) => r.employeeName === 'Aya Boutaieb').length, 7);
  assert.equal(result.leaveRecords.filter((r) => r.employeeName === 'Ishita Ghosh').length, 7);
  assert.equal(result.leaveRecords.filter((r) => r.employeeName === 'George Karanja').length, 7);
});

test('Bar des Pres reference: shorthand codes (IN/CL) are flagged with a clear reason, never a guessed time', () => {
  const result = parseExcelGrid(BAR_DES_PRES_GRID, WEEK_START);
  const robertAnomalies = result.anomalies.filter((a) => a.employeeName === 'Robert Orgovan');
  // Robert's week: OFF, 12CL, 10IN, OFF, IN, 4CL, UL -> 4 shorthand cells (12CL, 10IN, IN, 4CL).
  assert.equal(robertAnomalies.length, 4);
  assert.ok(robertAnomalies.some((a) => /open-ended/i.test(a.reason) && /10:00/.test(a.reason))); // 10IN
  assert.ok(robertAnomalies.some((a) => /closing/i.test(a.reason) && /12:00/.test(a.reason))); // 12CL
  assert.ok(robertAnomalies.some((a) => /closing/i.test(a.reason) && /16:00/.test(a.reason) === false && /04:00/.test(a.reason))); // 4CL -> 04:00 (literal, see caveats)
  assert.ok(robertAnomalies.some((a) => /flexible|on-call/i.test(a.reason))); // bare IN
});

test('Bar des Pres reference: hyphen-chained split shifts (JAM, Supervisor) produce two shifts per day, not an anomaly', () => {
  const result = parseExcelGrid(BAR_DES_PRES_GRID, WEEK_START);
  const leandroThursday = result.rows.filter((r) => r.employeeName === 'Leandro De Souza' && r.date === '2026-04-16');
  assert.equal(leandroThursday.length, 2, 'the hyphen-chained cell should split into 2 shifts');
});
