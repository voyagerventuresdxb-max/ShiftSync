/**
 * A footer, sign-off or form line is never a person, in every reader path — the table reader on
 * its own (no AI), the AI reader, spreadsheets and text PDFs — whatever it says, with or without
 * values beside it in the day columns, and when the text layer splits its words at a ligature
 * ("Verifi" + "ed by"). Generic shapes only: a label ending in a colon or in "by", a blank to
 * fill in, "<word>ed by", "Page x of y", text in the days below the last row with data.
 * Every name is made up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSXNS from 'xlsx';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { parseExcelGrid } from './deterministicGridParser.js';
import { mapReadingAnswer } from './aiReading.js';
import { isLabelLine, nonPersonReason } from './personKey.js';
import { parseRosterText } from './parseText.js';
import { readUploadedRoster, type UploadReadContext } from './readUpload.js';
import { memoryReadingCache } from './readingCache.js';
import type { ReadingAnswer } from './vlmPrompt.js';

const XLSX: typeof XLSXNS = ((XLSXNS as unknown as { default?: typeof XLSXNS }).default ?? XLSXNS) as typeof XLSXNS;
const TODAY = '2026-10-07';
const STAFF = ['Test Alpha', 'Test Beta', 'Test Gamma'];

/** Footer lines as rosters print them: [name-column text, text in the day columns]. */
const FOOTERS: [string, string[]][] = [
  ['Verified by: ____', ['Date: ____']],
  ['Checked by', ['', '________', '', 'Date:']],
  ['Approved by:', []],
  ['Manager on duty:', ['', '', 'Signature ..........']],
  ['Reviewed by', ['Page 1 of 1']],
  ['Printed on 13/04/2026 at 18:30', []],
  ['Updated on', ['13/04/2026']],
];

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

test('label and form lines: the generic shapes, never a real name', () => {
  for (const line of ['Verified by: ____', 'Checked by', 'Approved by:', 'Date:', 'Manager on duty:', '____________', 'Signature ..........', 'Page 2 of 3', 'Printed on 13/04', 'Reviewed by', 'Updated on 12/04']) {
    assert.ok(isLabelLine(line), line);
  }
  for (const name of ['Ahmed Saeed', 'Rasheed Al Marri', 'Ruby Okafor', 'Test Alpha', 'Dalia Bin Rashed']) {
    assert.equal(isLabelLine(name), false, name);
    assert.equal(nonPersonReason(name), null, name);
  }
  assert.ok(nonPersonReason('Checked by'));
  assert.ok(nonPersonReason('Manager on duty:'));
});

test('grid (spreadsheet or text PDF): footer lines under the roster are never people, with or without values in the days; a blank-week person in the last row still is', () => {
  const header = ['', 'Mon 13/04', 'Tue 14/04', 'Wed 15/04', 'Thu 16/04'];
  const body = [
    ['Test Alpha', '9-17', 'OFF', '', '18:30-01:00'],
    ['Test Beta', '', '10-18', 'AL', ''],
    ['Test Gamma', '', '', '', ''],
  ];
  for (const [label, days] of FOOTERS) {
    const footer = [label, ...days, ...Array(4 - days.length).fill('')];
    const result = parseExcelGrid([header, ...body, footer], TODAY, { today: TODAY, clientWeekStart: null });
    assert.deepEqual(result.people?.map((p) => p.name), STAFF, label);
    assert.equal(result.rows.length, 3, label);
  }
  // A fragment left in the name column by a ligature split, with the rest of the label in the days.
  const split = parseExcelGrid([header, ...body, ['Verifi', 'ed by: ____', '', 'Date: ____', '']], TODAY, { today: TODAY, clientWeekStart: null });
  assert.deepEqual(split.people?.map((p) => p.name), STAFF);
  // A word with a value but no label shape, alone below the roster: shown to check, never a person.
  const signOff = parseExcelGrid([header, ...body, ['Kitchen', '', 'closed', '', '']], TODAY, { today: TODAY, clientWeekStart: null });
  assert.deepEqual(signOff.people?.map((p) => p.name), STAFF);
  // A note spread across the days inside the listing is not a section heading.
  const note = parseExcelGrid([header, ['', '', 'Please arrive fifteen minutes early', '', ''], ...body], TODAY, { today: TODAY, clientWeekStart: null });
  assert.deepEqual(note.people?.map((p) => `${p.name}|${p.section ?? ''}`), STAFF.map((n) => `${n}|`));
});

