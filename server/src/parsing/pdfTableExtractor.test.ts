import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { extractPdfGrid, extractPdfTable, hasPdfTextLayer, MalformedPdfError, pdfPageCount } from './pdfTableExtractor.js';
import { parseExcelGrid } from './deterministicGridParser.js';
import { privateFixture, privateFixtureSkipMessage } from './privateFixtures.js';

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

test('real reference-venue PDF (private, local only): full pipeline (extractPdfGrid -> parseExcelGrid) reproduces the known-correct structure', async (t) => {
  // The real file carries real staff names, so it lives outside the repository and this
  // test asserts only structure (counts and section labels), never names. The synthetic
  // equivalent below covers the same layout for everyone.
  const path = privateFixture('real-roster.pdf');
  if (!path) {
    t.skip(privateFixtureSkipMessage('real-roster.pdf'));
    return;
  }
  const buffer = readFileSync(path);

  assert.equal(await hasPdfTextLayer(buffer), true);

  const grid = await extractPdfGrid(buffer);
  const result = parseExcelGrid(grid, WEEK_START);

  assert.equal(result.templateLabel, 'Deterministic Grid Parser');
  // Matches the count independently validated against the live Gemini VLM
  // path after the overnight-hour schema fix (5-run mean 167.6, stdev 2.9) —
  // this deterministic reconstruction lands inside that range, with zero
  // run-to-run variance since there's no model call involved.
  assert.equal(result.rows.length, 160);

  const rolesByStaff = new Map<string, Set<string>>();
  for (const r of result.rows) {
    if (!rolesByStaff.has(r.employeeName)) rolesByStaff.set(r.employeeName, new Set());
    rolesByStaff.get(r.employeeName)!.add(r.roleName);
  }
  // 16 staff with shifts; nobody ends up under two sections.
  assert.equal(rolesByStaff.size, 16);
  assert.ok([...rolesByStaff.values()].every((roles) => roles.size === 1));
  const staffPerRole: Record<string, number> = {};
  for (const roles of rolesByStaff.values()) for (const role of roles) staffPerRole[role] = (staffPerRole[role] ?? 0) + 1;
  // The 3 unlabeled management rows (no section header above them in the source file)
  // resolve to "" (flagged for manual review), never a borrowed label — the original
  // "COVERS" bug. Section-headered staff resolve to their real printed section, even though
  // on this reconstructed grid the header text lands in a middle column beside a stray number.
  assert.deepEqual(staffPerRole, { '': 3, SUPERVISORS: 2, 'HEAD WAITERS': 3, WAITERS: 1, RUNNERS: 7 });

  // Every person is read, including the 5 with no times all week (their week is shown only
  // by cell colour): 21 people, in the sections they are printed under.
  assert.equal(result.people?.length, 21);
  const peoplePerSection: Record<string, number> = {};
  for (const p of result.people ?? []) peoplePerSection[p.section ?? ''] = (peoplePerSection[p.section ?? ''] ?? 0) + 1;
  assert.deepEqual(peoplePerSection, { '': 4, SUPERVISORS: 3, 'HEAD WAITERS': 4, WAITERS: 2, RUNNERS: 8 });

  // The colour key to the right runs alongside banner and headcount rows too, so it is read
  // as a key, never as anyone's leave; the COVERS caption is not a person and not an anomaly.
  assert.deepEqual(result.leaveRecords, []);
  assert.deepEqual(result.anomalies, []);
});

