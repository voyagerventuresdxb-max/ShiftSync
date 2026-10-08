import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSXNS from 'xlsx';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { aiReadRoster, reconcileReadings } from './rosterReading.js';
import { readUploadedRoster, type UploadReadContext } from './readUpload.js';
import { memoryReadingCache } from './readingCache.js';
import { aiCrossRead } from './aiCrossCheck.js';
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

/** The same reading in the column framing (the second read of a photo or scan). */
function columnsOf(a: ReadingAnswer): unknown {
  return {
    title: a.title,
    days: a.days,
    key: a.key,
    pages: a.pages.map((pg) => {
      const ppl = pg.sec.flatMap((s) => s.ppl.map((x) => ({ i: x.i, nm: x.nm, t: x.t, h: s.h })));
      const all = pg.sec.flatMap((s) => s.ppl);
      return { p: pg.p, rows: pg.rows, ppl, cols: a.days.map((_, d) => ({ d, c: all.filter((x) => x.c[d]).map((x) => ({ i: x.i, x: x.c[d]! })) })), unread: [] };
    }),
  };
}
/** A provider answering the row framing with `rows` and the column framing with `columns` (default: the same reading). */
const twoFramings = (rows: ReadingAnswer, columns: ReadingAnswer = rows) =>
  new MockVisionProvider((input: VisionInput) => out(input.framing === 'columns' ? JSON.stringify(columnsOf(columns)) : rows));

