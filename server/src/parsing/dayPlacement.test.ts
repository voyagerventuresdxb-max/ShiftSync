/**
 * Shifts on the right day, whatever the layout: day headers and cells aligned differently in a
 * text PDF (a left-aligned date over right-aligned times), cells running on past a narrow
 * column, overnight shifts (18:30–01:00, decimal 18.5–26) dated on the day they start, a day
 * header merged over two columns (XLSX) or saved without its merge (CSV). A day the table
 * reader could only infer is never saved silently: flagged on its own, and checked against the
 * AI reading when there is one. Every name is made up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSXNS from 'xlsx';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { extractPdfTable } from './pdfTableExtractor.js';
import { parseExcelGrid } from './deterministicGridParser.js';
import { readUploadedRoster, type UploadReadContext } from './readUpload.js';
import { memoryReadingCache } from './readingCache.js';
import { MockVisionProvider } from './visionProvider.js';
import type { ReadingAnswer } from './vlmPrompt.js';

const XLSX: typeof XLSXNS = ((XLSXNS as unknown as { default?: typeof XLSXNS }).default ?? XLSXNS) as typeof XLSXNS;
const TODAY = '2026-10-07';
const WEEK = ['2026-04-13', '2026-04-14', '2026-04-15', '2026-04-16', '2026-04-17', '2026-04-18', '2026-04-19'];
const HEADERS = ['Mon 13/04', 'Tue 14/04', 'Wed 15/04', 'Thu 16/04', 'Fri 17/04', 'Sat 18/04', 'Sun 19/04'];

type Align = 'left' | 'centre' | 'right';
/** Made-up people and their week, one cell per day. */
const PEOPLE: [string, string[]][] = [
  ['Test Alpha', ['18.30-01.00', 'OFF', '9.30-15.00', '', '18.30-01.00', 'OFF', 'OFF']],
  ['Test Beta', ['OFF', '18.00-02.00', 'OFF', '18.30-01.00', '', '21.00-03.00', 'OFF']],
  ['Test Gamma', ['', '', '10.00-15.00', 'OFF', 'AL', '18.30-01.00', '20.00-00.00']],
  ['Test Delta', ['9.30-15.00', 'OFF', '', '18.00-02.00', 'OFF', '', '18.30-01.00']],
  ['Test Epsilon', ['OFF', '20.00-00.00', '18.30-01.00', 'OFF', '9.30-15.00', 'OFF', '']],
];
/** What a careful reader reads: person|date|start-end. */
function expected(): string[] {
  const out: string[] = [];
  for (const [name, cells] of PEOPLE) {
    cells.forEach((c, d) => {
      const m = c.match(/^(\d{1,2})\.(\d{2})-(\d{1,2})\.(\d{2})$/);
      if (m) out.push(`${name}|${WEEK[d]}|${m[1]!.padStart(2, '0')}:${m[2]}-${m[3]!.padStart(2, '0')}:${m[4]}`);
    });
  }
  return out.sort();
}

/** A text-layer PDF of the week: day columns `width` wide from x = 160, headers and cells aligned as asked. */
async function weekPdf(o: { header: Align; cells: Align; width: number }): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([160 + 7 * o.width + 40, 260]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const size = 8;
  const at = (text: string, d: number, align: Align) => {
    const w = font.widthOfTextAtSize(text, size);
    const left = 160 + d * o.width;
    return align === 'left' ? left + 3 : align === 'right' ? left + o.width - 3 - w : left + (o.width - w) / 2;
  };
  HEADERS.forEach((h, d) => page.drawText(h, { x: at(h, d, o.header), y: 230, size, font }));
  PEOPLE.forEach(([name, cells], r) => {
    const y = 210 - r * 14;
    page.drawText(name, { x: 20, y, size, font });
    cells.forEach((c, d) => c && page.drawText(c, { x: at(c, d, o.cells), y, size, font }));
  });
  page.drawText('Test Zeta', { x: 20, y: 210 - PEOPLE.length * 14, size, font });
  return Buffer.from(await doc.save());
}

const readPdf = async (pdf: Buffer) => {
  const table = await extractPdfTable(pdf);
  return parseExcelGrid(table.grid, TODAY, { today: TODAY, clientWeekStart: null, rowRefs: table.rowRefs, inferredCells: table.inferredCells });
};
const keys = (rows: { employeeName: string; date: string; startTime: string; endTime: string }[]) => rows.map((r) => `${r.employeeName}|${r.date}|${r.startTime}-${r.endTime}`).sort();