test('synthetic reference-layout PDF (public stand-in for the real file): the same structure comes through', async () => {
  // server/test-fixtures/synthetic/text-roster.pdf — made-up names, the real file's layout
  // features (server/scripts/make-synthetic-roster-fixtures.mjs): a COVERS caption above the
  // listing, 3 unlabeled management rows, section headers printed in a middle column beside a
  // stray headcount number, AM/PM "11 17 18 25" cells, a blank-week employee inside a section,
  // and a legend box in a trailing column that lines up with staff rows.
  const buffer = readFileSync('server/test-fixtures/synthetic/text-roster.pdf');
  assert.equal(await hasPdfTextLayer(buffer), true);
  const result = parseExcelGrid(await extractPdfGrid(buffer), WEEK_START);

  assert.equal(result.templateLabel, 'Deterministic Grid Parser');
  assert.equal(result.rows.length, 69);
  const roleOf = (name: string) => [...new Set(result.rows.filter((r) => r.employeeName === name).map((r) => r.roleName))];
  for (const name of ['Test Manager Avery', 'Test Manager Blake', 'Test Manager Casey']) assert.deepEqual(roleOf(name), ['']);
  assert.deepEqual(roleOf('Test Supervisor Dana'), ['SUPERVISORS']);
  assert.deepEqual(roleOf('Test Supervisor Ellis'), ['SUPERVISORS']);
  assert.deepEqual(roleOf('Test Head Finley'), ['HEAD WAITERS']);
  assert.deepEqual(roleOf('Test Head Harper'), ['HEAD WAITERS']); // the blank-week row above did not become a header
  assert.deepEqual(roleOf('Test Waiter Indigo'), ['WAITERS']);
  assert.deepEqual(roleOf('Test Runner Morgan'), ['RUNNERS']);
  // Blank-week staff produce no shift rows.
  for (const name of ['Test Head Gray', 'Test Runner Kai', 'Test Runner Lee']) assert.deepEqual(roleOf(name), []);
  // AM/PM pairs become two shifts, the evening one overnight.
  const firstDay = result.rows.filter((r) => r.employeeName === 'Test Manager Avery' && r.date === '2026-08-17');
  assert.deepEqual(firstDay.map((r) => `${r.startTime}-${r.endTime}${r.overnight ? '+' : ''}`), ['11:00-17:00', '18:00-01:00+']);
  // Legend entries beside shiftless staff surface as leave records; beside working staff they are ignored.
  assert.deepEqual(result.leaveRecords.map((r) => `${r.employeeName}:${r.leaveCode}`).sort(), ['Test Runner Kai:PH', 'Test Runner Lee:Request']);
  // Blank-week staff are still people; the covers caption is neither a person nor an anomaly.
  for (const name of ['Test Head Gray', 'Test Runner Kai', 'Test Runner Lee']) assert.ok(result.people?.some((p) => p.name === name), name);
  assert.ok(!result.people?.some((p) => p.name === 'COVERS'));
  assert.deepEqual(result.anomalies, []);
});

test('synthetic scanned roster (public stand-in for the real scan): image-only, no text layer, not malformed', async () => {
  const buffer = readFileSync('server/test-fixtures/synthetic/scanned-roster.pdf');
  assert.equal(await hasPdfTextLayer(buffer), false);
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

// Regression (QA pass on master post-#17-merge, 2026-09-17): the fix above
// (3+ ADJACENT day-shaped cells) still had a hole — an employee working the
// IDENTICAL shift on 3+ consecutive tracked days, with no day off breaking
// the run, has exactly the same "3 adjacent digit-hyphen-digit cells" shape
// as a real header row. That's not a contrived input: it's an ordinary
// employee with a regular schedule. Before this fix, her own continuation
// page derived a garbage 6-column anchor set from her own row (mistaking
// HER for the header), overwrote the carried-forward anchors from page 1's
// real header, and both she and every other row on that page vanished from
// the result — while the parse still reported itself as a successful
// 'Deterministic Grid Parser'. The real fix is structural, not another
// regex tweak: once a document has a confidently-detected header (from any
// page), no later page's own content is ever allowed to re-derive or
// override it — see extractPdfGrid's "never re-derive once established".
test('multi-page PDF: an employee working the identical shift 3 days running on a continuation page is not mistaken for that page\'s header', async () => {
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
      // Layla is the ONLY row on this page — no header, and no other data
      // row to "dilute" her own shape. Same shift, 3 days running, nothing
      // in between to break the adjacent-match run.
      { text: 'Layla', x: 20, y: 360 },
      { text: '9-17', x: 140, y: 360 },
      { text: '9-17', x: 240, y: 360 },
      { text: '9-17', x: 340, y: 360 },
    ],
  ]);

  assert.equal(await hasPdfTextLayer(buffer), true);
  const grid = await extractPdfGrid(buffer);
  const result = parseExcelGrid(grid, WEEK_START);
  assert.equal(result.templateLabel, 'Deterministic Grid Parser');

  const names = result.rows.map((r) => r.employeeName);
  assert.ok(names.includes('Fatima'), `expected Fatima (page 1) in parsed rows: ${JSON.stringify(names)}`);
  assert.ok(names.includes('Layla'), `expected Layla (page 2) in parsed rows, not silently dropped: ${JSON.stringify(names)}`);

  const layla = result.rows.filter((r) => r.employeeName === 'Layla');
  assert.equal(layla.length, 3, `expected all 3 of Layla's identical shifts, got: ${JSON.stringify(layla)}`);
  assert.ok(layla.every((r) => r.startTime === '09:00' && r.endTime === '17:00'));
});

