import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSXNS from 'xlsx';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { aiReadRoster, reconcileReadings } from './rosterReading.js';
import { readUploadedRoster, type UploadReadContext } from './readUpload.js';
import { memoryReadingCache } from './readingCache.js';
import { MockVisionProvider, VisionProviderError, type VisionInput, type VisionOutput } from './visionProvider.js';
import { parseExcelGrid } from './deterministicGridParser.js';
import { mapReadingAnswer } from './aiReading.js';
import type { ReadingAnswer, ReadingAnswerPerson } from './vlmPrompt.js';

const XLSX: typeof XLSXNS = ((XLSXNS as unknown as { default?: typeof XLSXNS }).default ?? XLSXNS) as typeof XLSXNS;
const TODAY = '2026-10-07';
const DAYS = ['24-Aug MONDAY', '25-Aug TUESDAY'];

const person = (nm: string, i: number, c: string[], t: string | null = null): ReadingAnswerPerson => ({ nm, t, i, c });
const answer = (pages: { p: number; rows: number; ppl: ReadingAnswerPerson[] }[]): ReadingAnswer => ({
  title: null,
  days: DAYS,
  key: [],
  pages: pages.map((pg) => ({ p: pg.p, rows: pg.rows, sec: [{ h: null, n: pg.ppl.length, ppl: pg.ppl }], unread: [] })),
});
const out = (a: ReadingAnswer | string, extra: Partial<VisionOutput> = {}): VisionOutput => ({ raw: typeof a === 'string' ? a : JSON.stringify(a), model: 'mock', usage: { promptTokens: 10, outputTokens: 20 }, ...extra });
const far = () => Date.now() + 60_000;

test('mapReadingAnswer: dates from the printed day headers, times read by the table reader\'s rules, every person kept', () => {
  const result = mapReadingAnswer(
    answer([{ p: 1, rows: 3, ppl: [person('Test Alpha', 1, ['11 17 18 25', '']), person('Test Blank', 2, ['[Holiday]', '']), person('Test Gamma', 3, ['4CL', '[?]'])] }]),
    { today: TODAY, clientWeekStart: null },
  );
  assert.equal(result.week?.weekStart, '2026-08-24');
  assert.deepEqual(result.rows.map((r) => `${r.employeeName}|${r.date}|${r.startTime}-${r.endTime}|${r.readerSource}`), ['Test Alpha|2026-08-24|11:00-17:00|ai', 'Test Alpha|2026-08-24|18:00-01:00|ai']);
  assert.deepEqual(result.people?.map((p) => p.name), ['Test Alpha', 'Test Blank', 'Test Gamma']);
  assert.deepEqual(result.leaveRecords.map((l) => `${l.employeeName}|${l.leaveCode}|${l.category}`), ['Test Blank|Holiday|public_holiday']);
  assert.ok(result.anomalies.some((a) => a.employeeName === 'Test Gamma' && /closing/i.test(a.reason)));
  assert.ok(result.anomalies.some((a) => a.employeeName === 'Test Gamma' && /could not be read/i.test(a.reason)));
});

test('mapReadingAnswer: a 14-hour-or-longer reading (start and end swapped) is kept but flagged', () => {
  const result = mapReadingAnswer(answer([{ p: 1, rows: 1, ppl: [person('Test Alpha', 1, ['18:00-09:00', ''])] }]), { today: TODAY, clientWeekStart: null });
  assert.deepEqual(result.rows[0]!.flags, ['low_confidence']);
  assert.ok(result.anomalies.some((a) => /14 hours/.test(a.reason) && a.rowNumber === result.rows[0]!.rowNumber));
});

test('aiReadRoster: a page that comes back short is read once more, page-focused and stricter; the two readings are joined', async () => {
  const mock = new MockVisionProvider((input: VisionInput) =>
    out(
      input.strict
        ? answer([{ p: 1, rows: 3, ppl: [person('Test Alpha', 1, ['9-17', '']), person('Test Beta', 2, ['', '9-17']), person('Test Gamma', 3, ['OFF', ''])] }])
        : answer([{ p: 1, rows: 3, ppl: [person('Test Alpha', 1, ['9-17', '']), person('Test Gamma', 3, ['OFF', ''])] }]),
    ),
  );
  const outcome = await aiReadRoster({ kind: 'file', data: Buffer.from('png'), mimeType: 'image/png', name: 'r.png', pageCount: 1 }, { provider: mock, locationId: null, userId: null, deadline: far() });
  assert.equal(mock.calls.length, 2);
  assert.deepEqual(mock.calls[1]!.focus, { page: 1 });
  assert.equal(mock.calls[1]!.strict, true);
  assert.deepEqual(outcome.rereadPages, [1]);
  assert.equal(outcome.complete, true);
  assert.deepEqual(outcome.answer.pages[0]!.sec.flatMap((s) => s.ppl.map((p) => p.nm)), ['Test Alpha', 'Test Beta', 'Test Gamma']);
});

