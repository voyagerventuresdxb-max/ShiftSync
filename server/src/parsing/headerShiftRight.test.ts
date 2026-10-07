/**
 * A day header shifted RIGHT of its columns (the last label hanging past the grid) by one or two
 * days, or by half a day (two AM | PM sub-columns), and footer fragments split at their ligatures
 * on the table-reader-only path. A day the table reader can't anchor is never saved on its own;
 * a footer is never a person. Every name is made up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import { readUploadedRoster, type UploadReadContext } from './readUpload.js';
import { memoryReadingCache } from './readingCache.js';
import { MockVisionProvider, type VisionInput } from './visionProvider.js';
import type { ReadingAnswer } from './vlmPrompt.js';

const TODAY = '2026-10-07';
const WEEK = ['2026-04-13', '2026-04-14', '2026-04-15', '2026-04-16', '2026-04-17', '2026-04-18', '2026-04-19'];
const DATES = ['13-Apr', '14-Apr', '15-Apr', '16-Apr', '17-Apr', '18-Apr', '19-Apr'];
const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];

function ctx(over: Partial<UploadReadContext> = {}): UploadReadContext {
  return {
    locationId: null,
    userId: null,
    today: TODAY,
    clientWeekStart: null,
    aiConsent: false,
    provider: null,
    aiBlockedReason: async () => null,
    markAiUsed: async () => {},
    cache: memoryReadingCache(),
    deadline: Date.now() + 60_000,
    ...over,
  };
}
const keys = (rows: { employeeName: string; date: string; startTime: string; endTime: string }[]) => rows.map((r) => `${r.employeeName}|${r.date}|${r.startTime}-${r.endTime}`).sort();
const centred = (page: PDFPage, font: PDFFont, text: string, left: number, width: number, y: number) =>
  page.drawText(text, { x: left + (width - font.widthOfTextAtSize(text, 8)) / 2, y, size: 8, font });

/** Decimal AM | PM sub-cells (start, end, start, end) per day, header shifted right by `shift` sub-columns. */
const SUBS: [string, string[][]][] = [
  ['Test Alpha', [['11', '17', '18', '25'], [], ['', '', '18', '26'], ['10', '16', '', ''], [], ['11', '17', '18', '25'], []]],
  ['Test Beta', [[], ['', '', '18', '26'], ['11', '17', '18', '25'], [], ['10', '16', '', ''], [], ['', '', '18.5', '26']]],
  ['Test Gamma', [['10', '16', '', ''], ['11', '17', '18', '25'], [], ['', '', '18', '25'], ['11', '17', '18', '25'], [], []]],
  ['Test Delta', [['', '', '18', '26'], [], ['10', '16', '', ''], ['11', '17', '18', '25'], [], ['', '', '18.5', '26'], ['10', '16', '', '']]],
];
async function subCellPdf(shift: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([1100, 260]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sub = 30;
  const dayLeft = (d: number) => 160 + d * 4 * sub;
  DATES.forEach((t, d) => centred(page, font, t, dayLeft(d) + shift * sub, 4 * sub, 240));
  DAYS.forEach((t, d) => centred(page, font, t, dayLeft(d) + shift * sub, 4 * sub, 228));
  WEEK.forEach((_, d) => {
    centred(page, font, 'AM', dayLeft(d) + shift * sub, 2 * sub, 216);
    centred(page, font, 'PM', dayLeft(d) + (2 + shift) * sub, 2 * sub, 216);
  });
  SUBS.forEach(([name, days], r) => {
    const y = 200 - r * 14;
    page.drawText(name, { x: 20, y, size: 8, font });
    days.forEach((cells, d) => cells.forEach((c, k) => c && centred(page, font, c, dayLeft(d) + k * sub, sub, y)));
  });
  return Buffer.from(await doc.save());
}
const decimal = (h: string) => {
  const m = Math.round(Number(h) * 60) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const subTruth = () =>
  SUBS.flatMap(([name, days]) =>
    days.flatMap((cells, d) => [[cells[0], cells[1]], [cells[2], cells[3]]].filter(([a, b]) => a && b).map(([a, b]) => `${name}|${WEEK[d]}|${decimal(a!)}-${decimal(b!)}`)),
  ).sort();

/** No. | NAME | POSITION | Mon … Sun with the day header shifted right by `shift` whole day columns. */
const CLOCK: [string, string, string[]][] = [
  ['Test Alpha', 'Waiter 1', ['18:30-01:00', 'OFF', '09:00-17:00', '', '18:30-01:00', 'OFF', '10:00-18:00']],
  ['Test Beta', 'Waiter 2', ['OFF', '18:00-02:00', 'OFF', '18:30-01:00', '', '21:00-03:00', 'OFF']],
  ['Test Gamma', 'Runner 1', ['10:00-15:00', '', '10:00-15:00', 'OFF', 'AL', '18:30-01:00', '20:00-00:00']],
  ['Test Delta', 'Runner 2', ['09:30-15:00', 'OFF', '', '18:00-02:00', 'OFF', '11:00-19:00', '18:30-01:00']],
];
async function clockPdf(shift: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([1300, 260]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const day = 100;
  const dayLeft = (d: number) => 230 + d * day;
  WEEK.forEach((_, d) => {
    page.drawText(`${DAYS[d]!.slice(0, 3)} ${WEEK[d]!.slice(8)}/04`, { x: dayLeft(d + shift) + 3, y: 240, size: 8, font });
  });
  CLOCK.forEach(([name, title, cells], r) => {
    const y = 220 - r * 14;
    page.drawText(String(r + 1), { x: 20, y, size: 8, font });
    page.drawText(name, { x: 45, y, size: 8, font });
    page.drawText(title, { x: 150, y, size: 8, font });
    cells.forEach((c, d) => c && page.drawText(c, { x: dayLeft(d) + 3, y, size: 8, font }));
  });
  return Buffer.from(await doc.save());
}
const clockTruth = () => CLOCK.flatMap(([name, , cells]) => cells.flatMap((c, d) => (/^\d/.test(c) ? [`${name}|${WEEK[d]}|${c}`] : []))).sort();

test('a header shifted half a day either way (two AM | PM sub-columns): never a day saved off by half', async () => {
  for (const shift of [2, -2]) {
    const pdf = await subCellPdf(shift);
    const outcome = await readUploadedRoster({ buffer: pdf, mimetype: 'application/pdf', originalname: 'rota.pdf', size: pdf.length }, ctx());
    assert.ok(outcome.ok, `shift ${shift}`);
    if (!outcome.ok) continue;
    assert.deepEqual(outcome.result.people?.map((p) => p.name), SUBS.map(([n]) => n), `shift ${shift}`);
    const saved = keys(outcome.result.rows);
    assert.ok(saved.every((k) => subTruth().includes(k)), `shift ${shift}: nothing saved on a wrong day (${saved.filter((k) => !subTruth().includes(k)).join(', ')})`);
    // Each day either saved on its own day or shown to check — never a wrong one (checked above).
    const shown = outcome.result.anomalies.filter((a) => a.date).length;
    assert.ok(saved.length + shown >= subTruth().length, `shift ${shift}: every day saved or shown (${saved.length} saved, ${shown} shown)`);
  }
});

test('a header shifted one or two days right (the last label past the grid; No. and position columns): never a day saved off', async () => {
  for (const shift of [1, 2]) {
    const pdf = await clockPdf(shift);
    const outcome = await readUploadedRoster({ buffer: pdf, mimetype: 'application/pdf', originalname: 'rota.pdf', size: pdf.length }, ctx());
    assert.ok(outcome.ok, `shift ${shift}`);
    if (!outcome.ok) continue;
    assert.deepEqual(outcome.result.people?.map((p) => p.name), CLOCK.map(([n]) => n), `shift ${shift}`);
    assert.deepEqual(outcome.result.rows, [], `shift ${shift}: shown to check, never saved on the shifted header alone`);
    // Read twice by the AI reader as well: a day two readers agree on is saved — on its own day.
    const answer: ReadingAnswer = {
      title: null,
      days: WEEK.map((_, d) => `${DAYS[d]!.slice(0, 3)} ${WEEK[d]!.slice(8)}/04`),
      key: [],
      pages: [{ p: 1, rows: CLOCK.length, sec: [{ h: null, n: CLOCK.length, ppl: CLOCK.map(([nm, t, c], i) => ({ nm, t, i: i + 1, c: [...c] })) }], unread: [] }],
    };
    const columns = {
      title: null,
      days: answer.days,
      key: [],
      pages: [{ p: 1, rows: CLOCK.length, ppl: CLOCK.map(([nm, t], i) => ({ i: i + 1, nm, t, h: null })), cols: answer.days.map((_, d) => ({ d, c: CLOCK.map(([, , c], i) => ({ i: i + 1, x: c[d]! })).filter((x) => x.x) })), unread: [] }],
    };
    const provider = new MockVisionProvider((input: VisionInput) => ({ raw: JSON.stringify(input.framing === 'columns' ? columns : answer), model: 'mock', usage: { promptTokens: 1, outputTokens: 1 } }));
    const read = await readUploadedRoster({ buffer: pdf, mimetype: 'application/pdf', originalname: 'rota.pdf', size: pdf.length + shift }, ctx({ aiConsent: true, provider }));
    assert.ok(read.ok);
    if (read.ok) assert.deepEqual(keys(read.result.rows), clockTruth(), `shift ${shift}: every day where two readers agree, on its own day`);
  }
});

test('table reader only: footer lines split at their ligatures ("Offi cial copy – for sta ff only", "Final version (fl uid – check daily)") are never people', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([900, 260]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const draw = (text: string, x: number, y: number) => {
    // Pieces a hair apart: the text layer puts spaces between them.
    for (const piece of text.split(/(ffi|ffl|ff|fi|fl)/).filter(Boolean)) {
      page.drawText(piece, { x, y, size: 8, font });
      x += font.widthOfTextAtSize(piece, 8) + (/^(ffi|ffl|ff|fi|fl)$/.test(piece) ? 1.6 : 0);
    }
  };
  WEEK.forEach((_, d) => draw(`${DAYS[d]!.slice(0, 3)} ${WEEK[d]!.slice(8)}/04`, 230 + d * 100 + 3, 240));
  CLOCK.forEach(([name, title, cells], r) => {
    const y = 220 - r * 14;
    draw(String(r + 1), 20, y);
    draw(name, 45, y);
    draw(title, 150, y);
    cells.forEach((c, d) => c && draw(c, 230 + d * 100 + 3, y));
  });
  draw('Official copy – for staff only', 45, 140);
  draw('Final version (fluid – check daily)', 150, 126);
  draw('Official copy', 20, 112);
  draw('for staff only', 233, 112);
  const pdf = Buffer.from(await doc.save());
  const outcome = await readUploadedRoster({ buffer: pdf, mimetype: 'application/pdf', originalname: 'rota.pdf', size: pdf.length }, ctx());
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.result.people?.map((p) => p.name), CLOCK.map(([n]) => n));
  assert.deepEqual(keys(outcome.result.rows), clockTruth());
});