// Regression (same QA pass): a header row that labels its own name column
// ("Name | Monday | Tuesday | Wednesday") is an entirely ordinary
// real-world export shape, distinct from anything the tests above cover.
// deriveColumnAnchors used to take EVERY item on the detected header row as
// a column anchor, not just the ones that matched DAY_HEADER_RE — so the
// "Name" cell's own x-position became a phantom extra day-column, shifting
// every other column and silently zeroing out the whole page's rows (while
// still reporting a successful 'Deterministic Grid Parser' parse, with no
// issues logged to explain why).
test('a header row with an explicit "Name" label on the name column parses correctly, not silently zeroed', async () => {
  const buffer = await buildPdf([
    { text: 'Name', x: 20, y: 380 },
    { text: 'Monday', x: 140, y: 380 },
    { text: 'Tuesday', x: 240, y: 380 },
    { text: 'Wednesday', x: 340, y: 380 },
    { text: 'Fatima', x: 20, y: 360 },
    { text: '9-17', x: 140, y: 360 },
    { text: '9-17', x: 240, y: 360 },
    { text: 'OFF', x: 340, y: 360 },
  ]);

  assert.equal(await hasPdfTextLayer(buffer), true);
  const grid = await extractPdfGrid(buffer);
  const result = parseExcelGrid(grid, WEEK_START);
  assert.equal(result.templateLabel, 'Deterministic Grid Parser');

  const fatima = result.rows.filter((r) => r.employeeName === 'Fatima');
  assert.equal(fatima.length, 2, `expected Fatima's Monday+Tuesday shifts, not silently zeroed: ${JSON.stringify(result.rows)}`);
  assert.ok(fatima.every((r) => r.startTime === '09:00' && r.endTime === '17:00'));
});

// Regression (same QA pass, follow-up check): the "identical shift 3 days
// running" test above proves the structural fix survives THAT input, but on
// its own it can't rule out the fix secretly still depending on the values
// being identical (e.g. if some remaining code path matched on repeated
// text rather than purely on row position). It shouldn't — the whole point
// of "never re-derive once established" is that it never looks at a later
// page's cell VALUES for header detection at all — but an irregular pattern
// is what a real venue's schedule usually looks like, so it's worth its own
// explicit case rather than trusting that the identical-shift test
// generalizes.
test('multi-page PDF: an employee with an IRREGULAR (non-identical) shift pattern on a continuation page is not mistaken for that page\'s header', async () => {
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
      // Marcus is the ONLY row on this page, and every one of his 3 shifts
      // is a DIFFERENT time range — still 3 adjacent day-shaped cells (the
      // exact shape findAnchorRow used to key off), just not identical
      // values, to confirm the fix isn't secretly relying on repetition.
      { text: 'Marcus', x: 20, y: 360 },
      { text: '9-17', x: 140, y: 360 },
      { text: '14-22', x: 240, y: 360 },
      { text: '10-18', x: 340, y: 360 },
    ],
  ]);

  assert.equal(await hasPdfTextLayer(buffer), true);
  const grid = await extractPdfGrid(buffer);
  const result = parseExcelGrid(grid, WEEK_START);
  assert.equal(result.templateLabel, 'Deterministic Grid Parser');

  const names = result.rows.map((r) => r.employeeName);
  assert.ok(names.includes('Fatima'), `expected Fatima (page 1) in parsed rows: ${JSON.stringify(names)}`);
  assert.ok(names.includes('Marcus'), `expected Marcus (page 2) in parsed rows, not silently dropped: ${JSON.stringify(names)}`);

  const marcus = result.rows.filter((r) => r.employeeName === 'Marcus');
  assert.equal(marcus.length, 3, `expected all 3 of Marcus's distinct shifts, got: ${JSON.stringify(marcus)}`);
  assert.ok(marcus.some((r) => r.startTime === '09:00' && r.endTime === '17:00'), 'Monday 9-17');
  assert.ok(marcus.some((r) => r.startTime === '14:00' && r.endTime === '22:00'), 'Tuesday 14-22');
  assert.ok(marcus.some((r) => r.startTime === '10:00' && r.endTime === '18:00'), 'Wednesday 10-18');
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

