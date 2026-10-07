/**
 * Office, internal and final-copy lines, and rows of column labels, are never people — in every
 * reader and in any column order — and an ID or row-number column is never the names. Words a
 * text layer splits at a ligature ("O ffi ce", "fi nal") are read whole before anything is
 * classified. Every name is made up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSXNS from 'xlsx';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { parseExcelGrid } from './deterministicGridParser.js';
import { mapReadingAnswer } from './aiReading.js';
import { isLabelLine, joinLigatureSplits, nonPersonReason } from './personKey.js';
import { readUploadedRoster, type UploadReadContext } from './readUpload.js';
import { memoryReadingCache } from './readingCache.js';
import type { ReadingAnswer } from './vlmPrompt.js';

const XLSX: typeof XLSXNS = ((XLSXNS as unknown as { default?: typeof XLSXNS }).default ?? XLSXNS) as typeof XLSXNS;
const TODAY = '2026-10-07';
const STAFF = ['Test Alpha', 'Test Beta', 'Test Gamma'];

function ctx(): UploadReadContext {
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
  };
}

test('a word a text layer split at a ligature is read whole before anything is classified; two real words are never run together', () => {
  assert.equal(joinLigatureSplits('O ffi ce use only - fi nal copy'), 'Office use only - final copy');
  assert.equal(joinLigatureSplits('Veri fi ed by'), 'Verified by');
  assert.equal(joinLigatureSplits('Sa ffi ya Okonkwo'), 'Saffiya Okonkwo');
  assert.equal(joinLigatureSplits('Ca st le Rota'), 'Castle Rota');
  assert.equal(joinLigatureSplits('Ana Stewart'), 'Ana Stewart');
  assert.equal(joinLigatureSplits('St John Okafor'), 'St John Okafor');
  for (const line of ['O ffi ce use only - fi nal copy', 'Office use only', 'Final copy', 'Internal - do not distribute', 'Con fi dential', 'Remarks', 'Approved']) {
    assert.ok(isLabelLine(line), line);
  }
  for (const label of ['Payroll ID', 'Emp No.', 'Employee No.', 'Staff ID', 'Pos', 'S/N', '#']) assert.ok(nonPersonReason(label), label);
});

test('office, internal and final-copy lines — split at ligatures or not, with or without values beside them — are never people, in the grid and the AI reader', () => {
  const header = ['', 'Mon 13/04', 'Tue 14/04', 'Wed 15/04', 'Thu 16/04'];
  const body = [
    ['Test Alpha', '9-17', 'OFF', '', '18:30-01:00'],
    ['Test Beta', '', '10-18', 'AL', ''],
    ['Test Gamma', '', '', '', ''],
  ];
  for (const footer of [
    ['O ffi ce use only - fi nal copy', '', '', '', ''],
    ['O ffi ce use only', '', 'fi nal copy', '', ''],
    ['Internal', '', '', 'do not distribute', ''],
    ['Final copy', '', '', '', 'Page 1 of 1'],
  ]) {
    const result = parseExcelGrid([header, ...body, footer], TODAY, { today: TODAY, clientWeekStart: null });
    assert.deepEqual(result.people?.map((p) => p.name), STAFF, footer.join(' | '));
  }
  const answer: ReadingAnswer = {
    title: null,
    days: ['13-Apr MONDAY', '14-Apr TUESDAY'],
    key: [],
    pages: [
      {
        p: 1,
        rows: 4,
        sec: [
          {
            h: null,
            n: 4,
            ppl: [
              { nm: 'Test Alpha', t: null, i: 1, c: ['9-17', ''] },
              { nm: 'O ffi ce use only', t: null, i: 2, c: ['', 'fi nal copy'] },
              { nm: 'Office use only - final copy', t: null, i: 3, c: ['', ''] },
              { nm: 'Internal', t: null, i: 4, c: ['do not distribute', ''] },
            ],
          },
        ],
        unread: [],
      },
    ],
  };
  assert.deepEqual(mapReadingAnswer(answer, { today: TODAY, clientWeekStart: null }).people?.map((p) => p.name), ['Test Alpha']);
});

test('text PDF, table reader only: an office line whose ligature pieces sit a hair apart ("O ffi ce use only") is never a person', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([640, 300]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const draw = (text: string, x: number, y: number, gap = 0) => {
    for (const piece of text.split(/(ffi|ffl|ff|fi|fl)/).filter(Boolean)) {
      page.drawText(piece, { x, y, size: 8, font });
      x += font.widthOfTextAtSize(piece, 8) + (/^(ffi|ffl|ff|fi|fl)$/.test(piece) ? gap : 0);
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
  draw('Office use only - final copy', 20, 190, 1.6);
  draw('Internal', 20, 175, 1.6);
  draw('fi nal', 300, 175, 1.6);
  const pdf = Buffer.from(await doc.save());
  const outcome = await readUploadedRoster({ buffer: pdf, mimetype: 'application/pdf', originalname: 'rota.pdf', size: pdf.length }, ctx());
  assert.ok(outcome.ok);
  if (outcome.ok) assert.deepEqual(outcome.result.people?.map((p) => p.name), STAFF);
});

test('a row of column labels is never a person, in any column order; an ID or row-number column is never the names (XLSX and CSV)', async () => {
  const days = ['Mon 13/04', 'Tue 14/04', 'Wed 15/04'];
  const people = [
    ['104233', 'Test Alpha', 'Waiter', '9-17', 'OFF', ''],
    ['104234', 'Test Beta', 'Runner', '', '10-18', 'AL'],
    ['104235', 'Test Gamma', 'Host', '18-23', '', '9-17'],
  ];
  const orders: [string, number[]][] = [
    ['ID | Name | Pos', [0, 1, 2]],
    ['Name | ID | Pos', [1, 0, 2]],
    ['Pos | ID | Name', [2, 0, 1]],
    ['ID | Pos | Name', [0, 2, 1]],
  ];
  const labels = ['Payroll ID', 'Name', 'Pos'];
  for (const [label, order] of orders) {
    const lead = (cells: string[]) => order.map((i) => cells[i]!);
    const grids: [string, string[][]][] = [
      ['labels on the day row', [[...lead(labels), ...days], ...people.map((p) => [...lead(p), ...p.slice(3)])]],
      ['labels on their own row', [['', '', '', ...days], [...lead(labels), '', '', ''], ...people.map((p) => [...lead(p), ...p.slice(3)])]],
      ['labels above the days', [[...lead(labels), '', '', ''], ['', '', '', ...days], ...people.map((p) => [...lead(p), ...p.slice(3)])]],
    ];
    for (const [where, grid] of grids) {
      const ws = XLSX.utils.aoa_to_sheet(grid);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Rota');
      const files: [string, Buffer, string][] = [
        ['r.xlsx', XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
        ['r.csv', Buffer.from(XLSX.utils.sheet_to_csv(ws)), 'text/csv'],
      ];
      for (const [name, buffer, mimetype] of files) {
        const outcome = await readUploadedRoster({ buffer, mimetype, originalname: name, size: buffer.length }, ctx());
        assert.ok(outcome.ok, `${label}, ${where}, ${name}`);
        if (outcome.ok) assert.deepEqual(outcome.result.people?.map((p) => p.name), STAFF, `${label}, ${where}, ${name}`);
      }
    }
  }
  // Two leading columns, labels on their own row: "Payroll ID" | "Staff".
  const two = parseExcelGrid([['', '', ...days], ['Payroll ID', 'Staff', '', '', ''], ...people.map((p) => [p[0]!, p[1]!, ...p.slice(3)])], TODAY, { today: TODAY, clientWeekStart: null });
  assert.deepEqual(two.people?.map((p) => p.name), STAFF);
});