test('text PDF: every shift lands on its own day however the day headers and the cells are aligned', async () => {
  for (const header of ['left', 'centre', 'right'] as Align[]) {
    for (const cells of ['left', 'centre', 'right'] as Align[]) {
      const result = await readPdf(await weekPdf({ header, cells, width: 110 }));
      assert.deepEqual(keys(result.rows), expected(), `header ${header}, cells ${cells}`);
      assert.ok(result.rows.every((r) => !r.flags?.length), `header ${header}, cells ${cells}: read where it sits, nothing to check`);
      assert.deepEqual(result.people?.map((p) => p.name), ['Test Alpha', 'Test Beta', 'Test Gamma', 'Test Delta', 'Test Epsilon', 'Test Zeta']);
    }
  }
});

test('text PDF: an overnight shift (18.30-01.00) is dated on the day it starts and ends the next morning', async () => {
  const result = await readPdf(await weekPdf({ header: 'left', cells: 'right', width: 110 }));
  const night = result.rows.find((r) => r.employeeName === 'Test Alpha' && r.date === '2026-04-13')!;
  assert.equal(`${night.startTime}-${night.endTime}`, '18:30-01:00');
  assert.equal(night.overnight, true);
  assert.ok(!result.rows.some((r) => r.employeeName === 'Test Alpha' && r.date === '2026-04-14' && r.startTime === '18:30'));
});

test('text PDF: a cell running on past a narrow column stays on its day when its edge lines up with the day\'s; one that lines up with no day is flagged, never saved silently', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([520, 260]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const draw = (text: string, x: number, y: number) => page.drawText(text, { x, y, size: 8, font });
  ['Mon 13/04', 'Tue 14/04', 'Wed 15/04', 'Thu 16/04'].forEach((h, d) => draw(h, 160 + d * 42 + 3, 230));
  const rows: [string, string[]][] = [
    ['Test Alpha', ['10.30-15.00/18.30-01.00', 'OFF', 'AL', 'OFF']],
    ['Test Beta', ['OFF', 'UL', '9.30-15.00', 'OFF']],
    ['Test Gamma', ['UL', 'OFF', 'OFF', '18.30-01.00']],
    ['Test Delta', ['AL', 'OFF', 'UL', 'OFF']],
  ];
  rows.forEach(([name, cells], r) => {
    draw(name, 20, 210 - r * 14);
    cells.forEach((c, d) => draw(c, 160 + d * 42 + 3, 210 - r * 14));
  });
  // A long cell starting between two columns' edges: which day it belongs to can't be read.
  draw('Test Epsilon', 20, 210 - 4 * 14);
  draw('10.00-15.00/19.00-23.00', 160 + 42 + 22, 210 - 4 * 14);
  const result = await readPdf(Buffer.from(await doc.save()));
  const alpha = result.rows.filter((r) => r.employeeName === 'Test Alpha');
  assert.deepEqual(keys(alpha), ['Test Alpha|2026-04-13|10:30-15:00', 'Test Alpha|2026-04-13|18:30-01:00']);
  assert.ok(alpha.every((r) => !r.flags?.length), 'its left edge is Monday\'s own: placed for certain');
  const epsilon = result.rows.filter((r) => r.employeeName === 'Test Epsilon');
  assert.ok(epsilon.length > 0 && epsilon.every((r) => r.flags?.includes('low_confidence') && r.inferredDay), 'a guessed day is flagged to check');
});

test('two days\' times run together in one cell ("18:30-01:00 18:00-02:00") are never saved on one day', () => {
  const result = parseExcelGrid(
    [
      ['', 'Mon 13/04', 'Tue 14/04'],
      ['Test Alpha', '18:30-01:00 18:00-02:00', ''],
      ['Test Beta', '16 18 18.5 26', ''],
    ],
    TODAY,
    { today: TODAY, clientWeekStart: null },
  );
  assert.deepEqual(keys(result.rows), ['Test Beta|2026-04-13|16:00-18:00', 'Test Beta|2026-04-13|18:30-02:00'], 'back-to-back segments are one day');
  const cell = result.anomalies.find((a) => a.employeeName === 'Test Alpha');
  assert.match(cell!.reason, /overlap or run on past one day/);
});

test('a cell whose first digits were cut off ("30-15.00/18.30-01") is never read as a shift: no one starts past midnight', () => {
  const result = parseExcelGrid([['', 'Mon 13/04', 'Tue 14/04'], ['Test Alpha', '30-15.00/18.30-01', '18 26']], TODAY, { today: TODAY, clientWeekStart: null });
  assert.deepEqual(keys(result.rows), ['Test Alpha|2026-04-14|18:00-02:00'], 'hours past midnight still end a shift');
  assert.ok(result.anomalies.some((a) => a.rawText === '30-15.00/18.30-01'));
});