// Regression (issue #19): a genuinely malformed buffer (0 bytes, or bytes
// that aren't a PDF at all) used to propagate as an untyped pdfjs-dist
// rejection all the way to schedules.ts's generic catch-all, producing a
// 500 ("Unexpected error...") for what is really a 422-shaped "this file
// is broken" case — inconsistent with every other unparseable-input case
// in that route, which all map to a typed error and a 422. Both
// hasPdfTextLayer and extractPdfGrid now throw the same typed
// MalformedPdfError (both go through extractPositionedItems), which
// schedules.ts's outer catch maps to a 422.
test('a 0-byte file throws a typed MalformedPdfError, not an untyped rejection', async () => {
  const empty = Buffer.alloc(0);
  await assert.rejects(() => hasPdfTextLayer(empty), MalformedPdfError);
  await assert.rejects(() => extractPdfGrid(empty), MalformedPdfError);
});

test('a buffer that is not a PDF at all throws a typed MalformedPdfError, not an untyped rejection', async () => {
  const garbage = Buffer.from('this is not a pdf at all, just garbage bytes 0000000');
  await assert.rejects(() => hasPdfTextLayer(garbage), MalformedPdfError);
  await assert.rejects(() => extractPdfGrid(garbage), MalformedPdfError);
});

// A well-formed PDF with no text layer at all (a genuine scanned/image-only
// page) is NOT malformed — it's a valid "not this shape" case that should
// keep falling through to the Docling/vision fallback, not get swept up
// into the new MalformedPdfError path.
test('a well-formed PDF with no text layer does NOT throw MalformedPdfError', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([700, 400]);
  page.drawRectangle({ x: 50, y: 50, width: 100, height: 100 });
  const buffer = Buffer.from(await doc.save());
  await assert.doesNotReject(() => hasPdfTextLayer(buffer));
  assert.equal(await hasPdfTextLayer(buffer), false);
  assert.equal(await pdfPageCount(buffer), 1);
});

/** Text centred on x (as spreadsheet exports print cells), with an optional rotation. */
async function buildCentredPdf(items: { text: string; x: number; y: number; rotate?: number }[], size = 8): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([800, 400]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const item of items) {
    const w = font.widthOfTextAtSize(item.text, size);
    if (item.rotate) page.drawText(item.text, { x: item.x + size / 2, y: item.y - w / 2, size, font, rotate: degrees(item.rotate) });
    else page.drawText(item.text, { x: item.x - w / 2, y: item.y, size, font });
  }
  return Buffer.from(await doc.save());
}

test('family-A shape: centred cells, a date row over a weekday row, AM | PM halves and four decimal sub-cells per day', async () => {
  // Day d spans x = 200 + 120d … +120; its four sub-cells are centred at +15, +45, +75, +105.
  const day = (d: number, sub: number) => 200 + 120 * d + 15 + 30 * sub;
  const items: { text: string; x: number; y: number }[] = [];
  ['17-Aug', '18-Aug'].forEach((t, d) => items.push({ text: t, x: 200 + 120 * d + 60, y: 380 }));
  ['MONDAY', 'TUESDAY'].forEach((t, d) => items.push({ text: t, x: 200 + 120 * d + 60, y: 368 }));
  for (const d of [0, 1]) items.push({ text: 'AM', x: 200 + 120 * d + 30, y: 356 }, { text: 'PM', x: 200 + 120 * d + 90, y: 356 });
  items.push({ text: 'COVERS', x: 100, y: 344 }, { text: 'Party - 20pax', x: day(1, 0), y: 344 });
  // Sub-cells sit closer together than a space: each is still its own cell.
  ['11', '17', '18', '25'].forEach((t, s) => items.push({ text: t, x: day(0, s), y: 332 }));
  ['18.5', '26'].forEach((t, s) => items.push({ text: t, x: day(1, s + 2), y: 332 }));
  items.push({ text: 'Test Person One', x: 100, y: 332 });
  items.push({ text: 'Test Person Blank', x: 100, y: 320 });
  items.push({ text: 'SUPERVISORS', x: 320, y: 308 }); // a banner centred across the days
  items.push({ text: 'Test Person Two', x: 100, y: 296 }, { text: '9.5', x: day(0, 0), y: 296 }, { text: '15.5', x: day(0, 1), y: 296 });
  items.push({ text: 'Holiday', x: 470, y: 320 }, { text: 'Sick', x: 470, y: 308 }); // a colour key beside the rows
  const buffer = await buildCentredPdf(items);

  const table = await extractPdfTable(buffer);
  assert.equal(table.pageCount, 1);
  const result = parseExcelGrid(table.grid, WEEK_START, { today: '2026-10-07', clientWeekStart: null, rowRefs: table.rowRefs });
  assert.equal(result.week?.weekStart, '2026-08-17');
  assert.deepEqual(result.people?.map((p) => `${p.name}|${p.section ?? ''}|${p.sourcePage}`), ['Test Person One||1', 'Test Person Blank||1', 'Test Person Two|SUPERVISORS|1']);
  assert.deepEqual(
    result.rows.map((r) => `${r.employeeName}|${r.date}|${r.startTime}-${r.endTime}|${r.managerNotes}`),
    [
      'Test Person One|2026-08-17|11:00-17:00|[AM]',
      'Test Person One|2026-08-17|18:00-01:00|[PM]',
      'Test Person One|2026-08-18|18:30-02:00|[PM]',
      'Test Person Two|2026-08-17|09:30-15:30|[AM]',
    ],
  );
  assert.deepEqual(result.leaveRecords, [], 'a colour key is nobody\'s leave');
  assert.deepEqual(result.anomalies, []);
  assert.match(table.pageTexts[0]!, /Test Person Blank/);
});

