import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { readWorkbook, WorkbookReadError } from './workbookReader.js';
import { buildMergeExpandedGrid, parseWorkbookBuffer, TemplateDetectionError } from './parseWorkbook.js';
import { parseDateCell, parseTimeCell } from './normalize.js';

// The reader swaps SheetJS for exceljs (Issue #23). exceljs is NOT a drop-in:
// these pin every behavior that differs from it and that a parser downstream
// depends on. Where a test says "SheetJS ...", that is a measured difference
// against the reader this replaced, not a guess.

/** Builds a workbook with full exceljs control (number formats, formulas, ...) and returns its bytes. */
async function build(fn: (workbook: ExcelJS.Workbook) => void): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  fn(workbook);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
const utc = (y: number, m: number, d: number, h = 0, mi = 0) => new Date(Date.UTC(y, m - 1, d, h, mi));
const csv = (text: string) => Buffer.from(text, 'utf8');
const NL = '\n';

// --- dates and times -------------------------------------------------------

test('typed date and time cells come back as UTC-exact Dates, independent of the host timezone', async () => {
  // SheetJS built these from LOCAL time: on a UTC+4 host a typed 17-Aug read
  // as 2026-08-16T19:59:48Z (a day early once read as UTC) and a 09:00 time
  // cell as 05:18 — so every typed date/time was wrong on any non-UTC server.
  const buffer = await build((wb) => {
    const ws = wb.addWorksheet('S');
    ws.getCell('A1').value = utc(2026, 8, 17);
    ws.getCell('A1').numFmt = 'ddd dd-mmm';
    ws.getCell('B1').value = utc(2026, 8, 17, 9, 30);
    ws.getCell('C1').value = 0.375;
    ws.getCell('C1').numFmt = 'h:mm';
  });
  const { grid } = await readWorkbook(buffer);
  assert.equal((grid[0][0] as Date).toISOString(), '2026-08-17T00:00:00.000Z');
  assert.equal((grid[0][1] as Date).toISOString(), '2026-08-17T09:30:00.000Z');
  assert.equal((grid[0][2] as Date).toISOString(), '1899-12-30T09:00:00.000Z');
  // ...and the parsers, which read Dates as UTC, therefore agree on any host:
  assert.equal(parseDateCell(grid[0][0]), '2026-08-17');
  assert.equal(parseTimeCell(grid[0][1]), '09:30');
  assert.equal(parseTimeCell(grid[0][2]), '09:00');
});

test('a long-format sheet with typed Date and time cells parses to the right dates and times through the whole pipeline', async () => {
  const buffer = await build((wb) => {
    const ws = wb.addWorksheet('Roster');
    ws.addRow(['Employee Name', 'Role', 'Date', 'Start Time', 'End Time']);
    ws.addRow(['Fatima', 'Waiter', utc(2026, 8, 17), 0.375, 0.7083333333]);
    ws.getCell('C2').numFmt = 'dd/mm/yyyy';
    ws.getCell('D2').numFmt = 'h:mm';
    ws.getCell('E2').numFmt = 'h:mm';
  });
  const result = await parseWorkbookBuffer(buffer, 'roster.xlsx');
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].employeeName, 'Fatima');
  assert.equal(result.rows[0].date, '2026-08-17');
  assert.equal(result.rows[0].startTime, '09:00');
  assert.equal(result.rows[0].endTime, '17:00');
});

test('ISO-8601 date cells (t="d", written by SheetJS cellDates / openpyxl iso_dates) are refused loudly, not read as 1905', async () => {
  // exceljs parseFloat()s the ISO text — the YEAR, 2026 — and applies the
  // cell's date format: the cell silently becomes 1905-07-18 and the real
  // date is unrecoverable. A wrong date is worse than a refusal.
  // Fixture generated once with SheetJS `aoa_to_sheet(..., { cellDates: true })`:
  // its C2 is <c t="d"><v>2026-08-17T04:00:00.000Z</v></c>.
  const buffer = readFileSync('server/test-fixtures/iso-8601-date-cell.xlsx');
  await assert.rejects(readWorkbook(buffer), (err: unknown) => {
    assert.ok(err instanceof WorkbookReadError);
    assert.match(err.message, /Cell C2/);
    assert.match(err.message, /ISO-8601/);
    assert.match(err.message, /re-save it as \.xlsx/);
    return true;
  });
});

test('the ISO-date guard does not fire on legitimate values: ordinary dates, and [h]:mm elapsed totals over 24h', async () => {
  const buffer = await build((wb) => {
    const ws = wb.addWorksheet('S');
    ws.getCell('A1').value = utc(2026, 8, 17);
    ws.getCell('B1').value = 2.0208333333; // 48:30 of elapsed hours -> 1900-01-01T.. once read as a date
    ws.getCell('B1').numFmt = '[h]:mm';
    ws.getCell('C1').value = utc(2030, 1, 1);
  });
  const { grid } = await readWorkbook(buffer);
  assert.equal((grid[0][0] as Date).getUTCFullYear(), 2026);
  assert.ok(grid[0][1] instanceof Date, 'the elapsed-time total is still read, not rejected');
  assert.equal((grid[0][2] as Date).getUTCFullYear(), 2030);
});