test('mapReadingAnswer: dates from the printed day headers, times read by the table reader\'s rules, every person kept', () => {
  const result = mapReadingAnswer(
    answer([{ p: 1, rows: 3, ppl: [person('Test Alpha', 1, ['11 17 18 25', '']), person('Test Blank', 2, ['[Holiday]', '']), person('Test Gamma', 3, ['4CL', '[?]'])] }]),
    { today: TODAY, clientWeekStart: null },
  );
  assert.equal(result.week?.weekStart, '2026-08-24');
  assert.deepEqual(result.rows.map((r) => `${r.employeeName}|${r.date}|${r.startTime}-${r.endTime}|${r.readerSource}`), ['Test Alpha|2026-08-24|11:00-17:00|ai', 'Test Alpha|2026-08-24|18:00-01:00|ai']);
  assert.deepEqual(result.people?.map((p) => p.name), ['Test Alpha', 'Test Blank', 'Test Gamma']);
  assert.deepEqual(result.leaveRecords.map((l) => `${l.employeeName}|${l.leaveCode}|${l.category}`), ['Test Blank|Holiday|public_holiday']);
  assert.ok(result.anomalies.some((a) => a.employeeName === 'Test Gamma' && /until close/i.test(a.reason)));
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

test('reconcileReadings: matching shifts are "both"; one-reader people are kept (an AI-only person\'s shifts only when a second AI reading confirms them); times that differ on a cell the table reader had to guess keep the printed text\'s with both readings', () => {
  const ai = mapReadingAnswer(
    answer([{ p: 1, rows: 3, ppl: [person('Test Alpha', 1, ['9-17', '10-18']), person('Test Betta', 2, ['12-20', '']), person('Test Solo Ai', 3, ['9-17', ''])] }]),
    { today: TODAY, clientWeekStart: null },
  );
  const table = parseExcelGrid(
    [
      ['', '24-Aug', '25-Aug'],
      ['', 'MONDAY', 'TUESDAY'],
      // "11-6pm": the table reader has to guess the start's am / pm.
      ['Test Alpha', '9-17', '11-6pm'],
      ['Test Beta', '12-20', ''],
      ['Test Solo Table', '', '9-17'],
    ],
    TODAY,
    { today: TODAY, clientWeekStart: null },
  );
  const { result, disagreements, aiDiffCells } = reconcileReadings(ai, table);
  const row = (name: string, date: string) => result.rows.find((r) => r.employeeName === name && r.date === date)!;
  assert.equal(row('Test Alpha', '2026-08-24').readerSource, 'both');
  assert.deepEqual(row('Test Alpha', '2026-08-25').flags, ['times_differ']);
  assert.deepEqual(row('Test Alpha', '2026-08-25').alternatives?.map((a) => `${a.reader}:${a.startTime}`), ['table:11:00', 'ai:10:00']);
  assert.equal(row('Test Alpha', '2026-08-25').startTime, '11:00', "the table reader's times (the file's own text) stay; the AI's are the alternative");
  // A one-letter misreading pairs with the file's own spelling, which is kept.
  const beta = result.people!.find((p) => p.name === 'Test Beta')!;
  assert.equal(beta.readerSource, 'both');
  assert.deepEqual(beta.nameAlternatives, [{ reader: 'ai', name: 'Test Betta' }]);
  // A person only the AI reader saw: listed, but no shift saved on its word alone — each day shown to check.
  assert.equal(row('Test Solo Ai', '2026-08-24'), undefined);
  assert.equal(result.people!.find((p) => p.name === 'Test Solo Ai')!.readerSource, 'ai');
  assert.ok(result.anomalies.some((x) => x.employeeName === 'Test Solo Ai' && x.date === '2026-08-24' && /Only the AI reader saw this person/.test(x.reason)));
  // Confirmed by a second, independent AI reading (a photo or an unanchored text PDF), the shift is saved, flagged.
  assert.deepEqual(reconcileReadings(ai, table, { aiConfirmed: true }).result.rows.find((r) => r.employeeName === 'Test Solo Ai')?.flags, ['ai_only']);
  // A person only the table reader read, from the file's own text for certain: kept as read (the person is marked table-only).
  assert.equal(row('Test Solo Table', '2026-08-25').flags, undefined);
  assert.equal(result.people!.find((p) => p.name === 'Test Solo Table')!.readerSource, 'table');
  assert.equal(disagreements, 4, 'times differ on a guessed cell, a misread name, one AI-only person, one table-only person');
  assert.equal(aiDiffCells, 0);
  assert.equal(new Set(result.rows.map((r) => r.rowNumber)).size, result.rows.length, 'row numbers stay unique');
});

test('reconcileReadings: where the table reader read a cell from the file\'s own text for certain, the AI reading it otherwise is counted, never flagged', () => {
  const ai = mapReadingAnswer(
    answer([{ p: 1, rows: 2, ppl: [person('Test Alpha', 1, ['9-16', '']), person('Test Beta', 2, ['OFF', '12-20'])] }]),
    { today: TODAY, clientWeekStart: null },
  );
  ai.anomalies.push({ employeeName: 'Test Beta', date: '2026-08-25', rawText: '12-20', reason: 'The AI was unsure.', confidence: 0.4, rowNumber: null });
  const table = parseExcelGrid(
    [
      ['', '24-Aug', '25-Aug'],
      ['', 'MONDAY', 'TUESDAY'],
      ['Test Alpha', '9-17', '10-18'],
      ['Test Beta', 'OFF', '12-20'],
    ],
    TODAY,
    { today: TODAY, clientWeekStart: null },
  );
  const { result, disagreements, aiDiffCells } = reconcileReadings(ai, table);
  assert.deepEqual(result.rows.map((r) => `${r.employeeName}|${r.date}|${r.startTime}-${r.endTime}|${(r.flags ?? []).join(',')}`), [
    'Test Alpha|2026-08-24|09:00-17:00|',
    'Test Alpha|2026-08-25|10:00-18:00|',
    'Test Beta|2026-08-25|12:00-20:00|',
  ]);
  assert.equal(disagreements, 0);
  assert.equal(aiDiffCells, 2, "Monday's other times and Tuesday's shift the AI missed");
  assert.deepEqual(result.anomalies, [], "the AI's note on a day the file's text settled is not shown");
});

test('reconcileReadings: a day the PDF reader inferred is confirmed when the AI reads the same; when the AI puts those times on another day, neither is written', () => {
  const grid = [
    ['', '24-Aug', '25-Aug'],
    ['', 'MONDAY', 'TUESDAY'],
    ['Test Alpha', '9-17', ''],
    ['Test Beta', '', '10-18'],
  ];
  // Both cells' days inferred from the column alignment (grid columns 1 and 2 of rows 3 and 4).
  const inferredCells = [{ page: null, row: 3, col: 1 }, { page: null, row: 4, col: 2 }];
  const table = parseExcelGrid(grid, TODAY, { today: TODAY, clientWeekStart: null, inferredCells });
  assert.deepEqual(table.rows.map((r) => r.flags), [['low_confidence'], ['low_confidence']], 'never saved silently on its own');
  const ai = mapReadingAnswer(answer([{ p: 1, rows: 2, ppl: [person('Test Alpha', 1, ['9-17', '']), person('Test Beta', 2, ['10-18', ''])] }]), { today: TODAY, clientWeekStart: null });
  const { result, disagreements } = reconcileReadings(ai, table);
  assert.deepEqual(result.rows.map((r) => `${r.employeeName}|${r.date}|${(r.flags ?? []).join(',')}`), ['Test Alpha|2026-08-24|'], 'the AI confirms Alpha\'s Monday');
  assert.ok(result.rows.every((r) => r.inferredDay === undefined));
  assert.deepEqual(result.anomalies.filter((a) => a.employeeName === 'Test Beta').map((a) => a.date).sort(), ['2026-08-24', '2026-08-25']);
  assert.ok(result.anomalies.every((a) => /same times on different days/.test(a.reason)));
  assert.equal(disagreements, 2);
});

test('reconcileReadings: a week the file prints for certain stands over an AI reading of another week (counted, nothing to confirm)', () => {
  const ai = mapReadingAnswer({ ...answer([{ p: 1, rows: 1, ppl: [person('Test Alpha', 1, ['9-17', ''])] }]), days: ['31-Aug MONDAY', '1-Sep TUESDAY'] }, { today: TODAY, clientWeekStart: null });
  const table = parseExcelGrid([['', '24-Aug', '25-Aug'], ['', 'MONDAY', 'TUESDAY'], ['Test Alpha', '9-17', '']], TODAY, { today: TODAY, clientWeekStart: null });
  const { result } = reconcileReadings(ai, table);
  assert.equal(result.week?.weekStart, '2026-08-24');
  assert.equal(result.week?.needsConfirmation, false);
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

test('upload: the same file again is answered from the venue\'s cache — both readings, no model call, no allowance, "cached"', async () => {
  const mock = twoFramings(answer([{ p: 1, rows: 1, ppl: [person('Test Alpha', 1, ['9-17', ''])] }]));
  const cache = memoryReadingCache();
  let used = 0;
  const photo = { buffer: Buffer.from('the same png bytes'), mimetype: 'image/png', originalname: 'r.png', size: 18 };
  const first = await readUploadedRoster(photo, ctx({ provider: mock, cache, markAiUsed: async () => void used++ }));
  assert.ok(first.ok && first.reading.ai === 'used' && !first.reading.fromCache);
  assert.equal(mock.calls.length, 2, 'a photo is read twice: person by person and day by day');
  const again = await readUploadedRoster(photo, ctx({ provider: mock, cache, aiConsent: false, markAiUsed: async () => void used++ }));
  assert.ok(again.ok);
  assert.equal(again.reading.ai, 'cached');
  assert.equal(again.reading.fromCache, true);
  assert.match(again.reading.note!, /read it twice/, 'the cached reading carries its cross-check');
  assert.equal(mock.calls.length, 2, 'no further call');
  assert.equal(used, 1, 'no second allowance');
  assert.deepEqual(again.result.rows.map((r) => r.date), ['2026-08-24']);
  // Another venue's upload of the same file is read afresh.
  await readUploadedRoster(photo, ctx({ provider: mock, cache, locationId: 'loc-2' }));
  assert.equal(mock.calls.length, 4);
});

test('upload: a reading still short after its re-read is cached — the same file again makes no call and still lists the rows it could not read', async () => {
  const short = answer([{ p: 1, rows: 3, ppl: [person('Test Alpha', 1, ['9-17', ''])] }]);
  const mock = twoFramings(short);
  const cache = memoryReadingCache();
  const photo = { buffer: Buffer.from('png short'), mimetype: 'image/png', originalname: 'r.png', size: 9 };
  const outcome = await readUploadedRoster(photo, ctx({ provider: mock, cache }));
  assert.ok(outcome.ok);
  assert.deepEqual(outcome.reading.rereadPages, [1], 'the short page was read a second time');
  assert.equal(cache.size(), 1);
  const calls = mock.calls.length;
  const again = await readUploadedRoster(photo, ctx({ provider: mock, cache }));
  assert.ok(again.ok);
  assert.equal(again.reading.fromCache, true);
  assert.equal(mock.calls.length, calls, 'no billed call');
  for (const o of [outcome, again]) assert.ok(o.result.unreadRows?.some((u) => /2 person row\(s\) on page 1 could not be read/.test(u.reason)));
});

test('upload: a short reading that could not be read a second time is not cached (the next upload tries again)', async () => {
  const mock = twoFramings(answer([{ p: 1, rows: 3, ppl: [person('Test Alpha', 1, ['9-17', ''])] }]));
  const cache = memoryReadingCache();
  const outcome = await readUploadedRoster({ buffer: Buffer.from('png'), mimetype: 'image/png', originalname: 'r.png', size: 3 }, ctx({ provider: mock, cache, deadline: Date.now() + 5_000 }));
  assert.ok(outcome.ok);
  assert.deepEqual(outcome.reading.rereadPages, []);
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
  const { result, disagreements, aiDiffCells } = reconcileReadings(ai, table);
  const day = result.rows.filter((r) => r.employeeName === 'Test Gamma' && r.date === '2026-08-24');
  assert.equal(day.length, 1, 'no extra shift from the AI-only segment');
  assert.equal(day[0]!.startTime, '09:00');
  assert.equal(day[0]!.flags, undefined, "the file's own text read for certain: the AI's extra segment is counted, not flagged");
  assert.equal(disagreements, 0);
  assert.equal(aiDiffCells, 1);
  // The same cell where the table reader had to guess am / pm ("9-1pm"): the AI's other reading is shown.
  const guessed = parseExcelGrid([['', '24-Aug', '25-Aug'], ['', 'MONDAY', 'TUESDAY'], ['Test Gamma', '9-1pm', '']], TODAY, { today: TODAY, clientWeekStart: null });
  const again = reconcileReadings(ai, guessed);
  const cell = again.result.rows.filter((r) => r.employeeName === 'Test Gamma' && r.date === '2026-08-24');
  assert.equal(cell.length, 1);
  assert.deepEqual(cell[0]!.flags, ['times_differ']);
  assert.deepEqual(cell[0]!.alternatives?.map((a) => `${a.reader}:${a.startTime}-${a.endTime}`), ['table:09:00-13:00', 'ai:18:00-22:00']);
  assert.equal(again.disagreements, 1);
});

test('reconcileReadings: the same times on different days on a row whose day the table reader had to infer — neither day is written; both are shown', () => {
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
  const uncertain = new Set(table.people!.map((p) => p.personKey));
  const { result, disagreements } = reconcileReadings(ai, table, { placementUncertain: uncertain });
  const delta = result.rows.filter((r) => r.employeeName === 'Test Delta');
  assert.deepEqual(delta, [], 'neither day is written');
  for (const date of ['2026-08-24', '2026-08-25']) {
    const cell = result.anomalies.find((a) => a.employeeName === 'Test Delta' && a.date === date);
    assert.match(cell!.reason, /same times on different days/);
  }
  assert.equal(result.anomalies.find((a) => a.date === '2026-08-24')!.rawText, 'Built-in reader: nothing · AI reader: 09:00–17:00');
  assert.equal(disagreements, 2);
});

// --- round 2: what must never become a person, and the cross-check of photos and scans --------

test('mapReadingAnswer: the title column taken for the names is read the other way round; titles, headings and totals listed as people are set aside', () => {
  const result = mapReadingAnswer(
    answer([{
      p: 1,
      rows: 3,
      ppl: [
        person('Waiter 3', 1, ['9-17', ''], 'Test Alpha'),
        person('RM', 2, ['', '4pm to 2am'], 'Test Beta'),
        person('TITLE', 3, ['', '']),
        person('Total staff on rota: 2', 4, ['1', '1']),
        person('Ops Manager', 5, ['9-17', '']),
      ],
    }]),
    { today: TODAY, clientWeekStart: null },
  );
  assert.deepEqual(result.people?.map((p) => `${p.name}|${p.roleLabel}`), ['Test Alpha|Waiter 3', 'Test Beta|RM']);
  assert.deepEqual(result.rows.map((r) => r.employeeName), ['Test Alpha', 'Test Beta']);
  assert.deepEqual(result.unreadRows?.map((u) => u.text), ['TITLE', 'Total staff on rota: 2', 'Ops Manager']);
});

test('mapReadingAnswer: a coloured cell holding times is the times; colour alone is a colour; a row the model listed and also called cut off is read', () => {
  const a = answer([{ p: 1, rows: 1, ppl: [person('Test Alpha', 1, ['[Closing] 16 18 18.5 26', '[16 20.5 21 26]'])] }]);
  a.pages[0]!.unread.push({ r: 1, x: 'Test Alpha | 16 18 18.5 26', w: 'cut off at the bottom of the page' }, { r: 2, x: '???', w: 'illegible' });
  const result = mapReadingAnswer(a, { today: TODAY, clientWeekStart: null });
  assert.deepEqual(result.rows.map((r) => `${r.date} ${r.startTime}-${r.endTime}`), ['2026-08-24 16:00-18:00', '2026-08-24 18:30-02:00', '2026-08-25 16:00-20:30', '2026-08-25 21:00-02:00']);
  assert.deepEqual(result.leaveRecords, []);
  assert.deepEqual(result.unreadRows?.map((u) => u.text), ['???']);
});

test('reconcileReadings: a title, heading or totals line only one reader took for a person is not imported; a name split at a ligature keeps the joined spelling', () => {
  const ai = mapReadingAnswer(answer([{ p: 1, rows: 2, ppl: [person('Saffiya Okonkwo', 1, ['9-17', '']), person('Test Beta', 2, ['', '10-18'])] }]), { today: TODAY, clientWeekStart: null });
  // The table reader's text layer split the name at "ffi"; a title and a totals line slipped in.
  const table = parseExcelGrid(
    [
      ['', '24-Aug', '25-Aug'],
      ['', 'MONDAY', 'TUESDAY'],
      ['Sa ffi ya Okonkwo', '9-17', ''],
      ['Test Beta', '', '10-18'],
    ],
    TODAY,
    { today: TODAY, clientWeekStart: null },
  );
  table.people!.push({ personKey: 'x@1:9', name: 'Waiter 3', roleLabel: null, section: null, sourcePage: 1, sourceRow: 9, readerSource: 'table' });
  ai.people!.push({ personKey: 'y@1:10', name: 'Total staff on rota', roleLabel: null, section: null, sourcePage: 1, sourceRow: 10, readerSource: 'ai' });
  const { result } = reconcileReadings(ai, table);
  assert.deepEqual(result.people?.map((p) => `${p.name}|${p.readerSource}`), ['Saffiya Okonkwo|both', 'Test Beta|both']);
  // The table reader joins the word its text layer split at the ligature: one spelling, nothing to ask.
  assert.equal(result.people?.[0]?.nameAlternatives, undefined);
  assert.ok(result.rows.every((r) => r.employeeName !== 'Sa ffi ya Okonkwo'));
  assert.deepEqual(result.unreadRows?.map((u) => u.text).sort(), ['Total staff on rota', 'Waiter 3']);
});

test('photo cross-check: a cell the two readings read differently writes nothing — it is a cell to look at with both readings; what both read is written', async () => {
  const first = answer([{ p: 1, rows: 2, ppl: [person('Test Alpha', 1, ['', '18 26']), person('Test Beta', 2, ['[Closing]', '16 18.5 18.5 26'])] }]);
  const second = answer([{ p: 1, rows: 3, ppl: [person('Test Alpha', 1, ['18 26', '']), person('Test Beta', 2, ['16 18 18.5 26', '16 18 18.5 26']), person('Test Gamma', 3, ['[Holiday]', ''])] }]);
  const mock = twoFramings(first, second);
  const outcome = await readUploadedRoster({ buffer: Buffer.from('png 2'), mimetype: 'image/png', originalname: 'r.png', size: 5 }, ctx({ provider: mock }));
  assert.ok(outcome.ok);
  assert.deepEqual(mock.calls.map((c) => c.framing ?? 'rows').sort(), ['columns', 'rows'], 'both readings, at the same time');
  const rows = outcome.result.rows.map((r) => `${r.employeeName}|${r.date}|${r.startTime}-${r.endTime}`);
  // Only the segment both readings saw is written.
  assert.deepEqual(rows, ['Test Beta|2026-08-25|18:30-02:00']);
  const cell = (name: string, date: string) => outcome.result.anomalies.find((x) => x.employeeName === name && x.date === date && /disagree on this day, so neither was imported/.test(x.reason));
  // The slipped value: neither day is written; both are cells to look at, with both readings.
  assert.equal(cell('Test Alpha', '2026-08-24')?.rawText, 'First reading: nothing · second reading: 18:00–02:00');
  assert.equal(cell('Test Alpha', '2026-08-25')?.rawText, 'First reading: 18:00–02:00 · second reading: nothing');
  // Times one reading saw where the other saw colour only: not written, shown.
  assert.equal(cell('Test Beta', '2026-08-24')?.rawText, 'First reading: Closing · second reading: 16:00–18:00 · 18:30–02:00');
  // 18 vs 18.5: not written; both readings shown.
  assert.equal(cell('Test Beta', '2026-08-25')?.rawText, 'First reading: 16:00–18:30 · 18:30–02:00 · second reading: 16:00–18:00 · 18:30–02:00');
  // The person only the second reading listed is kept, flagged.
  assert.deepEqual(outcome.result.people?.map((p) => p.name), ['Test Alpha', 'Test Beta', 'Test Gamma']);
  assert.ok(outcome.result.anomalies.some((x) => x.employeeName === 'Test Gamma' && /Only one of the two AI readings listed/.test(x.reason)));
  // …and marked, so the review asks before importing them (a misread line is not a person).
  assert.deepEqual(outcome.result.people?.filter((p) => p.oneReading).map((p) => p.name), ['Test Gamma']);
  assert.ok(outcome.reading.disagreements >= 5);
  assert.match(outcome.reading.note!, /read it twice/);
  assert.match(outcome.reading.note!, /^This photo was hard to read — 4 cells need checking/, 'every compared cell differed');
});

test('photo cross-check: a few cells read two ways on a page the readings otherwise agree on — what both read is written, the rest shown to check', async () => {
  const names = Array.from({ length: 26 }, (_, i) => `Test Person ${String.fromCharCode(65 + i)}`);
  // One Tuesday of 52 days read two ways (under 6% of the page): the agree-only rule.
  const first = answer([{ p: 1, rows: 26, ppl: names.map((n, i) => person(n, i + 1, ['10 15', i < 1 ? '18 23.5' : '9 17'])) }]);
  const second = answer([{ p: 1, rows: 26, ppl: names.map((n, i) => person(n, i + 1, ['10 15', i < 1 ? '18 23' : '9 17'])) }]);
  const outcome = await readUploadedRoster({ buffer: Buffer.from('png 4'), mimetype: 'image/png', originalname: 'r.png', size: 5 }, ctx({ provider: twoFramings(first, second) }));
  assert.ok(outcome.ok);
  assert.equal(outcome.result.rows.length, 26 + 25, 'every agreed Monday and Tuesday is written');
  assert.equal(outcome.result.people?.length, 26);
  assert.equal(outcome.reading.withheldPages, undefined);
  assert.ok(outcome.result.anomalies.some((a) => a.employeeName === 'Test Person A' && a.date === '2026-08-25'));
});

test('photo cross-check: a page the two readings leave too much of in doubt saves nothing — no people, no shifts — and says so (5 of 52 days read differently)', async () => {
  const names = Array.from({ length: 26 }, (_, i) => `Test Person ${String.fromCharCode(65 + i)}`);
  const first = answer([{ p: 1, rows: 26, ppl: names.map((n, i) => person(n, i + 1, ['10 15', i < 5 ? '18 23.5' : '9 17'])) }]);
  const second = answer([{ p: 1, rows: 26, ppl: names.map((n, i) => person(n, i + 1, ['10 15', i < 5 ? '18 23' : '9 17'])) }]);
  const outcome = await readUploadedRoster({ buffer: Buffer.from('png 4b'), mimetype: 'image/png', originalname: 'r.png', size: 6 }, ctx({ provider: twoFramings(first, second) }));
  assert.ok(outcome.ok);
  assert.deepEqual(outcome.result.rows, []);
  assert.deepEqual(outcome.result.people, []);
  assert.deepEqual(outcome.result.leaveRecords, []);
  assert.deepEqual(outcome.result.anomalies, [], 'nothing to tick through: the page is shown as not read');
  assert.equal(outcome.reading.withheldPages?.length, 1);
  assert.match(outcome.reading.withheldPages![0]!.reason, /^Page 1 was hard to read: the two AI readings disagreed on, or were unsure of, 5 of its 52 days, so nothing from it was imported — no people, no shifts\. Upload the original PDF or spreadsheet/);
  assert.deepEqual(outcome.result.unreadRows?.map((u) => u.reason), [outcome.reading.withheldPages![0]!.reason]);
  assert.match(outcome.reading.note!, /^This photo was hard to read — the two readings disagreed on, or were unsure of, too much of it, so nothing from it was imported: no people, no shifts\. For best results upload the original PDF or spreadsheet/);
});

test('photo cross-check: on a trusted page a day both read the same way but one marked unsure is shown to check, never imported; marked unsure on too many days, the page saves nothing', async () => {
  const names = Array.from({ length: 26 }, (_, i) => `Test Person ${String.fromCharCode(65 + i)}`);
  const run = async (unsureCount: number, tag: string) => {
    // Every day read the same way; the row reading was unsure of a Tuesday for `unsureCount` people.
    const ppl = names.map((n, i) => ({ ...person(n, i + 1, ['10 15', '9 17']), ...(i < unsureCount ? { q: [1] } : {}) }));
    const first: ReadingAnswer = { ...answer([]), pages: [{ p: 1, rows: 26, sec: [{ h: null, n: 26, ppl }], unread: [] }] };
    const second = answer([{ p: 1, rows: 26, ppl: names.map((n, i) => person(n, i + 1, ['10 15', '9 17'])) }]);
    return readUploadedRoster({ buffer: Buffer.from(`png 9 ${tag}`), mimetype: 'image/png', originalname: 'r.png', size: 5 }, ctx({ provider: twoFramings(first, second) }));
  };
  // 1 of 52 days in doubt: trusted; the unsure Tuesday is shown, not imported.
  const few = await run(1, 'few');
  assert.ok(few.ok);
  if (!few.ok) return;
  assert.equal(few.reading.withheldPages, undefined);
  assert.equal(few.result.rows.length, 26 + 25, 'every Monday, and the Tuesdays neither reading doubted');
  assert.ok(few.result.rows.every((r) => !r.flags?.length));
  const unsure = few.result.anomalies.filter((a) => /one of them was unsure of them, so they were not imported/.test(a.reason));
  assert.deepEqual(unsure.map((a) => `${a.employeeName}|${a.date}|${a.rawText}`), ['Test Person A|2026-08-25|Both readings: 09:00–17:00']);
  // 4 of 52 days (over 6%) in doubt, though both readings agree everywhere: a low-contrast page may
  // be read the same wrong way twice — it fails loudly, never saves silently.
  const many = await run(4, 'many');
  assert.ok(many.ok);
  if (!many.ok) return;
  assert.deepEqual(many.result.rows, []);
  assert.deepEqual(many.result.people, []);
  assert.match(many.reading.withheldPages![0]!.reason, /disagreed on, or were unsure of, 4 of its 52 days/);
});

test('photo cross-check: a person only one reading listed is kept on the list, but none of their shifts is imported on that one reading', async () => {
  const names = Array.from({ length: 4 }, (_, i) => `Test Person ${String.fromCharCode(65 + i)}`);
  const first = answer([{ p: 1, rows: 5, ppl: [...names.map((n, i) => person(n, i + 1, ['10 15', '9 17'])), person('Test Extra', 5, ['18 23', ''])] }]);
  const second = answer([{ p: 1, rows: 4, ppl: names.map((n, i) => person(n, i + 1, ['10 15', '9 17'])) }]);
  const outcome = await readUploadedRoster({ buffer: Buffer.from('png 10'), mimetype: 'image/png', originalname: 'r.png', size: 6 }, ctx({ provider: twoFramings(first, second) }));
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.ok(outcome.result.people?.some((p) => p.name === 'Test Extra'));
  assert.deepEqual(outcome.result.rows.filter((r) => r.employeeName === 'Test Extra'), []);
  assert.ok(outcome.result.anomalies.some((a) => a.employeeName === 'Test Extra' && a.date === '2026-08-24' && /Only one of the two AI readings saw this shift/.test(a.reason)));
});

test('photo cross-check: a two-page scan whose second page is hard to read imports page 1 only; a person printed only on page 2 is never created', async () => {
  const p1 = Array.from({ length: 6 }, (_, i) => `Test Front ${String.fromCharCode(65 + i)}`);
  const p2 = Array.from({ length: 6 }, (_, i) => `Test Back ${String.fromCharCode(65 + i)}`);
  const mock = new MockVisionProvider((input: VisionInput) => {
    const page = input.focus!.page;
    const names = page === 1 ? p1 : p2;
    // Page 2: the two readings read most Tuesdays differently.
    const tue = (i: number) => (page === 2 && i < 4 ? (input.framing === 'columns' ? '18 23' : '18 23.5') : '9 17');
    const a = answer([{ p: page, rows: 6, ppl: names.map((n, i) => person(n, i + 1, ['10 15', tue(i)])) }]);
    return out(input.framing === 'columns' ? JSON.stringify(columnsOf(a)) : a);
  });
  const pdf = await (async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    doc.addPage([200, 200]);
    return Buffer.from(await doc.save());
  })();
  const outcome = await readUploadedRoster({ buffer: pdf, mimetype: 'application/pdf', originalname: 'scan.pdf', size: pdf.length }, ctx({ provider: mock }));
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.result.people?.map((p) => p.name), p1);
  assert.ok(outcome.result.rows.every((r) => r.employeeName.startsWith('Test Front')));
  assert.equal(outcome.result.rows.length, 12);
  assert.deepEqual(outcome.reading.withheldPages?.map((w) => w.page), [2]);
  assert.match(outcome.reading.note!, /so nothing from page 2 was imported: no people, no shifts/);
});

test('photo cross-check: a name the two readings spelled differently keeps one spelling and carries the other — never settled silently', async () => {
  const first = answer([{ p: 1, rows: 1, ppl: [person('Saffaiya Okafor', 1, ['', ''])] }]);
  const second = answer([{ p: 1, rows: 1, ppl: [person('Saffiya Okafor', 1, ['', ''])] }]);
  const outcome = await readUploadedRoster({ buffer: Buffer.from('png 5'), mimetype: 'image/png', originalname: 'r.png', size: 5 }, ctx({ provider: twoFramings(first, second) }));
  assert.ok(outcome.ok);
  assert.deepEqual(outcome.result.people?.map((p) => [p.name, p.nameAlternatives?.map((a) => a.name)]), [['Saffaiya Okafor', ['Saffiya Okafor']]]);
});

test('photo cross-check: when the second reading fails the first stands, the report says so, and nothing is cached', async () => {
  const mock = new MockVisionProvider((input: VisionInput) => {
    if (input.framing === 'columns') throw new VisionProviderError('busy', 'busy');
    return out(answer([{ p: 1, rows: 1, ppl: [person('Test Alpha', 1, ['9-17', ''])] }]));
  });
  const cache = memoryReadingCache();
  const outcome = await readUploadedRoster({ buffer: Buffer.from('png 3'), mimetype: 'image/png', originalname: 'r.png', size: 5 }, ctx({ provider: mock, cache }));
  assert.ok(outcome.ok);
  // Nothing to check the first reading against: nothing is imported, and the review says why.
  assert.deepEqual(outcome.result.people, []);
  assert.deepEqual(outcome.result.rows, []);
  assert.match(outcome.reading.note!, /^The second AI reading of this photo or scan could not be made, so it could not be checked and nothing was imported/);
  assert.equal(outcome.reading.withheldPages?.length, 1);
  assert.equal(cache.size(), 0);
});

test('photo cross-check: when the first reading fails and only the second answers, nothing is imported either', async () => {
  const mock = new MockVisionProvider((input: VisionInput) => {
    if (input.framing !== 'columns') throw new VisionProviderError('busy', 'busy');
    return out(JSON.stringify(columnsOf(answer([{ p: 1, rows: 1, ppl: [person('Test Alpha', 1, ['9-17', ''])] }]))));
  });
  const outcome = await readUploadedRoster({ buffer: Buffer.from('png 3b'), mimetype: 'image/png', originalname: 'r.png', size: 6 }, ctx({ provider: mock }));
  assert.ok(outcome.ok);
  assert.deepEqual(outcome.result.people, []);
  assert.deepEqual(outcome.result.rows, []);
  assert.ok(outcome.result.unreadRows?.some((u) => /could not be checked and nothing from it was imported/.test(u.reason)));
});

test('photo cross-check: a multi-page scan is read day by day per page, all pages at once', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const mock = new MockVisionProvider(async (input: VisionInput) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 15));
    inFlight--;
    const page = input.focus!.page;
    const a = answer([{ p: page, rows: 1, ppl: [person(`Test Page${page}`, 1, ['9-17', ''])] }]);
    return out(input.framing === 'columns' ? JSON.stringify(columnsOf(a)) : a);
  });
  const { answer: read } = await aiCrossRead({ kind: 'file', data: Buffer.from('%PDF'), mimeType: 'application/pdf', name: 's.pdf', pageCount: 2 }, { provider: mock, locationId: null, userId: null, deadline: far() });
  assert.equal(maxInFlight, 2, 'the two pages at the same time');
  assert.deepEqual(read?.pages.map((p) => `${p.p}:${p.sec[0]!.ppl[0]!.nm}`), ['1:Test Page1', '2:Test Page2']);
  assert.ok(mock.calls.every((c) => c.framing === 'columns'));
});

