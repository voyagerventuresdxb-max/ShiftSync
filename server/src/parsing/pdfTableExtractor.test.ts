import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { extractPdfGrid, hasPdfTextLayer } from './pdfTableExtractor.js';
import { parseExcelGrid } from './deterministicGridParser.js';

const WEEK_START = '2026-08-17';

async function buildPdf(items: { text: string; x: number; y: number }[], size = 10): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([700, 400]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const item of items) {
    page.drawText(item.text, { x: item.x, y: item.y, size, font });
  }
  return Buffer.from(await doc.save());
}

async function buildMultiPagePdf(pages: { text: string; x: number; y: number }[][], size = 10): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const items of pages) {
    const page = doc.addPage([700, 400]);
    for (const item of items) {
      page.drawText(item.text, { x: item.x, y: item.y, size, font });
    }
  }
  return Buffer.from(await doc.save());
}

test('real reference-venue PDF: full pipeline (extractPdfGrid -> parseExcelGrid) reproduces the known-correct structure', async () => {
  const buffer = readFileSync('server/test-fixtures/real-roster.pdf');

  assert.equal(await hasPdfTextLayer(buffer), true);

  const grid = await extractPdfGrid(buffer);
  const result = parseExcelGrid(grid, WEEK_START);

  assert.equal(result.templateLabel, 'Deterministic Grid Parser');
  // Matches the count independently validated against the live Gemini VLM
  // path after the overnight-hour schema fix (5-run mean 167.6, stdev 2.9) —
  // this deterministic reconstruction lands inside that range, with zero
  // run-to-run variance since there's no model call involved.
  assert.equal(result.rows.length, 160);

  const roleByStaff: Record<string, Set<string>> = {};
  for (const r of result.rows) {
    (roleByStaff[r.employeeName] ??= new Set()).add(r.roleName);
  }
  const roleOf = (name: string) => [...(roleByStaff[name] ?? [])];

  // The 3 unlabeled management rows (no section header above them in the
  // source file) must resolve to "" (flagged for manual review), never a
  // borrowed label from elsewhere on the sheet — the original "COVERS" bug.
  assert.deepEqual(roleOf('Andrea'), ['']);
  assert.deepEqual(roleOf('Roberto'), ['']);
  assert.deepEqual(roleOf('Alessandro'), ['']);

  // Section-headered staff resolve to their real printed section, even
  // though on this reconstructed PDF grid the header text lands in a
  // middle column (not the name column) and shares a row with an unrelated
  // stray number.
  assert.deepEqual(roleOf('Pratik'), ['SUPERVISORS']);
  assert.deepEqual(roleOf('Derrick'), ['SUPERVISORS']);
  assert.deepEqual(roleOf('Rojina'), ['HEAD WAITERS']);
  assert.deepEqual(roleOf('Hefny'), ['WAITERS']);
  assert.deepEqual(roleOf('Bashkar'), ['RUNNERS']);

  // Staff with zero shifts this week (on leave/PH all week) must never be
  // mistaken for a role-section header and must not appear as shift rows.
  for (const shiftless of ['Sintia', 'Tomas', 'Irma', 'Tatenda', 'Rowel']) {
    assert.equal(roleByStaff[shiftless], undefined, `${shiftless} should have 0 shift rows`);
  }

  // Sintia and Tomas both have a recognizable leave code sharing their row
  // in the reconstructed grid's trailing column ("PH", "Request") and zero
  // shift data, so they're surfaced as leave records instead of silently
  // vanishing. NOTE: on this specific real file, that trailing column is
  // actually a static legend/key box (11 fixed entries, independently
  // confirmed against the earlier VLM-extracted legend) that coincidentally
  // shares row-alignment with these two employees, not a genuine per-row
  // annotation — even the Gemini vision path (reading real cell colours)
  // produced 0 leave records for this exact file. Surfacing it anyway is
  // the correct tradeoff: a manager reviewing "Sintia — PH" can dismiss a
  // coincidence in a few seconds, which is strictly better than the
  // previous behaviour of Sintia disappearing from the roster with zero
  // explanation. Irma/Tatenda/Rowel have no such coincidence and correctly
  // produce no leave record at all.
  assert.deepEqual(
    result.leaveRecords.map((r) => `${r.employeeName}:${r.leaveCode}`).sort(),
    ['Sintia:PH', 'Tomas:Request'],
  );

  // The only 2 anomalies should be the non-employee "COVERS" covers-count
  // row's two unparseable annotation cells, correctly flagged rather than
  // silently dropped or misread as a real shift.
  assert.equal(result.anomalies.length, 2);
  assert.ok(result.anomalies.every((a) => a.employeeName === 'COVERS'));
});