// --- cell value types ------------------------------------------------------

test('formula cells yield their cached result (number, string, boolean, date); an error or never-calculated result is null', async () => {
  const buffer = await build((wb) => {
    const ws = wb.addWorksheet('S');
    const put = (addr: string, value: unknown, numFmt?: string) => {
      ws.getCell(addr).value = value as ExcelJS.CellValue;
      if (numFmt) ws.getCell(addr).numFmt = numFmt;
    };
    put('A1', { formula: 'B9+C9', result: 12 });
    put('B1', { formula: '"x"&1', result: 'x1' });
    put('C1', { formula: '1>0', result: true });
    put('D1', { formula: 'DATE(2026,8,17)', result: utc(2026, 8, 17) }, 'yyyy-mm-dd');
    put('E1', { formula: '1/0', result: { error: '#DIV/0!' } });
    put('F1', { formula: 'A1+B1' }); // never calculated: no cached result
    put('G1', 'end');
  });
  const { grid } = await readWorkbook(buffer);
  assert.equal(grid[0][0], 12);
  assert.equal(grid[0][1], 'x1');
  assert.equal(grid[0][2], true);
  assert.equal((grid[0][3] as Date).toISOString(), '2026-08-17T00:00:00.000Z');
  assert.equal(grid[0][4], null);
  assert.equal(grid[0][5], null);
  assert.equal(grid[0][6], 'end');
});

test('rich text reads as its concatenated text, a hyperlink as its display text, and an error literal as null', async () => {
  const buffer = await build((wb) => {
    const ws = wb.addWorksheet('S');
    ws.getCell('A1').value = { richText: [{ text: 'Hel', font: { bold: true } }, { text: 'lo' }] };
    ws.getCell('A2').value = { text: 'click me', hyperlink: 'https://example.com' };
    ws.getCell('A3').value = { error: '#N/A' } as ExcelJS.CellValue;
    ws.getCell('B1').value = 'k';
    ws.getCell('B2').value = 'k';
    ws.getCell('B3').value = 'k';
  });
  const { grid } = await readWorkbook(buffer);
  assert.deepEqual(grid, [['Hello', 'k'], ['click me', 'k'], [null, 'k']]);
});

// --- merged cells (the round-2 audit rule, re-imposed on exceljs) -----------

test('merged cells: a horizontal merge expands its value across the span; vertical and 2-D merges leave every covered cell blank', async () => {
  // exceljs makes EVERY cell inside a merge report the master's value. The
  // parsers depend on the opposite for multi-row merges (a vertically merged
  // staff-name cell must NOT be copied down onto rows with their own shifts).
  const buffer = await build((wb) => {
    const ws = wb.addWorksheet('S');
    ws.getCell('A1').value = 'Header';
    ws.getCell('A2').value = 'Ali';
    ws.getCell('B2').value = '9-17';
    ws.getCell('B3').value = '10-18';
    ws.getCell('B4').value = '11-19';
    ws.getCell('C2').value = 'x';
    ws.getCell('E2').value = 'Block';
    ws.mergeCells('A1:C1'); // horizontal
    ws.mergeCells('A2:A4'); // vertical
    ws.mergeCells('E2:F3'); // 2-D
  });
  const { grid } = await readWorkbook(buffer);
  assert.deepEqual(grid, [
    ['Header', 'Header', 'Header', null, null, null], // expanded, as SheetJS did
    ['Ali', '9-17', 'x', null, 'Block', null], // masters keep their value; F2 (2-D slave) blank
    [null, '10-18', null, null, null, null], // A3 (vertical slave) and E3/F3 (2-D slaves) blank
    [null, '11-19', null, null, null, null],
  ]);
});

// --- shape of the grid -----------------------------------------------------

test('the grid starts at the sheet\'s first used column/row, drops fully blank rows, and pads every row to the used width', async () => {
  const offset = await build((wb) => {
    const ws = wb.addWorksheet('S');
    ws.getCell('C3').value = 'Name';
    ws.getCell('D3').value = 'Mon';
    ws.getCell('C4').value = 'Fatima';
    ws.getCell('D4').value = '9-17';
  });
  assert.deepEqual((await readWorkbook(offset)).grid, [['Name', 'Mon'], ['Fatima', '9-17']]);

  const gaps = await build((wb) => {
    const ws = wb.addWorksheet('S');
    ws.getCell('A1').value = 'a';
    ws.getCell('B1').value = 'b';
    ws.getCell('A2').value = 'c';
    ws.getCell('A4').value = 'd'; // rows 3 and 5+ are blank
    ws.getCell('B4').value = 'e';
  });
  assert.deepEqual((await readWorkbook(gaps)).grid, [['a', 'b'], ['c', null], ['d', 'e']]);
});

