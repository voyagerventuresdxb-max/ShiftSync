import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import { listOtherSheetNames } from './parseWorkbook.js';

// Round-2 audit finding: this app's parsers only ever read a workbook's
// first sheet (buildMergeExpandedGrid/parseWorkbookBuffer both hardcode
// SheetNames[0]) — a multi-tab file (notes-tab-first, per-outlet, a
// weekly archive) can have its real roster sitting on a tab that's never
// looked at, with zero indication of that in an otherwise-successful-
// looking result. listOtherSheetNames is the detection primitive
// schedules.ts uses to surface that as an 'ignored_workbook_sheets'
// anomaly rather than silently importing (or failing on) whatever the
// first tab happens to contain.

test('listOtherSheetNames returns every sheet name except the first, in order', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x']]), 'This Week');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['y']]), 'Prior Week (archive)');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['z']]), 'Notes');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

  assert.deepEqual(listOtherSheetNames(buffer, 'test.xlsx'), ['Prior Week (archive)', 'Notes']);
});

test('listOtherSheetNames returns an empty array for a normal single-sheet file', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x']]), 'Roster');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

  assert.deepEqual(listOtherSheetNames(buffer, 'test.xlsx'), []);
});

test('unrecognized-workbook-sheets audit fixture: correctly names both ignored tabs (before this fix: nothing in the response indicated the real roster on "This Week" was never read)', () => {
  const buffer = readFileSync('server/test-fixtures/edge-case-audit-round2/3-multi-sheet-workbook.xlsx');
  assert.deepEqual(listOtherSheetNames(buffer, '3-multi-sheet-workbook.xlsx'), ['This Week', 'Prior Week (archive)']);
});