test('multi-line cell: a role header wrapped across two lines is reconstructed as one label', async () => {
  const buffer = await buildPdf([
    { text: '17-Aug', x: 100, y: 380 },
    { text: '18-Aug', x: 200, y: 380 },
    { text: '19-Aug', x: 300, y: 380 },
    { text: 'Fatima', x: 20, y: 360 },
    { text: '9-17', x: 100, y: 360 },
    // "HEAD WAITERS" printed as two wrapped lines in the name column, the
    // second line sitting unusually close beneath the first (8pt) compared
    // to the page's normal ~20pt row spacing.
    { text: 'HEAD', x: 20, y: 340 },
    { text: 'WAITERS', x: 20, y: 332 },
    { text: 'Yusuf', x: 20, y: 312 },
    { text: '10-14', x: 100, y: 312 },
  ]);

  const grid = await extractPdfGrid(buffer);
  const headerRowText = grid.find((row) => row[0] === 'HEAD WAITERS');
  assert.ok(headerRowText, `expected a single merged "HEAD WAITERS" row in grid: ${JSON.stringify(grid)}`);

  const result = parseExcelGrid(grid, WEEK_START);
  const yusuf = result.rows.filter((r) => r.employeeName === 'Yusuf');
  assert.equal(yusuf.length, 1);
  assert.equal(yusuf[0].roleName, 'HEAD WAITERS');
  assert.equal(yusuf[0].startTime, '10:00');
  assert.equal(yusuf[0].endTime, '14:00');

  const fatima = result.rows.filter((r) => r.employeeName === 'Fatima');
  assert.equal(fatima.length, 1);
  // Fatima sits above the header -> unresolved, never borrows a nearby label.
  assert.equal(fatima[0].roleName, '');
});

// Regression: a text-layer PDF with NO day-header row (a long-format
// "one row per shift" export, or free text) produced zero column anchors,
// and buildRawGrid then did `cells[0].push(...)` on an empty array —
// TypeError, 500 on POST /api/schedules/upload for the whole file, instead
// of the text-parser/vision fallback the upload route already has for
// exactly this shape. The route only takes that fallback when
// parseExcelGrid does NOT label the result 'Deterministic Grid Parser', so
// both halves are asserted here.
test('a text-layer PDF with no day-header row (long-format export) resolves to an empty grid instead of throwing', async () => {
  const buffer = await buildPdf([
    { text: 'Employee', x: 20, y: 380 },
    { text: 'Role', x: 140, y: 380 },
    { text: 'Date', x: 240, y: 380 },
    { text: 'Start', x: 340, y: 380 },
    { text: 'End', x: 420, y: 380 },
    { text: 'Fatima', x: 20, y: 360 },
    { text: 'Waiter', x: 140, y: 360 },
    { text: '2026-08-17', x: 240, y: 360 },
    { text: '09:00', x: 340, y: 360 },
    { text: '17:00', x: 420, y: 360 },
  ]);

  assert.equal(await hasPdfTextLayer(buffer), true);
  const grid = await extractPdfGrid(buffer);
  assert.deepEqual(grid, []);
  assert.notEqual(parseExcelGrid(grid, WEEK_START).templateLabel, 'Deterministic Grid Parser');
});

test('sample-roster.pdf (the long-format fixture that 500ed the upload route) no longer throws in extractPdfGrid', async () => {
  const buffer = readFileSync('server/test-fixtures/sample-roster.pdf');

  assert.equal(await hasPdfTextLayer(buffer), true);
  await assert.doesNotReject(() => extractPdfGrid(buffer));
  const grid = await extractPdfGrid(buffer);
  assert.notEqual(parseExcelGrid(grid, WEEK_START).templateLabel, 'Deterministic Grid Parser');
});

// Regression (PR #17 review): DAY_HEADER_RE's `\d{1,2}[-/]\d{1,2}` date
// branch (meant for "17-08") also matches an ordinary shift-time-range cell
// like "10-18". A single data row with two SCATTERED matches (not sitting
// next to each other) used to be enough to make `findAnchorRow` mistake it
// for a real day-header row, deriving garbage column anchors from a row
// that was never a header at all — worse than the crash this file's other
// regression tests cover, because it doesn't throw and doesn't fall
// through to the fallback: `parseExcelGrid` still labels the corrupted
// result 'Deterministic Grid Parser' (looks like a successful parse) while
// silently returning 0 rows.
test('a data row with two scattered time-range cells is not mistaken for a day-header row', async () => {
  const buffer = await buildPdf([
    { text: 'Youssef', x: 20, y: 380 },
    { text: '10-18', x: 140, y: 380 },
    { text: 'OFF', x: 240, y: 380 },
    { text: '10-18', x: 340, y: 380 },
  ]);

  assert.equal(await hasPdfTextLayer(buffer), true);
  const grid = await extractPdfGrid(buffer);
  assert.deepEqual(grid, []);
  assert.notEqual(parseExcelGrid(grid, WEEK_START).templateLabel, 'Deterministic Grid Parser');
});