test('sheet names come back in tab order and the FIRST sheet — even a hidden one — is the one read', async () => {
  const buffer = await build((wb) => {
    wb.addWorksheet('Hidden', { state: 'hidden' }).getCell('A1').value = 'h';
    wb.addWorksheet('Real').getCell('A1').value = 'r';
    wb.addWorksheet('Notes').getCell('A1').value = 'n';
  });
  const snapshot = await readWorkbook(buffer);
  assert.deepEqual(snapshot.sheetNames, ['Hidden', 'Real', 'Notes']);
  assert.deepEqual(snapshot.grid, [['h']]);
});

// --- CSV ---------------------------------------------------------------------

test('CSV: comma, semicolon, tab, pipe and Excel\'s "sep=;" line are all detected', async () => {
  const expected = [['Name', 'Mon', 'Tue'], ['Fatima', '9-17', '10-18']];
  for (const sep of [',', ';', '\t', '|']) {
    const text = ['Name', 'Mon', 'Tue'].join(sep) + NL + ['Fatima', '9-17', '10-18'].join(sep) + NL;
    assert.deepEqual((await readWorkbook(csv(text))).grid, expected, `separator ${JSON.stringify(sep)}`);
  }
  const withSepLine = 'sep=;' + NL + 'Name;Mon;Tue' + NL + 'Fatima;9-17;10-18' + NL;
  assert.deepEqual((await readWorkbook(csv(withSepLine))).grid, expected);
});

test('CSV: a shift like "9-17" stays TEXT, and ISO dates stay text (SheetJS turned "9-17" into a Date on every such cell)', async () => {
  const { grid } = await readWorkbook(csv('Name,2026-08-17,2026-08-18' + NL + 'Fatima,9-17,6-10' + NL));
  assert.deepEqual(grid, [['Name', '2026-08-17', '2026-08-18'], ['Fatima', '9-17', '6-10']]);
  assert.equal(typeof grid[1][1], 'string');
});

test('CSV: numbers and TRUE/FALSE are typed, a whitespace-only cell stays a string (not 0), quotes and embedded newlines survive', async () => {
  const typed = await readWorkbook(csv('a,b,c,d,e' + NL + '007,1.5,TRUE,FALSE, ' + NL));
  assert.deepEqual(typed.grid[1], [7, 1.5, true, false, ' ']);

  const quoted = await readWorkbook(csv('"Smith, Ann","line1' + NL + 'line2","say ""hi"""' + NL));
  assert.deepEqual(quoted.grid, [['Smith, Ann', 'line1' + NL + 'line2', 'say "hi"']]);
});

test('CSV: a UTF-8 BOM is stripped, CRLF is handled, and Arabic text decodes correctly', async () => {
  const bom = String.fromCharCode(0xfeff);
  const { grid, sheetNames } = await readWorkbook(csv(bom + 'الاسم,الاثنين\r\nفاطمة,9-17\r\n'));
  assert.deepEqual(grid, [['الاسم', 'الاثنين'], ['فاطمة', '9-17']]);
  assert.deepEqual(sheetNames, ['Sheet1']);
});

// --- formats it cannot read -----------------------------------------------------

test('a legacy .xls (OLE2) file is refused with an actionable message', async () => {
  const ole2 = Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(512)]);
  await assert.rejects(readWorkbook(ole2), { name: 'WorkbookReadError', message: /legacy Excel .* password-protected/ });
});

test('an HTML/XML export saved with a spreadsheet extension is refused instead of being parsed as CSV garbage', async () => {
  const html = csv('<html><body><table><tr><td>Name</td></tr></table></body></html>');
  await assert.rejects(readWorkbook(html), { name: 'WorkbookReadError', message: /HTML\/XML export/ });
});

test('a corrupt .xlsx (zip signature, garbage body) is a clean WorkbookReadError; through parseWorkbook it becomes a TemplateDetectionError with the filename', async () => {
  const corrupt = Buffer.concat([Buffer.from('PK'), Buffer.from('this is not really a zip archive')]);
  await assert.rejects(readWorkbook(corrupt), WorkbookReadError);
  await assert.rejects(parseWorkbookBuffer(corrupt, 'broken.xlsx'), (err: unknown) => {
    assert.ok(err instanceof TemplateDetectionError);
    assert.match(err.message, /Could not read "broken\.xlsx" as an Excel or CSV file/);
    return true;
  });
});

test('an empty upload reads as an empty grid (a "sheet" with no rows), not a crash', async () => {
  const snapshot = await readWorkbook(Buffer.alloc(0));
  assert.deepEqual(snapshot.grid, []);
});

// --- one read per upload --------------------------------------------------------

test('the same upload buffer is loaded once (memoised); a different buffer is loaded fresh; callers get independent grids', async () => {
  const buffer = await build((wb) => { wb.addWorksheet('S').addRows([['a', 'b'], ['c', 'd']]); });
  assert.strictEqual(readWorkbook(buffer), readWorkbook(buffer), 'the route reads one upload up to three times');
  assert.notStrictEqual(readWorkbook(buffer), readWorkbook(Buffer.from(buffer)));

  const first = await buildMergeExpandedGrid(buffer, 'a.xlsx');
  first[0][0] = 'MUTATED';
  const second = await buildMergeExpandedGrid(buffer, 'a.xlsx');
  assert.equal(second[0][0], 'a', 'a caller mutating its grid cannot corrupt the next caller\'s');
});