test('XLSX and CSV through the upload path, table reader only: footer and sign-off lines are never people', async () => {
  const rows = [
    ['', '13-Apr', '14-Apr', '15-Apr'],
    ['', 'MONDAY', 'TUESDAY', 'WEDNESDAY'],
    ['Test Alpha', '9-17', '', '18:30-01:00'],
    ['Test Beta', 'OFF', '10-18', ''],
    ['Test Gamma', '', '', ''],
    ['Verified by', 'Date: ____', '', ''],
    ['Witnessed', 'by', '____________', ''],
    ['Officer in charge', '', 'Page 1 of 1', ''],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Rota');
  for (const [name, buffer, mimetype] of [
    ['rota.xlsx', XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['rota.csv', Buffer.from(XLSX.utils.sheet_to_csv(ws)), 'text/csv'],
  ] as const) {
    const outcome = await readUploadedRoster({ buffer, mimetype, originalname: name, size: buffer.length }, ctx());
    assert.ok(outcome.ok, name);
    if (outcome.ok) assert.deepEqual(outcome.result.people?.map((p) => p.name), STAFF, name);
  }
});

/** A text-layer PDF whose ff / fi / fl come out as separate items edge to edge (glyph-by-glyph exporters). */
async function ligaturePdf(footers: { text: string; x: number }[][]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([640, 300]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const draw = (text: string, x: number, y: number) => {
    for (const piece of text.split(/(ffi|ffl|ff|fi|fl)/).filter(Boolean)) {
      page.drawText(piece, { x, y, size: 8, font });
      x += font.widthOfTextAtSize(piece, 8);
    }
  };
  ['Mon 13/04', 'Tue 14/04', 'Wed 15/04', 'Thu 16/04'].forEach((h, d) => draw(h, 180 + d * 100 + 20, 270));
  const people: [string, string[]][] = [
    ['Test Alpha', ['9-17', 'OFF', '', '18:30-01:00']],
    ['Test Beta', ['', '10-18', 'AL', '']],
    ['Test Gamma', ['', '', '', '']],
  ];
  people.forEach(([name, cells], r) => {
    draw(name, 20, 250 - r * 14);
    cells.forEach((c, d) => c && draw(c, 180 + d * 100 + 30, 250 - r * 14));
  });
  footers.forEach((line, k) => line.forEach((f) => draw(f.text, f.x, 180 - k * 16)));
  return Buffer.from(await doc.save());
}

test('text PDF, table reader only: a sign-off line split at its ligatures ("Verifi" + "ed by: ____") is never a person, nor any other footer, with or without values beside it', async () => {
  // Each line starts near the right edge of the name column: split at its ligature, the rest of
  // the words would fall in the days and leave a name-like fragment ("Verifi", "Certifi") behind.
  const pdf = await ligaturePdf([
    [{ text: 'Verified by', x: 140 }, { text: 'Date: ____', x: 300 }],
    [{ text: 'Certified by', x: 136 }, { text: '______________', x: 310 }],
    [{ text: 'Officer in charge ......', x: 112 }],
    [{ text: 'Reviewed by', x: 20 }, { text: 'Page 1 of 1', x: 300 }],
  ]);
  const outcome = await readUploadedRoster({ buffer: pdf, mimetype: 'application/pdf', originalname: 'rota.pdf', size: pdf.length }, ctx());
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.result.people?.map((p) => p.name), STAFF);
  assert.deepEqual(outcome.result.rows.map((r) => `${r.employeeName}|${r.date}|${r.startTime}`).sort(), ['Test Alpha|2026-04-13|09:00', 'Test Alpha|2026-04-16|18:30', 'Test Beta|2026-04-14|10:00']);
});

test('AI reader: footer, form and sign-off rows it lists are set aside, never people; a blank-week person and a name ending in "-ed" are kept', () => {
  const answer: ReadingAnswer = {
    title: null,
    days: ['13-Apr MONDAY', '14-Apr TUESDAY'],
    key: [],
    pages: [{
      p: 1,
      rows: 7,
      sec: [{
        h: null,
        n: 7,
        ppl: [
          { nm: 'Ahmed Saeed', t: null, i: 1, c: ['9-17', 'OFF'] },
          { nm: 'Test Beta', t: null, i: 2, c: ['', '10-18'] },
          { nm: 'Test Gamma', t: null, i: 3, c: ['', ''] },
          { nm: 'Verified by', t: null, i: 4, c: ['Date: ____', ''] },
          { nm: 'Verifi', t: null, i: 5, c: ['ed by: ____', ''] },
          { nm: 'Signature', t: null, i: 6, c: ['__________', ''] },
          { nm: 'Duty Manager', t: null, i: 7, c: ['', 'J. Okafor'] },
        ],
      }],
      unread: [],
    }],
  };
  const result = mapReadingAnswer(answer, { today: TODAY, clientWeekStart: null });
  assert.deepEqual(result.people?.map((p) => p.name), ['Ahmed Saeed', 'Test Beta', 'Test Gamma']);
  assert.equal(result.unreadRows?.length, 4, 'each set-aside row stays visible as an unread row');
});

test('text fallback: a footer line carrying a date and a time is no one\'s shift', () => {
  const { rows } = parseRosterText('Rota 13 - 19 Apr\nMaria 6pm-2am Mon\nPrinted on Mon 13/04 at 1830-1900\n', '2026-04-13', { today: TODAY, clientWeekStart: null });
  assert.deepEqual(rows.map((r) => r.employeeName), ['Maria']);
});