test('aiReadRoster: multi-page files are read one page per call, in parallel; a missing page is re-read once and reported if still missing', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const mock = new MockVisionProvider(async (input: VisionInput) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
    const page = input.focus!.page;
    if (page === 2) return out(answer([])); // the model never returns page 2
    return out(answer([{ p: page, rows: 1, ppl: [person(`Test Page${page}`, 1, ['9-17', ''])] }]));
  });
  const outcome = await aiReadRoster({ kind: 'file', data: Buffer.from('%PDF'), mimeType: 'application/pdf', name: 'r.pdf', pageCount: 3 }, { provider: mock, locationId: null, userId: null, deadline: far() });
  assert.equal(maxInFlight, 3, 'the three pages were read at the same time');
  assert.deepEqual(mock.calls.filter((c) => !c.strict).map((c) => c.focus?.page).sort(), [1, 2, 3]);
  assert.deepEqual(mock.calls.filter((c) => c.strict).map((c) => c.focus?.page), [2], 're-read once');
  assert.deepEqual(outcome.missingPages, [2]);
  assert.equal(outcome.complete, false);
});

test('aiReadRoster: an answer cut off at the output cap is never trusted; the page is re-read in two halves', async () => {
  const mock = new MockVisionProvider((input: VisionInput) => {
    if (!input.focus) return out('{"title":null,"days":[', { truncated: true });
    const from = input.focus.rows!.from;
    return out(answer([{ p: 1, rows: 4, ppl: from === 1 ? [person('Test A', 1, ['9-17', '']), person('Test B', 2, ['9-17', ''])] : [person('Test C', 3, ['9-17', '']), person('Test D', 4, ['9-17', ''])] }]));
  });
  const outcome = await aiReadRoster(
    { kind: 'file', data: Buffer.from('png'), mimeType: 'image/png', name: 'r.png', pageCount: 1 },
    { provider: mock, locationId: null, userId: null, deadline: far(), tablePeoplePerPage: new Map([[1, 4]]) },
  );
  assert.deepEqual(mock.calls.slice(1).map((c) => c.focus?.rows), [{ from: 1, to: 2 }, { from: 3, to: null }]);
  assert.equal(outcome.answer.pages[0]!.sec.flatMap((s) => s.ppl).length, 4);
  assert.equal(outcome.complete, true);
});

test('aiReadRoster: with too little time left no re-read is started, and the short page is reported', async () => {
  const mock = new MockVisionProvider(() => out(answer([{ p: 1, rows: 2, ppl: [person('Test A', 1, ['9-17', ''])] }])));
  const outcome = await aiReadRoster({ kind: 'file', data: Buffer.from('png'), mimeType: 'image/png', name: 'r.png', pageCount: 1 }, { provider: mock, locationId: null, userId: null, deadline: Date.now() + 5_000 });
  assert.equal(mock.calls.length, 1);
  assert.deepEqual(outcome.shortPages, [{ page: 1, expected: 2, read: 1 }]);
});

