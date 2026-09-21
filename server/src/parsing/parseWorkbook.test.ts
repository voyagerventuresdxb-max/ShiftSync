import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { listOtherSheetNames } from './parseWorkbook.js';
import { buildXlsx } from './workbookTestUtils.js';

// Round-2 audit finding: this app's parsers only ever read a workbook's
// first sheet (buildMergeExpandedGrid/parseWorkbookBuffer both hardcode
// SheetNames[0]) — a multi-tab file (notes-tab-first, per-outlet, a
// weekly archive) can have its real roster sitting on a tab that's never
// looked at, with zero indication of that in an otherwise-successful-
// looking result. listOtherSheetNames is the detection primitive
// schedules.ts uses to surface that as an 'ignored_workbook_sheets'
// anomaly rather than silently importing (or failing on) whatever the
// first tab happens to contain.

test('listOtherSheetNames returns every sheet name except the first, in order', async () => {
  const buffer = await buildXlsx([
    { name: 'This Week', rows: [['x']] },
    { name: 'Prior Week (archive)', rows: [['y']] },
    { name: 'Notes', rows: [['z']] },
  ]);

  assert.deepEqual(await listOtherSheetNames(buffer, 'test.xlsx'), ['Prior Week (archive)', 'Notes']);
});

test('listOtherSheetNames returns an empty array for a normal single-sheet file', async () => {
  const buffer = await buildXlsx([{ name: 'Roster', rows: [['x']] }]);

  assert.deepEqual(await listOtherSheetNames(buffer, 'test.xlsx'), []);
});

test('unrecognized-workbook-sheets audit fixture: correctly names both ignored tabs (before this fix: nothing in the response indicated the real roster on "This Week" was never read)', async () => {
  const buffer = readFileSync('server/test-fixtures/edge-case-audit-round2/3-multi-sheet-workbook.xlsx');
  assert.deepEqual(await listOtherSheetNames(buffer, '3-multi-sheet-workbook.xlsx'), ['This Week', 'Prior Week (archive)']);
});
