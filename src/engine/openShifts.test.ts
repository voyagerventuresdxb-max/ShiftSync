import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openShiftCounts, uncoveredLabel } from './openShifts';

const days = ['2026-10-05', '2026-10-06', '2026-10-07'];

test('counts only unassigned shifts, per day of the shown week', () => {
  const counts = openShiftCounts(
    [
      { date: '2026-10-05', employeeId: 'open-a' },
      { date: '2026-10-05', employeeId: 'open-b' },
      { date: '2026-10-05', employeeId: 'user-1' },
      { date: '2026-10-07', employeeId: 'open-c' },
    ],
    days,
  );
  assert.equal(counts.total, 3);
  assert.deepEqual(counts.byDay, { '2026-10-05': 2, '2026-10-06': 0, '2026-10-07': 1 });
});

test('a shift outside the shown week is ignored, and no shifts means nothing uncovered', () => {
  assert.deepEqual(openShiftCounts([{ date: '2026-10-12', employeeId: 'open-x' }], days), { total: 0, byDay: { '2026-10-05': 0, '2026-10-06': 0, '2026-10-07': 0 } });
  assert.equal(openShiftCounts([], days).total, 0);
});

test('the label is singular for one', () => {
  assert.equal(uncoveredLabel(1), '1 uncovered shift');
  assert.equal(uncoveredLabel(4), '4 uncovered shifts');
});