test('reconcileReadings: matching shifts are "both"; one-reader people and shifts are kept and flagged; times that differ keep the printed text\'s with both readings', () => {
  const ai = mapReadingAnswer(
    answer([{ p: 1, rows: 3, ppl: [person('Test Alpha', 1, ['9-17', '10-18']), person('Test Betta', 2, ['12-20', '']), person('Test Only Ai', 3, ['9-17', ''])] }]),
    { today: TODAY, clientWeekStart: null },
  );
  const table = parseExcelGrid(
    [
      ['', '24-Aug', '25-Aug'],
      ['', 'MONDAY', 'TUESDAY'],
      ['Test Alpha', '9-17', '11-18'],
      ['Test Beta', '12-20', ''],
      ['Test Only Table', '', '9-17'],
    ],
    TODAY,
    { today: TODAY, clientWeekStart: null },
  );
  const { result, disagreements } = reconcileReadings(ai, table);
  const row = (name: string, date: string) => result.rows.find((r) => r.employeeName === name && r.date === date)!;
  assert.equal(row('Test Alpha', '2026-08-24').readerSource, 'both');
  assert.deepEqual(row('Test Alpha', '2026-08-25').flags, ['times_differ']);
  assert.deepEqual(row('Test Alpha', '2026-08-25').alternatives?.map((a) => `${a.reader}:${a.startTime}`), ['table:11:00', 'ai:10:00']);
  assert.equal(row('Test Alpha', '2026-08-25').startTime, '11:00', "the table reader's times (the file's own text) stay; the AI's are the alternative");
  // A one-letter misreading pairs with the file's own spelling, which is kept.
  const beta = result.people!.find((p) => p.name === 'Test Beta')!;
  assert.equal(beta.readerSource, 'both');
  assert.deepEqual(beta.nameAlternatives, [{ reader: 'ai', name: 'Test Betta' }]);
  assert.deepEqual(row('Test Only Ai', '2026-08-24').flags, ['ai_only']);
  assert.deepEqual(row('Test Only Table', '2026-08-25').flags, ['table_only']);
  assert.equal(result.people!.find((p) => p.name === 'Test Only Table')!.readerSource, 'table');
  assert.equal(disagreements, 4, 'times differ, a misread name, one AI-only person, one table-only person');
  assert.equal(new Set(result.rows.map((r) => r.rowNumber)).size, result.rows.length, 'row numbers stay unique');
});

// --- the upload path (readUpload.ts) with a mock AI reader ---------------------------------------

function sheet(rows: unknown[][]): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Rota');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

