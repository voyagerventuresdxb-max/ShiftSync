/**
 * Day header shifted a whole day or two (right or left) over four AM | PM decimal sub-columns per
 * day, with a "No." or "Position" column before the names and section banners: the columns can't
 * be lined up with certainty, so no shift is saved — on the table-reader path and the AI path.
 * Every name is made up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import { readUploadedRoster, type UploadReadContext } from './readUpload.js';
import { memoryReadingCache } from './readingCache.js';
import { MockVisionProvider, type VisionInput } from './visionProvider.js';
import type { ReadingAnswer } from './vlmPrompt.js';

const WEEK = ['2026-04-13', '2026-04-14', '2026-04-15', '2026-04-16', '2026-04-17', '2026-04-18', '2026-04-19'];
const DATES = ['13-Apr-2026', '14-Apr-2026', '15-Apr-2026', '16-Apr-2026', '17-Apr-2026', '18-Apr-2026', '19-Apr-2026'];
const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
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
const centred = (page: PDFPage, font: PDFFont, text: string, left: number, width: number, y: number) =>
  page.drawText(text, { x: left + (width - font.widthOfTextAtSize(text, 8)) / 2, y, size: 8, font });

type Person = [string, string, string[][]];
const PEOPLE: (Person | string)[] = [
  'MANAGEMENT',
  ['Test Orrin', 'Manager', [['9', '13.5', '17', '23'], ['11', '15', '', ''], [], ['10.5', '15', '18.5', '25'], ['9', '13.5', '', ''], [], ['', '', '17', '20.5']]],
  ['Test Pallas', 'Manager', [['10', '14', '16.5', '23'], ['', '', '18', '24'], ['9', '13.5', '', ''], [], [], ['10', '14', '16.5', '23'], ['10', '14', '', '']]],
  'SERVERS',
  ['Test Quill', 'Server', [['11', '15', '18', '24'], ['10', '14', '', ''], [], [], ['', '', '16', '18'], ['', '', '19.5', '28'], ['10', '14', '', '']]],
  ['Test Rowan', 'Server', [[], ['7.5', '12.5', '', ''], ['', '', '16.5', '19'], [], [], ['9', '13.5', '17', '23'], ['10.5', '15', '', '']]],
  ['Test Sable', 'Server', [[], [], [], [], [], [], []]],
  ['Test Tamsin', 'Server', [['', '', '18.5', '26'], ['11', '15', '', ''], [], ['', '', '17', '20.5'], ['7.5', '12.5', '', ''], ['11', '15', '', ''], []]],
];

/** lead: the column before the names; shift: the header moved by that many whole days (right +, left −). */
async function rosterPdf(lead: 'no' | 'position', shift: number, aligned: 'centre' | 'left' = 'centre'): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([1500, 300]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sub = 30;
  const dayLeft = (d: number) => 330 + d * 4 * sub;
  page.drawText(lead === 'no' ? 'No.' : 'Position', { x: 20, y: 268, size: 8, font });
  page.drawText('Name', { x: 110, y: 268, size: 8, font });
  // Centred, or (a common export) day headings left-aligned over right-aligned sub-cells.
  const head = (text: string, left: number, width: number, y: number) => (aligned === 'left' ? page.drawText(text, { x: left + 2, y, size: 8, font }) : centred(page, font, text, left, width, y));
  const cell = (text: string, left: number, y: number) => (aligned === 'left' ? page.drawText(text, { x: left + sub - 2 - font.widthOfTextAtSize(text, 8), y, size: 8, font }) : centred(page, font, text, left, sub, y));
  WEEK.forEach((_, d) => {
    head(DATES[d]!, dayLeft(d + shift), 4 * sub, 268);
    head(DAYS[d]!, dayLeft(d + shift), 4 * sub, 256);
    head('AM', dayLeft(d + shift), 2 * sub, 244);
    head('PM', dayLeft(d + shift) + 2 * sub, 2 * sub, 244);
  });
  let y = 230;
  let n = 0;
  for (const p of PEOPLE) {
    if (typeof p === 'string') {
      page.drawText(p, { x: 20, y, size: 8, font });
    } else {
      n++;
      page.drawText(lead === 'no' ? String(n) : p[1], { x: 20, y, size: 8, font });
      page.drawText(p[0], { x: 110, y, size: 8, font });
      p[2].forEach((cells, d) => cells.forEach((c, k) => c && cell(c, dayLeft(d) + k * sub, y)));
    }
    y -= 14;
  }
  return Buffer.from(await doc.save());
}