test('rotated weekday headers are read in place', async () => {
  const items: { text: string; x: number; y: number; rotate?: number }[] = [
    { text: '17-Aug', x: 200, y: 380 },
    { text: '18-Aug', x: 300, y: 380 },
    { text: 'MONDAY', x: 200, y: 340, rotate: 90 },
    { text: 'TUESDAY', x: 300, y: 340, rotate: 90 },
    { text: 'Test Person One', x: 80, y: 300 },
    { text: '9-17', x: 200, y: 300 },
    { text: '10-18', x: 300, y: 300 },
  ];
  const result = parseExcelGrid(await extractPdfGrid(await buildCentredPdf(items)), WEEK_START);
  assert.deepEqual(result.rows.map((r) => `${r.date} ${r.startTime}-${r.endTime}`), ['2026-08-17 09:00-17:00', '2026-08-18 10:00-18:00']);
});

test('a header repeated at the top of page 2 is not read again as data; rows keep their page', async () => {
  const header = [
    { text: 'Mon 17/08', x: 200, y: 380 },
    { text: 'Tue 18/08', x: 300, y: 380 },
  ];
  const buffer = await buildMultiPagePdf([
    [...header, { text: 'Fatima', x: 20, y: 360 }, { text: '9-17', x: 190, y: 360 }],
    [...header, { text: 'Yusuf', x: 20, y: 360 }, { text: '10-18', x: 290, y: 360 }],
  ]);
  const table = await extractPdfTable(buffer);
  const result = parseExcelGrid(table.grid, WEEK_START, { rowRefs: table.rowRefs });
  assert.deepEqual(result.people?.map((p) => `${p.name}@${p.sourcePage}`), ['Fatima@1', 'Yusuf@2']);
  assert.deepEqual(result.rows.map((r) => `${r.employeeName} ${r.date}`), ['Fatima 2026-08-17', 'Yusuf 2026-08-18']);
});

test('a name whose ff / fi / fl ligatures come out of the text layer as separate items edge to edge is read whole', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([700, 400]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const draw = (text: string, x: number, y: number) => {
    // One text item per piece, each starting exactly where the last one ended.
    for (const piece of text.split(/(ffi|ffl|ff|fi|fl)/).filter(Boolean)) {
      page.drawText(piece, { x, y, size: 9, font });
      x += font.widthOfTextAtSize(piece, 9);
    }
  };
  draw('Mon 17/08', 200, 380);
  draw('Tue 18/08', 300, 380);
  draw('Saffiya Okonkwo', 20, 360);
  draw('9-17', 200, 360);
  draw('Effie Laflamme', 20, 345);
  draw('10-18', 300, 345);
  draw('Total staff on rota: 2', 20, 330);
  const result = parseExcelGrid(await extractPdfGrid(Buffer.from(await doc.save())), WEEK_START);
  assert.deepEqual(result.people?.map((p) => p.name), ['Saffiya Okonkwo', 'Effie Laflamme']);
});