test('reconcileReadings: a title or row number one reader glued onto the name is folded onto the other reader\'s name, not a second person', () => {
  const ai = mapReadingAnswer(
    answer([{ p: 1, rows: 4, ppl: [person('Test Alpha', 1, ['9-17', ''], 'RM'), person('Test Beta', 2, ['', '10-18'], 'Waiter 3'), person('Test Gamma', 3, ['11-19', ''], 'Cook'), person('Test Delta', 4, ['12-20', ''])] }]),
    { today: TODAY, clientWeekStart: null },
  );
  const table = parseExcelGrid(
    [
      ['', '24-Aug', '25-Aug'],
      ['Test Alpha RM', '9-17', ''],
      ['1 Test Beta', '', '10-18'],
      ['Test Gamma Cook', '11-19', ''],
      ['Test Delta Cook', '12-20', ''],
      ['NAME TITLE', '', ''],
    ],
    TODAY,
    { today: TODAY, clientWeekStart: null },
  );
  const { result } = reconcileReadings(ai, table);
  const people = result.people!.map((p) => `${p.name}|${p.roleLabel}|${p.readerSource}|${p.nameAlternatives?.length ?? 0}`);
  assert.ok(people.includes('Test Alpha|RM|both|0'), people.join('\n'));
  assert.ok(people.includes('Test Beta|Waiter 3|both|0'));
  // A plain word counts only when the other reader read it as this person's title ("Cook" can be a surname).
  assert.ok(people.includes('Test Gamma|Cook|both|0'));
  assert.ok(people.some((p) => p.startsWith('Test Delta|') && p.includes('|ai|')));
  assert.ok(people.some((p) => p.startsWith('Test Delta Cook|')));
  assert.ok(!people.some((p) => p.startsWith('NAME TITLE')));
  assert.equal(result.rows.filter((r) => r.employeeName === 'Test Alpha').length, 1, 'one shift, read by both');
});