const people = () => PEOPLE.filter((p): p is Person => typeof p !== 'string').map((p) => p[0]);

test('a header shifted a whole day or two either way over AM | PM sub-columns, No. or Position column: no shift saved, everyone listed, every day shown', async () => {
  const failed: string[] = [];
  for (const [lead, aligned] of [['no', 'centre'], ['position', 'centre'], ['no', 'left'], ['position', 'left']] as const) {
    for (const shift of [1, 2, -1, -2]) {
      const pdf = await rosterPdf(lead, shift, aligned);
      const outcome = await readUploadedRoster({ buffer: pdf, mimetype: 'application/pdf', originalname: 'rota.pdf', size: pdf.length }, ctx());
      const at = `${lead} ${aligned} ${shift}`;
      assert.ok(outcome.ok, at);
      if (!outcome.ok) continue;
      if (outcome.result.rows.length) failed.push(`${at}: ${outcome.result.rows.length} saved`);
      if (JSON.stringify(outcome.result.people?.map((p) => p.name)) !== JSON.stringify(people())) failed.push(`${at}: listed ${outcome.result.people?.map((p) => p.name).join(', ')}; unread ${outcome.result.unreadRows?.map((u) => u.text + ' / ' + u.reason.slice(0, 60)).join(' ; ')}`);
      if (!/couldn't be lined up/.test(outcome.reading.note ?? '')) failed.push(`${at}: no note`);
    }
  }
  assert.deepEqual(failed, []);
});

test('the same layout with the header over its own columns is read and saved as usual', async () => {
  for (const [lead, aligned] of [['no', 'centre'], ['position', 'centre'], ['no', 'left'], ['position', 'left']] as const) {
    const pdf = await rosterPdf(lead, 0, aligned);
    const outcome = await readUploadedRoster({ buffer: pdf, mimetype: 'application/pdf', originalname: 'rota.pdf', size: pdf.length }, ctx());
    assert.ok(outcome.ok);
    if (!outcome.ok) continue;
    assert.deepEqual(outcome.result.people?.map((p) => p.name), people(), `${lead} ${aligned}`);
    assert.ok(outcome.result.rows.length >= 30, `${lead} ${aligned}: ${outcome.result.rows.length} saved`);
    assert.doesNotMatch(outcome.reading.note ?? '', /couldn't be lined up/);
  }
});

test('the AI path: two AI readings agreeing on every day still save nothing from a page whose header is off its columns', async () => {
  const persons = PEOPLE.filter((p): p is Person => typeof p !== 'string');
  const days = DATES.map((d, i) => `${DAYS[i]} ${d}`);
  const cellsOf = (p: Person) => p[2].map((c) => [[c[0], c[1]], [c[2], c[3]]].filter(([a, b]) => a && b).map(([a, b]) => `${a}-${b}`).join(' / '));
  const rowsAnswer: ReadingAnswer = { title: null, days, key: [], pages: [{ p: 1, rows: persons.length, sec: [{ h: null, n: persons.length, ppl: persons.map((p, i) => ({ nm: p[0], t: p[1], i: i + 1, c: cellsOf(p) })) }], unread: [] }] };
  const columns = { title: null, days, key: [], pages: [{ p: 1, rows: persons.length, ppl: persons.map((p, i) => ({ i: i + 1, nm: p[0], t: p[1], h: null })), cols: days.map((_, d) => ({ d, c: persons.map((p, i) => ({ i: i + 1, x: cellsOf(p)[d]! })).filter((x) => x.x) })), unread: [] }] };
  for (const [lead, shift] of [['no', 1], ['position', -1], ['no', 2], ['position', -2]] as const) {
    const provider = new MockVisionProvider((input: VisionInput) => ({ raw: JSON.stringify(input.framing === 'columns' ? columns : rowsAnswer), model: 'mock', usage: { promptTokens: 1, outputTokens: 1 } }));
    const pdf = await rosterPdf(lead, shift, 'left');
    const outcome = await readUploadedRoster({ buffer: pdf, mimetype: 'application/pdf', originalname: 'rota.pdf', size: pdf.length }, ctx({ aiConsent: true, provider }));
    assert.ok(outcome.ok);
    if (!outcome.ok) continue;
    assert.deepEqual(outcome.result.rows, [], `${lead} ${shift}`);
    assert.deepEqual(outcome.result.people?.map((p) => p.name), people(), `${lead} ${shift}`);
    assert.match(outcome.reading.note ?? '', /couldn't be lined up/);
  }
});
