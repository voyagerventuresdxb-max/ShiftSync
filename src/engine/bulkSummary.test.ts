import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bulkSummary } from './bulkSummary';

test('all done: a plain count', () => {
  assert.equal(bulkSummary('Deleted', 1, []), 'Deleted 1 shift.');
  assert.equal(bulkSummary('Assigned', 3, []), 'Assigned 3 shifts.');
});

test('some refused: how many, and the first reason', () => {
  assert.equal(
    bulkSummary('Assigned', 1, ['Sara already works 11:00–15:00 on 2031-06-03 — two shifts for one person can’t overlap.', 'x']),
    'Assigned 1 shift; 2 refused — Sara already works 11:00–15:00 on 2031-06-03 — two shifts for one person can’t overlap.',
  );
  assert.equal(bulkSummary('Deleted', 0, ['gone']), 'Deleted 0 shifts; 1 refused — gone');
});
