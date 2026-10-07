/**
 * A text PDF whose day columns can't be anchored on its header — a broken export that prints the
 * header row a column left of its columns, an S/N column, left-aligned header text — and a file
 * the built-in reader can't read at all. The table reader recovers the header's offset but never
 * saves a day it only inferred; the AI reader reads such a file twice, like a photo; a day is
 * saved only where two independent readers agree on it. An AI-only shift is never saved on a day
 * no second source confirms. Every name is made up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSXNS from 'xlsx';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { readUploadedRoster, type UploadReadContext } from './readUpload.js';
import { memoryReadingCache } from './readingCache.js';
import { MockVisionProvider, type VisionInput } from './visionProvider.js';
import { RosterExtractionAnomalyError } from './deterministicGridParser.js';
import type { ReadingAnswer, ReadingAnswerPerson } from './vlmPrompt.js';

const XLSX: typeof XLSXNS = ((XLSXNS as unknown as { default?: typeof XLSXNS }).default ?? XLSXNS) as typeof XLSXNS;
const TODAY = '2026-10-07';
const WEEK = ['2026-04-13', '2026-04-14', '2026-04-15', '2026-04-16', '2026-04-17', '2026-04-18', '2026-04-19'];
const HEADERS = ['Mon 13/04', 'Tue 14/04', 'Wed 15/04', 'Thu 16/04', 'Fri 17/04', 'Sat 18/04', 'Sun 19/04'];
const PEOPLE: [string, string[]][] = [
  ['Test Alpha', ['18:30-01:00', 'OFF', '09:00-17:00', '', '18:30-01:00', 'OFF', '10:00-18:00']],
  ['Test Beta', ['OFF', '18:00-02:00', 'OFF', '18:30-01:00', '', '21:00-03:00', 'OFF']],
  ['Test Gamma', ['10:00-15:00', '', '10:00-15:00', 'OFF', 'AL', '18:30-01:00', '20:00-00:00']],
  ['Test Delta', ['09:30-15:00', 'OFF', '', '18:00-02:00', 'OFF', '11:00-19:00', '18:30-01:00']],
  ['Test Epsilon', ['OFF', '20:00-00:00', '18:30-01:00', 'OFF', '09:30-15:00', 'OFF', '12:00-20:00']],
  ['Test Zeta', ['12:00-20:00', '12:00-20:00', 'OFF', '16:00-23:00', '16:00-23:00', 'OFF', '']],
];
const truth = () =>
  PEOPLE.flatMap(([name, cells]) => cells.flatMap((c, d) => (/^\d/.test(c) ? [`${name}|${WEEK[d]}|${c}`] : []))).sort();
const keys = (rows: { employeeName: string; date: string; startTime: string; endTime: string }[]) => rows.map((r) => `${r.employeeName}|${r.date}|${r.startTime}-${r.endTime}`).sort();

/** S/N | NAME | Mon … Sun, every header label printed one column to the left of its column (left-aligned). */
async function shiftedHeaderPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([900, 300]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const draw = (text: string, x: number, y: number) => page.drawText(text, { x, y, size: 8, font });
  const colLeft = [20, 50, ...WEEK.map((_, d) => 170 + d * 90)];
  ['NAME', ...HEADERS].forEach((label, k) => draw(label, colLeft[k]! + 3, 270)); // one column left of its own
  PEOPLE.forEach(([name, cells], r) => {
    const y = 250 - r * 14;
    draw(String(r + 1), colLeft[0]! + 3, y);
    draw(name, colLeft[1]! + 3, y);
    cells.forEach((c, d) => c && draw(c, colLeft[d + 2]! + 3, y));
  });
  return Buffer.from(await doc.save());
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

/** An AI reading of the week: every row as printed, except some rows slipped by some days (and extra people). */
function reading(slips: Record<string, number>, extra: ReadingAnswerPerson[] = []): ReadingAnswer {
  const slide = (cells: string[], by: number) => cells.map((_, d) => cells[d - by] ?? '');
  const ppl: ReadingAnswerPerson[] = PEOPLE.map(([nm, cells], i) => ({ nm, t: null, i: i + 1, c: slips[nm] ? slide(cells, slips[nm]!) : [...cells] }));
  return { title: null, days: HEADERS, key: [], pages: [{ p: 1, rows: ppl.length + extra.length, sec: [{ h: null, n: ppl.length + extra.length, ppl: [...ppl, ...extra] }], unread: [] }] };
}
/** The same reading in the column framing. */
function columns(a: ReadingAnswer): unknown {
  return {
    title: a.title,
    days: a.days,
    key: a.key,
    pages: a.pages.map((pg) => {
      const all = pg.sec.flatMap((s) => s.ppl);
      return { p: pg.p, rows: pg.rows, ppl: all.map((x) => ({ i: x.i, nm: x.nm, t: x.t, h: null })), cols: a.days.map((_, d) => ({ d, c: all.filter((x) => x.c[d]).map((x) => ({ i: x.i, x: x.c[d]! })) })), unread: [] };
    }),
  };
}
const twoReadings = (rows: ReadingAnswer, cols: ReadingAnswer) =>
  new MockVisionProvider((input: VisionInput) => ({ raw: input.framing === 'columns' ? JSON.stringify(columns(cols)) : JSON.stringify(rows), model: 'mock', usage: { promptTokens: 1, outputTokens: 1 } }));

test('a header printed a column left of its columns: the table reader finds everyone, but alone never saves a day it only inferred', async () => {
  const pdf = await shiftedHeaderPdf();
  const outcome = await readUploadedRoster({ buffer: pdf, mimetype: 'application/pdf', originalname: 'rota.pdf', size: pdf.length }, ctx({ aiConsent: false }));
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.result.people?.map((p) => p.name), PEOPLE.map(([n]) => n), 'the S/N column is never the names, whatever the shifted header says over it');
  assert.deepEqual(outcome.result.rows, [], 'no day saved on the header offset alone');
  // Every shift is shown to check — on the day the recovered offset gives it, which is the right one.
  const shown = outcome.result.anomalies.filter((a) => /could only be inferred/.test(a.reason)).map((a) => `${a.employeeName}|${a.date}|${a.rawText.replace('–', '-')}`).sort();
  assert.deepEqual(shown, truth());
});

