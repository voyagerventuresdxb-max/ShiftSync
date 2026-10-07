/**
 * A name typed all in lower case is a person when its row has shifts like the other rows (shown
 * title-cased); a lower-case footer or note line with nothing in its days never is. Both readers.
 * Every name is made up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { readUploadedRoster, type UploadReadContext } from './readUpload.js';
import { memoryReadingCache } from './readingCache.js';
import { MockVisionProvider, type VisionInput } from './visionProvider.js';
import type { ReadingAnswer } from './vlmPrompt.js';
import { lowercaseName } from './personKey.js';

const WEEK = ['2026-04-13', '2026-04-14', '2026-04-15', '2026-04-16', '2026-04-17', '2026-04-18', '2026-04-19'];
const HEADERS = ['Mon 13/04', 'Tue 14/04', 'Wed 15/04', 'Thu 16/04', 'Fri 17/04', 'Sat 18/04', 'Sun 19/04'];
const ROWS: [string, string[]][] = [
  ['Test Alpha', ['18:30-01:00', 'OFF', '09:00-17:00', '', '18:30-01:00', 'OFF', '10:00-18:00']],
  ['ilsa brennick', ['OFF', '18:00-02:00', 'OFF', '18:30-01:00', '', '21:00-03:00', 'OFF']],
  ['Test Gamma', ['10:00-15:00', '', '10:00-15:00', 'OFF', 'AL', '18:30-01:00', '20:00-00:00']],
  ['jo-anne quarrel', ['09:30-15:00', 'OFF', '', '18:00-02:00', 'OFF', '11:00-19:00', '18:30-01:00']],
  ['pell marrow', ['OFF', 'OFF', 'AL', 'AL', 'OFF', 'OFF', 'OFF']],
];
const FOOTERS = ['kitchen closes early', 'please return keys to the office'];
const ctx = (over: Partial<UploadReadContext> = {}): UploadReadContext => ({
  locationId: null,
  userId: null,
  today: '2026-10-07',
  clientWeekStart: null,
  aiConsent: false,
  provider: null,
  aiBlockedReason: async () => null,
  markAiUsed: async () => {},
  cache: memoryReadingCache(),
  deadline: Date.now() + 60_000,
  ...over,
});
const title = (n: string) => lowercaseName(n) ?? n;
const truth = () => ROWS.flatMap(([n, cells]) => cells.flatMap((c, d) => (/^\d/.test(c) ? [`${title(n)}|${WEEK[d]}|${c}`] : []))).sort();
const keys = (rows: { employeeName: string; date: string; startTime: string; endTime: string }[]) => rows.map((r) => `${r.employeeName}|${r.date}|${r.startTime}-${r.endTime}`).sort();

test('lowercaseName: 1–4 words of letters, no label or footer word; title-cased', () => {
  assert.equal(lowercaseName('ilsa brennick'), 'Ilsa Brennick');
  assert.equal(lowercaseName('jo-anne quarrel'), 'Jo-Anne Quarrel');
  assert.equal(lowercaseName("tavi o'brannagh"), "Tavi O'Brannagh");
  assert.equal(lowercaseName('noor van der hoek'), 'Noor van der Hoek');
  for (const label of ['total', 'approved by', 'signature', 'manager', 'for staff only', 'final copy', 'legend', 'prepared by', 'please see notes', 'Ilsa Brennick', 'ilsa brennick 2', 'one two three four five', 'bar']) {
    assert.equal(lowercaseName(label), null, label);
  }
});

test('table reader: a lower-case name with shifts, or only OFF and leave, is a person (title-cased); a lower-case line with nothing in its days is not', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([900, 260]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('NAME', { x: 23, y: 240, size: 8, font });
  HEADERS.forEach((h, d) => page.drawText(h, { x: 170 + d * 90 + 3, y: 240, size: 8, font }));
  ROWS.forEach(([name, cells], r) => {
    const y = 220 - r * 14;
    page.drawText(name, { x: 23, y, size: 8, font });
    cells.forEach((c, d) => c && page.drawText(c, { x: 170 + d * 90 + 3, y, size: 8, font }));
  });
  FOOTERS.forEach((f, i) => page.drawText(f, { x: 23, y: 150 - i * 14, size: 8, font }));
  const pdf = Buffer.from(await doc.save());
  const outcome = await readUploadedRoster({ buffer: pdf, mimetype: 'application/pdf', originalname: 'rota.pdf', size: pdf.length }, ctx());
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.result.people?.map((p) => p.name), ROWS.map(([n]) => title(n)), 'the lower-case person with only OFF and leave is listed too');
  assert.deepEqual(keys(outcome.result.rows), truth());
  assert.ok(!(outcome.result.unreadRows ?? []).some((u) => FOOTERS.some((f) => u.text.includes(f))), 'a footer with empty days is not an unread row');
});

test('AI reader: a lower-case name with shifts, or only OFF and leave, is a person (title-cased); a lower-case line with nothing in its days is not', async () => {
  const ppl = [...ROWS.map(([nm, c], i) => ({ nm, t: null, i: i + 1, c: [...c] })), ...FOOTERS.map((nm, k) => ({ nm, t: null, i: ROWS.length + k + 1, c: ['', '', '', '', '', '', ''] }))];
  const answer: ReadingAnswer = { title: null, days: HEADERS, key: [], pages: [{ p: 1, rows: ppl.length, sec: [{ h: null, n: ppl.length, ppl }], unread: [] }] };
  const columns = { title: null, days: HEADERS, key: [], pages: [{ p: 1, rows: ppl.length, ppl: ppl.map((x) => ({ i: x.i, nm: x.nm, t: x.t, h: null })), cols: HEADERS.map((_, d) => ({ d, c: ppl.filter((x) => x.c[d]).map((x) => ({ i: x.i, x: x.c[d]! })) })), unread: [] }] };
  const provider = new MockVisionProvider((input: VisionInput) => ({ raw: JSON.stringify(input.framing === 'columns' ? columns : answer), model: 'mock', usage: { promptTokens: 1, outputTokens: 1 } }));
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const outcome = await readUploadedRoster({ buffer: png, mimetype: 'image/png', originalname: 'rota.png', size: png.length }, ctx({ aiConsent: true, provider }));
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.result.people?.map((p) => p.name), ROWS.map(([n]) => title(n)));
  assert.deepEqual(keys(outcome.result.rows), truth());
});