test('photo cross-check: a name read very differently on the same row of both readings is one person with both spellings, never two', async () => {
  const first = answer([{ p: 1, rows: 2, ppl: [person('Jo Biffai', 1, ['9-17', '']), person('Test Beta', 2, ['', '10-18'])] }]);
  const second = answer([{ p: 1, rows: 2, ppl: [person('Jo Biff', 1, ['9-17', '']), person('Test Beta', 2, ['', '10-18'])] }]);
  const outcome = await readUploadedRoster({ buffer: Buffer.from('png 6'), mimetype: 'image/png', originalname: 'r.png', size: 5 }, ctx({ provider: twoFramings(first, second) }));
  assert.ok(outcome.ok);
  assert.deepEqual(outcome.result.people?.map((p) => [p.name, p.nameAlternatives?.map((a) => a.name) ?? []]), [['Jo Biffai', ['Jo Biff']], ['Test Beta', []]]);
  assert.equal(outcome.result.rows.length, 2, 'the cells both read are written');
});

test('photo cross-check: a page the two readings disagree on too much is not trusted — nothing from it is imported, not even its people', async () => {
  const names = Array.from({ length: 6 }, (_, i) => `Test Person ${String.fromCharCode(65 + i)}`);
  // Most days read two ways; the agreed ones can't be trusted either.
  const first = answer([{ p: 1, rows: 6, ppl: names.map((n, i) => person(n, i + 1, ['10 15', i < 3 ? '18 23.5' : '9 17'])) }]);
  const second = answer([{ p: 1, rows: 6, ppl: names.map((n, i) => person(n, i + 1, ['10 15', i < 3 ? '18 23' : '9 17'])) }]);
  const outcome = await readUploadedRoster({ buffer: Buffer.from('png 7'), mimetype: 'image/png', originalname: 'r.png', size: 5 }, ctx({ provider: twoFramings(first, second) }));
  assert.ok(outcome.ok);
  assert.deepEqual(outcome.result.rows, []);
  assert.deepEqual(outcome.result.people, []);
  assert.ok(outcome.result.unreadRows?.some((u) => /disagreed on, or were unsure of, 3 of its 12 days/.test(u.reason)));
  assert.match(outcome.reading.note!, /^This photo was hard to read — the two readings disagreed on, or were unsure of, too much of it, so nothing from it was imported/);
});