test('the same file with the AI reader: read twice like a photo, but no day saved from a page whose columns could not be lined up; everyone listed', async () => {
  const pdf = await shiftedHeaderPdf();
  const ghost = { nm: 'Test Ghost', t: null, i: 7, c: ['09:00-17:00', '', '', '', '', '', ''] };
  // The row reading slips Alpha a day right and lists someone nobody else sees; the column reading slips Beta a day left.
  const provider = twoReadings(reading({ 'Test Alpha': 1 }, [ghost]), reading({ 'Test Beta': -1 }));
  const outcome = await readUploadedRoster({ buffer: pdf, mimetype: 'application/pdf', originalname: 'rota.pdf', size: pdf.length }, ctx({ provider }));
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.equal(outcome.reading.crossChecked, true, 'read twice');
  assert.deepEqual(outcome.result.rows, [], 'agreeing readings are not enough on a page whose day columns could not be lined up');
  assert.deepEqual(outcome.result.people?.map((p) => p.name), PEOPLE.map(([n]) => n), 'everyone listed');
  assert.match(outcome.reading.note ?? '', /couldn't be lined up/);
  assert.ok(!outcome.result.rows.some((r) => r.employeeName === 'Test Ghost'), 'a shift only one reading saw is never saved');
  assert.ok(!outcome.result.people?.some((p) => p.name === 'Test Ghost'));
  assert.ok(outcome.result.unreadRows?.some((u) => u.text.startsWith('Test Ghost') && /Only an AI reading listed this row/.test(u.reason)), 'shown, as a row to check');
});

test('a text PDF the built-in reader can\'t read at all (header off its columns): the AI reader reads it twice, nothing is saved from the page', async () => {
  const pdf = await shiftedHeaderPdf();
  const broken = () => {
    throw new RosterExtractionAnomalyError('test: the grid could not be read');
  };
  // The row reading misreads one of Alpha's days; the two agree on the rest (1 day in 38: the page is trusted).
  const misread = reading({});
  misread.pages[0]!.sec[0]!.ppl[0]!.c[6] = '11:00-18:00';
  const outcome = await readUploadedRoster({ buffer: pdf, mimetype: 'application/pdf', originalname: 'rota.pdf', size: pdf.length }, ctx({ provider: twoReadings(misread, reading({})), gridParser: broken as never }));
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.equal(outcome.reading.crossChecked, true);
  assert.deepEqual(outcome.result.rows, [], 'the header is off its columns: shown to check, never saved');
  assert.ok(outcome.result.anomalies.some((a) => a.employeeName === 'Test Alpha' && a.date === '2026-04-19'));
  assert.ok(outcome.result.anomalies.filter((a) => a.date).length >= truth().length, 'every day shown to check');
  // Too much read differently (a row slipped in one reading): nothing from the page, said loudly.
  const slipped = await readUploadedRoster({ buffer: pdf, mimetype: 'application/pdf', originalname: 'rota.pdf', size: pdf.length + 1 }, ctx({ provider: twoReadings(reading({ 'Test Alpha': 1, 'Test Beta': -1 }), reading({})), gridParser: broken as never }));
  assert.ok(slipped.ok);
  if (!slipped.ok) return;
  assert.deepEqual(slipped.result.rows, []);
  assert.deepEqual(slipped.reading.withheldPages?.map((w) => w.page), [1]);
});

test('a spreadsheet layout the built-in reader doesn\'t recognise is read twice by the AI reader; only what both readings agree on is saved', async () => {
  // Days as rows: not a day grid.
  const rows = [['Day', 'Test Alpha', 'Test Beta'], ['Monday 13/04', '9-17', 'OFF'], ['Tuesday 14/04', 'OFF', '10-18']];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Rota');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const first: ReadingAnswer = { title: null, days: HEADERS.slice(0, 2), key: [], pages: [{ p: 1, rows: 2, sec: [{ h: null, n: 2, ppl: [{ nm: 'Test Alpha', t: null, i: 1, c: ['9-17', 'OFF'] }, { nm: 'Test Beta', t: null, i: 2, c: ['10-18', ''] }] }], unread: [] }] };
  const second: ReadingAnswer = { ...first, pages: [{ ...first.pages[0]!, sec: [{ h: null, n: 2, ppl: [{ nm: 'Test Alpha', t: null, i: 1, c: ['9-17', 'OFF'] }, { nm: 'Test Beta', t: null, i: 2, c: ['OFF', '10-18'] }] }] }] };
  const provider = twoReadings(first, second);
  const outcome = await readUploadedRoster({ buffer, mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', originalname: 'r.xlsx', size: buffer.length }, ctx({ provider }));
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.ok(provider.calls.some((c) => c.framing === 'columns' && c.kind === 'grid'), 'the grid is read a second time, column by column');
  assert.deepEqual(keys(outcome.result.rows), ['Test Alpha|2026-04-13|09:00-17:00'], "Beta's Monday: the two readings disagree, so it isn't saved");
});