async function textPdf(lines: { text: string; x: number; y: number }[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([700, 400]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const l of lines) page.drawText(l.text, { x: l.x, y: l.y, size: 9, font });
  return Buffer.from(await doc.save());
}

const PDF_LINES = [
  { text: '24-Aug', x: 200, y: 380 },
  { text: '25-Aug', x: 300, y: 380 },
  { text: 'SUPERVISORS', x: 20, y: 368 },
  { text: 'Test Alpha', x: 20, y: 356 },
  { text: '9-17', x: 200, y: 356 },
  { text: 'Test Blank', x: 20, y: 344 },
];

function ctx(over: Partial<UploadReadContext> = {}): UploadReadContext {
  return {
    locationId: 'loc-1',
    userId: 'user-1',
    today: TODAY,
    clientWeekStart: null,
    aiConsent: true,
    provider: null,
    aiBlockedReason: async () => null,
    markAiUsed: async () => {},
    cache: null,
    deadline: far(),
    ...over,
  };
}

const pdfAnswer = answer([{ p: 1, rows: 2, ppl: [person('Test Alpha', 1, ['9-17', '']), person('Test Blank', 2, ['', ''])] }]);

test('upload: a text-layer PDF is read by the AI and cross-checked by the table reader; the report says so', async () => {
  const mock = new MockVisionProvider(out(pdfAnswer).raw);
  let used = 0;
  const outcome = await readUploadedRoster({ buffer: await textPdf(PDF_LINES), mimetype: 'application/pdf', originalname: 'r.pdf', size: 1 }, ctx({ provider: mock, markAiUsed: async () => void used++ }));
  assert.ok(outcome.ok);
  assert.equal(mock.calls.length, 1);
  assert.equal((mock.calls[0] as VisionInput & { pageTexts?: string[] }).pageTexts?.length, 1, 'the text layer goes with the file');
  assert.equal(used, 1);
  assert.deepEqual(outcome.result.people?.map((p) => `${p.name}|${p.readerSource}`), ['Test Alpha|both', 'Test Blank|both']);
  assert.equal(outcome.result.week.weekStart, '2026-08-24');
  const { note, ...report } = outcome.reading;
  assert.deepEqual({ ...report, rereadPages: [] }, { ai: 'used', table: 'used', rowsDetected: 2, peopleFound: 2, rereadPages: [], disagreements: 0, fromCache: false });
  assert.match(note!, /cross-checked/);
});

test('upload: consent declined — a text-layer PDF still gets the table reader\'s result, with the AI offered', async () => {
  const mock = new MockVisionProvider(out(pdfAnswer).raw);
  const outcome = await readUploadedRoster({ buffer: await textPdf(PDF_LINES), mimetype: 'application/pdf', originalname: 'r.pdf', size: 1 }, ctx({ provider: mock, aiConsent: false }));
  assert.ok(outcome.ok);
  assert.equal(mock.calls.length, 0, 'nothing sent');
  assert.equal(outcome.reading.ai, 'declined');
  assert.deepEqual([outcome.escalation?.reason, outcome.escalation?.status], ['ai_cross_check', 'needs_consent']);
  assert.deepEqual(outcome.result.people?.map((p) => p.name), ['Test Alpha', 'Test Blank']);
});

test('upload: AI paused by the spend cap — the table result stands and the report says paused; a photo is refused with the code', async () => {
  const paused = new MockVisionProvider(() => {
    throw new VisionProviderError('cap', 'paused');
  });
  const pdf = await readUploadedRoster({ buffer: await textPdf(PDF_LINES), mimetype: 'application/pdf', originalname: 'r.pdf', size: 1 }, ctx({ provider: paused }));
  assert.ok(pdf.ok);
  assert.equal(pdf.reading.ai, 'paused');
  assert.equal(pdf.result.rows.length, 1);
  const photo = await readUploadedRoster({ buffer: Buffer.from('png'), mimetype: 'image/png', originalname: 'r.png', size: 3 }, ctx({ provider: paused }));
  assert.ok(!photo.ok);
  assert.equal(photo.body.errorCode, 'vision_paused');
});

test('upload: the same file again is answered from the venue\'s cache — no model call, no allowance, "cached"', async () => {
  const mock = new MockVisionProvider(out(answer([{ p: 1, rows: 1, ppl: [person('Test Alpha', 1, ['9-17', ''])] }])).raw);
  const cache = memoryReadingCache();
  let used = 0;
  const photo = { buffer: Buffer.from('the same png bytes'), mimetype: 'image/png', originalname: 'r.png', size: 18 };
  const first = await readUploadedRoster(photo, ctx({ provider: mock, cache, markAiUsed: async () => void used++ }));
  assert.ok(first.ok && first.reading.ai === 'used' && !first.reading.fromCache);
  const again = await readUploadedRoster(photo, ctx({ provider: mock, cache, aiConsent: false, markAiUsed: async () => void used++ }));
  assert.ok(again.ok);
  assert.equal(again.reading.ai, 'cached');
  assert.equal(again.reading.fromCache, true);
  assert.equal(mock.calls.length, 1, 'no second call');
  assert.equal(used, 1, 'no second allowance');
  assert.deepEqual(again.result.rows.map((r) => r.date), ['2026-08-24']);
  // Another venue's upload of the same file is read afresh.
  await readUploadedRoster(photo, ctx({ provider: mock, cache, locationId: 'loc-2' }));
  assert.equal(mock.calls.length, 2);
});

test('upload: an incomplete AI reading is not cached (the next upload tries again)', async () => {
  const mock = new MockVisionProvider(() => out(answer([{ p: 1, rows: 3, ppl: [person('Test Alpha', 1, ['9-17', ''])] }])));
  const cache = memoryReadingCache();
  const outcome = await readUploadedRoster({ buffer: Buffer.from('png'), mimetype: 'image/png', originalname: 'r.png', size: 3 }, ctx({ provider: mock, cache }));
  assert.ok(outcome.ok);
  assert.equal(cache.size(), 0);
  assert.ok(outcome.result.unreadRows?.some((u) => /2 person row\(s\) on page 1 could not be read/.test(u.reason)));
});

test('second roster, same format, different printed week: each lands in its own week', async () => {
  const roster = (d: number) => sheet([
    ['', `${d}-Aug`, `${d + 1}-Aug`],
    ['', 'MONDAY', 'TUESDAY'],
    ['SUPERVISORS', '', ''],
    ['Test Alpha', '9-17', '9-17'],
    ['Test Blank', '', ''],
  ]);
  const first = await readUploadedRoster({ buffer: roster(17), mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', originalname: 'a.xlsx', size: 1 }, ctx());
  const second = await readUploadedRoster({ buffer: roster(24), mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', originalname: 'b.xlsx', size: 1 }, ctx());
  assert.ok(first.ok && second.ok);
  assert.deepEqual([first.result.week.weekStart, second.result.week.weekStart], ['2026-08-17', '2026-08-24']);
  assert.deepEqual(second.result.rows.map((r) => r.date), ['2026-08-24', '2026-08-25']);
  assert.deepEqual(second.result.people?.map((p) => p.name), ['Test Alpha', 'Test Blank'], 'the person with no shifts is read too');
  assert.equal(second.reading.ai, 'not_used');
});

test('mapReadingAnswer: day columns split into AM / PM halves are one day; headcounts, captions and banners listed as people are set aside', () => {
  const a: ReadingAnswer = {
    title: null,
    days: ['17-Aug MONDAY AM', '17-Aug MONDAY PM', '18-Aug TUESDAY AM', '18-Aug TUESDAY PM'],
    key: [],
    pages: [{ p: 1, rows: 4, sec: [{ h: null, n: 4, ppl: [person('Test Alpha', 1, ['11 17', '18 25', '', '']), person('3', 2, ['2', '1', '', '']), person('COVERS', 3, ['', 'Party - 20pax', '', '']), person('SUPERVISORS', 4, ['', '', '', ''])] }], unread: [] }],
  };
  const result = mapReadingAnswer(a, { today: TODAY, clientWeekStart: null });
  assert.deepEqual(result.rows.map((r) => `${r.date} ${r.startTime}-${r.endTime}`), ['2026-08-17 11:00-17:00', '2026-08-17 18:00-01:00']);
  assert.deepEqual(result.people?.map((p) => p.name), ['Test Alpha']);
  assert.deepEqual(result.unreadRows?.map((u) => u.text), ['3', 'COVERS', 'SUPERVISORS']);
});

test('aiReadRoster: a focused answer counts only for its page, even if the model returns others', async () => {
  const mock = new MockVisionProvider((input: VisionInput) =>
    out(answer([{ p: 1, rows: 1, ppl: [person(`Test Page${input.focus!.page}`, 1, ['9-17', ''])] }, { p: 2, rows: 1, ppl: [person('Test Stray', 1, ['9-17', ''])] }])),
  );
  const outcome = await aiReadRoster({ kind: 'file', data: Buffer.from('%PDF'), mimeType: 'application/pdf', name: 'r.pdf', pageCount: 2 }, { provider: mock, locationId: null, userId: null, deadline: far() });
  assert.deepEqual(outcome.answer.pages.map((p) => `${p.p}:${p.sec[0]!.ppl.map((x) => x.nm).join(',')}`), ['1:Test Page1', '2:Test Stray']);
});

test('reconcileReadings: a segment only the AI saw, on a day the table reader read, is another reading of that day, not a new shift', () => {
  const ai = mapReadingAnswer(answer([{ p: 1, rows: 1, ppl: [person('Test Gamma', 1, ['9-13/18-22', ''])] }]), { today: TODAY, clientWeekStart: null });
  const table = parseExcelGrid(
    [
      ['', '24-Aug', '25-Aug'],
      ['', 'MONDAY', 'TUESDAY'],
      ['Test Gamma', '9-13', ''],
    ],
    TODAY,
    { today: TODAY, clientWeekStart: null },
  );
  const { result, disagreements } = reconcileReadings(ai, table);
  const day = result.rows.filter((r) => r.employeeName === 'Test Gamma' && r.date === '2026-08-24');
  assert.equal(day.length, 1, 'no extra shift from the AI-only segment');
  assert.equal(day[0]!.startTime, '09:00');
  assert.deepEqual(day[0]!.flags, ['times_differ']);
  assert.deepEqual(day[0]!.alternatives?.map((a) => `${a.reader}:${a.startTime}-${a.endTime}`), ['table:09:00-13:00', 'ai:18:00-22:00']);
  assert.equal(disagreements, 1);
});

test('reconcileReadings: a day only the AI read, for a person the table reader read, is a cell to look at — never a new shift', () => {
  // The AI slipped one column: Tuesday's shift read as Monday's.
  const ai = mapReadingAnswer(answer([{ p: 1, rows: 1, ppl: [person('Test Delta', 1, ['9-17', ''])] }]), { today: TODAY, clientWeekStart: null });
  const table = parseExcelGrid(
    [
      ['', '24-Aug', '25-Aug'],
      ['', 'MONDAY', 'TUESDAY'],
      ['Test Delta', '', '9-17'],
    ],
    TODAY,
    { today: TODAY, clientWeekStart: null },
  );
  const { result, disagreements } = reconcileReadings(ai, table);
  const delta = result.rows.filter((r) => r.employeeName === 'Test Delta');
  assert.deepEqual(delta.map((r) => `${r.date} ${r.startTime} ${r.flags?.join(',') ?? ''}`), ['2026-08-25 09:00 table_only']);
  const cell = result.anomalies.find((a) => a.employeeName === 'Test Delta' && a.date === '2026-08-24');
  assert.ok(cell, 'the AI-only day is shown to the manager');
  assert.match(cell!.rawText, /09:00–17:00/);
  assert.equal(disagreements, 2);
});