test('photo reading: a row whose name could not be read ("[?]") is an unread row, never a person', async () => {
  const first = answer([{ p: 1, rows: 2, ppl: [person('Test Alpha', 1, ['9-17', '']), person('[?]', 2, ['', '10-18'])] }]);
  const outcome = await readUploadedRoster({ buffer: Buffer.from('png 8'), mimetype: 'image/png', originalname: 'r.png', size: 5 }, ctx({ provider: twoFramings(first) }));
  assert.ok(outcome.ok);
  assert.deepEqual(outcome.result.people?.map((p) => p.name), ['Test Alpha']);
  assert.ok(outcome.result.unreadRows?.some((u) => /name couldn't be read/.test(u.reason) && /10-18/.test(u.text)));
});

test('mapReadingAnswer: a name copied together with its title ("Name / Title") is split, on a page that writes them so', () => {
  const result = mapReadingAnswer(
    answer([{ p: 1, rows: 3, ppl: [person('Test Alpha / Sommelier', 1, ['9-17', '']), person('Test Beta / Commis', 2, ['', '10-18']), person('Test Gamma / Commis', 3, ['', ''])] }]),
    { today: TODAY, clientWeekStart: null },
  );
  assert.deepEqual(result.people?.map((p) => `${p.name}|${p.roleLabel}`), ['Test Alpha|Sommelier', 'Test Beta|Commis', 'Test Gamma|Commis']);
});

test("reconcileReadings: a name one reader wrote with its title after a slash is folded onto the other reader's, whatever the title", () => {
  const ai = mapReadingAnswer(answer([{ p: 1, rows: 1, ppl: [person('Test Alpha / Greeter', 1, ['9-17', ''])] }]), { today: TODAY, clientWeekStart: null });
  const table = parseExcelGrid([['', '24-Aug', '25-Aug'], ['Test Alpha', '9-17', '']], TODAY, { today: TODAY, clientWeekStart: null });
  table.people = table.people?.map((p) => ({ ...p, roleLabel: 'Greeter' }));
  const { result } = reconcileReadings(ai, table);
  assert.deepEqual(result.people?.map((p) => p.name), ['Test Alpha']);
});

test("reconcileReadings: the same times on different days on a row the table reader placed where it sits — the file's days stand; the AI's slip is counted, not flagged", () => {
  const ai = mapReadingAnswer(answer([{ p: 1, rows: 1, ppl: [person('Test Delta', 1, ['9-17', ''])] }]), { today: TODAY, clientWeekStart: null });
  const table = parseExcelGrid([['', '24-Aug', '25-Aug'], ['', 'MONDAY', 'TUESDAY'], ['Test Delta', '', '9-17']], TODAY, { today: TODAY, clientWeekStart: null });
  const { result, disagreements, aiDiffCells } = reconcileReadings(ai, table);
  assert.deepEqual(result.rows.map((r) => `${r.date} ${r.startTime} ${(r.flags ?? []).join(',')}`), ['2026-08-25 09:00 ']);
  assert.deepEqual(result.anomalies, []);
  assert.equal(disagreements, 0);
  assert.equal(aiDiffCells, 2);
});