function workbook(rows: unknown[][], merges: XLSXNS.Range[] = []): XLSXNS.WorkBook {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!merges'] = merges;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Rota');
  return wb;
}

function ctx(over: Partial<UploadReadContext> = {}): UploadReadContext {
  return {
    locationId: null,
    userId: null,
    today: TODAY,
    clientWeekStart: null,
    aiConsent: true,
    provider: null,
    aiBlockedReason: async () => null,
    markAiUsed: async () => {},
    cache: memoryReadingCache(),
    deadline: Date.now() + 60_000,
    ...over,
  };
}

test('XLSX and CSV: overnight 18:30-01:00 and decimal 18.5-26 are dated on the start day; a day header merged over two columns (or saved without its merge) owns both', async () => {
  // Two columns per day (AM | PM); the header is merged across both, or (CSV) printed over the first only.
  const header = ['', 'Mon 13/04', '', 'Tue 14/04', '', 'Wed 15/04', ''];
  const rows = [
    header,
    ['', 'AM', 'PM', 'AM', 'PM', 'AM', 'PM'],
    ['Test Alpha', '', '18:30-01:00', '', '', '11-16', '18.5-26'],
    ['Test Beta', '', '', '', '18.5 26', 'OFF', ''],
  ];
  const merges = [1, 3, 5].map((c) => ({ s: { r: 0, c }, e: { r: 0, c: c + 1 } }));
  for (const [name, file] of [
    ['rota.xlsx', XLSX.write(workbook(rows, merges), { type: 'buffer', bookType: 'xlsx' }) as Buffer],
    ['rota.csv', Buffer.from(XLSX.utils.sheet_to_csv(workbook(rows).Sheets.Rota!))],
  ] as const) {
    const outcome = await readUploadedRoster({ buffer: file, mimetype: name.endsWith('csv') ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', originalname: name, size: file.length }, ctx());
    assert.ok(outcome.ok, name);
    if (!outcome.ok) continue;
    assert.deepEqual(
      outcome.result.rows.map((r) => `${r.employeeName}|${r.date}|${r.startTime}-${r.endTime}|${r.overnight}`).sort(),
      ['Test Alpha|2026-04-13|18:30-01:00|true', 'Test Alpha|2026-04-15|11:00-16:00|false', 'Test Alpha|2026-04-15|18:30-02:00|true', 'Test Beta|2026-04-14|18:30-02:00|true'],
      name,
    );
  }
});

/** The AI reader's answer for the week PDF, with one person's row slipped a day to the left from Wednesday on. */
function slippedAnswer(): ReadingAnswer {
  const ppl = PEOPLE.map(([nm, cells], i) => ({ nm, t: null, i: i + 1, c: nm === 'Test Beta' ? [...cells.slice(0, 2), ...cells.slice(3), ''] : cells }));
  return { title: null, days: HEADERS, key: [], pages: [{ p: 1, rows: PEOPLE.length + 1, sec: [{ h: null, n: PEOPLE.length + 1, ppl: [...ppl, { nm: 'Test Zeta', t: null, i: 6, c: [] }] }], unread: [] }] };
}

test('upload path: an offset-header text PDF reads every shift on its day with no AI; an AI reading that slips a row is counted, not flagged, and never moves a shift', async () => {
  const pdf = await weekPdf({ header: 'left', cells: 'right', width: 110 });
  const file = { buffer: pdf, mimetype: 'application/pdf', originalname: 'rota.pdf', size: pdf.length };
  const alone = await readUploadedRoster(file, ctx({ aiConsent: false, provider: new MockVisionProvider(JSON.stringify(slippedAnswer())) }));
  assert.ok(alone.ok);
  if (!alone.ok) return;
  assert.deepEqual(keys(alone.result.rows), expected());
  const checked = await readUploadedRoster(file, ctx({ provider: new MockVisionProvider(JSON.stringify(slippedAnswer())) }));
  assert.ok(checked.ok);
  if (!checked.ok) return;
  assert.deepEqual(keys(checked.result.rows), expected(), "the file's own days stand");
  assert.ok(checked.result.rows.every((r) => !r.flags?.length), 'nothing to check: the AI misread text the file prints exactly');
  assert.deepEqual(checked.result.anomalies, []);
  assert.ok((checked.reading.aiDifferedCells ?? 0) >= 3);
  assert.match(checked.reading.note ?? '', /The AI cross-check differed on \d+ cells; the file's own text was used\./);
  assert.equal(checked.reading.disagreements, 0);
});