// Regression (PR #17 review): a real multi-page roster export where only
// page 1 repeats the day-header row — page 2 is a continuation with more
// staff and no header of its own. Before this fix, page 2 either crashed
// (pre-52f8c0f) or, worse, got silently dropped/corrupted (the anchors.length
// === 0 fix alone, or a false-positive anchor row derived from page 2's own
// shift-time cells). This proves page 2's staff now survive by reusing
// page 1's confidently-derived column anchors.
test('multi-page PDF: a continuation page with no repeated day-header still parses using page 1\'s anchors', async () => {
  const buffer = await buildMultiPagePdf([
    [
      { text: 'Monday', x: 140, y: 380 },
      { text: 'Tuesday', x: 240, y: 380 },
      { text: 'Wednesday', x: 340, y: 380 },
      { text: 'Fatima', x: 20, y: 360 },
      { text: '9-17', x: 140, y: 360 },
      { text: '9-17', x: 240, y: 360 },
      { text: 'OFF', x: 340, y: 360 },
    ],
    [
      // No header row on this page at all — and neither data row has 3
      // consecutive date-shaped cells, so this also isn't a case the
      // header-detection tightening alone would rescue; only the carried-
      // forward anchors do.
      { text: 'Youssef', x: 20, y: 380 },
      { text: '10-18', x: 140, y: 380 },
      { text: 'OFF', x: 240, y: 380 },
      { text: '10-18', x: 340, y: 380 },
      { text: 'Layla', x: 20, y: 360 },
      { text: '9-17', x: 140, y: 360 },
      { text: '9-17', x: 240, y: 360 },
      { text: 'OFF', x: 340, y: 360 },
    ],
  ]);

  assert.equal(await hasPdfTextLayer(buffer), true);
  const grid = await extractPdfGrid(buffer);
  const result = parseExcelGrid(grid, WEEK_START);
  assert.equal(result.templateLabel, 'Deterministic Grid Parser');

  const names = result.rows.map((r) => r.employeeName);
  assert.ok(names.includes('Fatima'), `expected Fatima (page 1) in parsed rows: ${JSON.stringify(names)}`);
  assert.ok(names.includes('Youssef'), `expected Youssef (page 2) in parsed rows, not silently dropped: ${JSON.stringify(names)}`);
  assert.ok(names.includes('Layla'), `expected Layla (page 2) in parsed rows, not silently dropped: ${JSON.stringify(names)}`);

  const youssef = result.rows.filter((r) => r.employeeName === 'Youssef');
  assert.ok(youssef.some((r) => r.startTime === '10:00' && r.endTime === '18:00'));
});

test('inconsistent row spacing: irregular gaps between data rows still split into distinct rows, not merged', async () => {
  const buffer = await buildPdf([
    { text: '17-Aug', x: 100, y: 380 },
    { text: '18-Aug', x: 200, y: 380 },
    { text: '19-Aug', x: 300, y: 380 },
    { text: 'Fatima', x: 20, y: 360 }, // normal 20pt gap from header
    { text: '9-17', x: 100, y: 360 },
    { text: 'Yusuf', x: 20, y: 325 }, // wide 35pt gap (an extra visual blank line)
    { text: '10-14', x: 100, y: 325 },
    { text: 'Chen', x: 20, y: 311 }, // tight 14pt gap, but BOTH columns populated -> a real row, not a continuation
    { text: '11-15', x: 100, y: 311 },
    { text: '9-17', x: 200, y: 311 }, // second populated column on Chen's row specifically, so it can never look like a single-column continuation
  ]);

  const grid = await extractPdfGrid(buffer);
  const result = parseExcelGrid(grid, WEEK_START);

  const byName = (name: string) => result.rows.filter((r) => r.employeeName === name);
  assert.equal(byName('Fatima').length, 1);
  assert.equal(byName('Yusuf').length, 1);
  assert.equal(byName('Chen').length, 2);
  assert.ok(byName('Chen').some((r) => r.startTime === '11:00' && r.endTime === '15:00'));
  assert.ok(byName('Chen').some((r) => r.startTime === '09:00' && r.endTime === '17:00'));
  assert.equal(result.anomalies.length, 0);
});
