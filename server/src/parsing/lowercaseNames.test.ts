/**
 * A name typed all in lower case is a person when its row has shifts like the other rows (shown
 * title-cased); a lower-case footer or note line with nothing in its days never is. Both readers.
 * Every name is made up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
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

test('AM | PM sub-columns, a legend and section banners: a lower-case person whose week is all leave words (Sick, Holiday, Request, PH) is listed, title-cased, with no shifts', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([1300, 300]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const draw = (text: string, x: number, y: number) => page.drawText(text, { x, y, size: 8, font });
  const sub = 30;
  const dayLeft = (d: number) => 200 + d * 4 * sub;
  HEADERS.forEach((h, d) => {
    draw(h, dayLeft(d) + 40, 270);
    draw('AM', dayLeft(d) + 20, 258);
    draw('PM', dayLeft(d) + 80, 258);
  });
  const rows: (string | [string, string[][]])[] = [
    'SERVERS',
    ['Test Orrin', [['9', '13.5', '17', '23'], [], ['11', '15', '', ''], [], ['', '', '18', '24'], [], ['10', '14', '', '']]],
    ['wren calloway', [['Sick'], ['Sick'], ['Holiday'], ['Holiday'], ['Request'], ['PH'], ['Request']]],
    'RUNNERS',
    ['Test Pallas', [[], ['10', '14', '17', '23'], [], ['9', '13.5', '', ''], [], ['', '', '18', '24'], []]],
    ['tobin ashgrove', [['Holiday'], ['Holiday'], ['PH'], ['Sick'], ['Sick'], ['Request'], ['Request']]],
    ['Test Quill', [['OFF'], ['OFF'], ['OFF'], ['OFF'], ['OFF'], ['OFF'], ['OFF']]],
  ];
  let y = 244;
  for (const row of rows) {
    if (typeof row === 'string') draw(row, 20, y);
    else {
      draw(row[0], 20, y);
      row[1].forEach((cells, d) => cells.forEach((c, k) => c && draw(c, dayLeft(d) + k * sub + 4, y)));
    }
    y -= 14;
  }
  draw('LEGEND: Sick = sick leave   Holiday = annual leave   Request = day off requested   PH = public holiday', 20, y - 10);
  draw('kitchen closes early', 20, y - 24);
  const pdf = Buffer.from(await doc.save());
  const outcome = await readUploadedRoster({ buffer: pdf, mimetype: 'application/pdf', originalname: 'rota.pdf', size: pdf.length }, ctx());
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  const names = outcome.result.people?.map((p) => p.name) ?? [];
  assert.ok(names.includes('Wren Calloway') && names.includes('Tobin Ashgrove'), names.join(', '));
  assert.ok(!outcome.result.rows.some((r) => r.employeeName === 'Wren Calloway' || r.employeeName === 'Tobin Ashgrove'), 'no shifts');
  assert.ok(!names.some((n) => /kitchen/i.test(n)));
  assert.ok(!(outcome.result.unreadRows ?? []).some((u) => /kitchen/.test(u.text)));
});

test('AM | PM sub-columns with colour-only leave (Holiday, OFF: a fill, no text), a colour key and a footer: a lower-case person with no shifts is listed like a title-case one', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([1400, 360]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const draw = (text: string, x: number, y: number) => page.drawText(text, { x, y, size: 8, font });
  const sub = 30;
  const dayLeft = (d: number) => 170 + d * 4 * sub;
  const HOLIDAY = rgb(0.6, 0.8, 0.4);
  const OFF = rgb(1, 1, 0.3);
  const fill = (d: number, y: number, colour: ReturnType<typeof rgb>) => page.drawRectangle({ x: dayLeft(d), y: y - 3, width: 4 * sub, height: 12, color: colour });
  ['13-Apr', '14-Apr', '15-Apr', '16-Apr', '17-Apr', '18-Apr', '19-Apr'].forEach((t, d) => draw(t, dayLeft(d) + 45, 340));
  ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'].forEach((t, d) => draw(t, dayLeft(d) + 40, 328));
  WEEK.forEach((_, d) => {
    draw('AM', dayLeft(d) + 22, 316);
    draw('PM', dayLeft(d) + 82, 316);
  });
  draw('COVERS', 60, 304);
  type Row = [string, (string[] | 'H' | 'O')[]];
  const groups: [string, Row[]][] = [
    ['SERVERS', [
      ['Test Orrin', [['9', '13.5', '17', '23'], 'O', ['11', '15', '', ''], 'O', ['', '', '18', '24'], 'H', ['10', '14', '', '']]],
      ['wren calloway', ['H', 'H', 'O', 'H', 'H', 'O', 'O']],
      ['Test Pallas', ['O', ['10', '14', '17', '23'], 'O', ['9', '13.5', '', ''], 'O', ['', '', '18', '24'], 'O']],
      ['Test Sable', ['H', 'H', 'H', 'O', 'O', 'H', 'H']],
    ]],
    ['BAR', [
      ['Test Quill', [['', '', '18', '26'], 'O', ['', '', '18', '26'], 'O', 'O', ['', '', '18', '26'], ['', '', '17', '25']]],
      ['Test Tamsin', ['O', 'H', 'H', 'H', 'H', 'O', 'O']],
      ['tobin ashgrove', ['O', 'O', 'H', 'H', 'H', 'H', 'O']],
    ]],
  ];
  let y = 290;
  for (const [banner, rows] of groups) {
    page.drawRectangle({ x: 170, y: y - 3, width: 28 * sub, height: 12, color: rgb(0.66, 0.77, 0.92) });
    draw(banner, 170 + 14 * sub - 15, y);
    y -= 14;
    for (const [name, days] of rows) {
      draw(name, 30, y);
      days.forEach((c, d) => (c === 'H' ? fill(d, y, HOLIDAY) : c === 'O' ? fill(d, y, OFF) : c.forEach((t, k) => t && draw(t, dayLeft(d) + k * sub + 8, y))));
      y -= 14;
    }
    // The group's headcount: how many in it, and how many work each half-day.
    draw(String(rows.length), 75, y);
    WEEK.forEach((_, d) => {
      const am = rows.filter(([, days]) => Array.isArray(days[d]) && (days[d] as string[])[0]).length;
      const pm = rows.filter(([, days]) => Array.isArray(days[d]) && (days[d] as string[])[2]).length;
      draw(String(am), dayLeft(d) + 25, y);
      draw(String(pm), dayLeft(d) + 85, y);
    });
    y -= 14;
  }
  // The colour key, to the right of the grid.
  page.drawRectangle({ x: 1050, y: 301, width: 20, height: 10, color: HOLIDAY });
  draw('Holiday', 1075, 304);
  page.drawRectangle({ x: 1050, y: 287, width: 20, height: 10, color: OFF });
  draw('OFF', 1075, 290);
  draw('Prepared by: Duty Manager    Printed 13-Apr    Page 1 of 1', 30, y - 10);
  draw('kitchen closes early', 30, y - 24);
  const pdf = Buffer.from(await doc.save());
  const outcome = await readUploadedRoster({ buffer: pdf, mimetype: 'application/pdf', originalname: 'rota.pdf', size: pdf.length }, ctx());
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  const names = outcome.result.people?.map((p) => p.name) ?? [];
  assert.deepEqual(names, ['Test Orrin', 'Wren Calloway', 'Test Pallas', 'Test Sable', 'Test Quill', 'Test Tamsin', 'Tobin Ashgrove']);
  assert.ok(!outcome.result.rows.some((r) => r.employeeName === 'Wren Calloway' || r.employeeName === 'Tobin Ashgrove'), 'no shifts');
  assert.ok(!(outcome.result.unreadRows ?? []).some((u) => /kitchen/.test(u.text)), 'the footer is not an unread row');
});
