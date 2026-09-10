import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentWeekStart } from './weekStart.ts';

test('currentWeekStart returns the Monday of the week containing `now`', () => {
  // 2026-08-26 is a Wednesday
  assert.equal(currentWeekStart(new Date('2026-08-26T12:00:00.000Z')), '2026-08-24');
});

test('currentWeekStart on a Monday returns that same date', () => {
  assert.equal(currentWeekStart(new Date('2026-08-24T00:30:00.000Z')), '2026-08-24');
});

test('currentWeekStart on a Sunday rolls back to the prior Monday', () => {
  // 2026-08-30 is a Sunday; the Monday of that week is 2026-08-24.
  // Uses midday UTC (not 23:00) so the assertion holds regardless of the
  // runner's local timezone offset — this repo's own target timezone
  // (Asia/Dubai, UTC+4) would otherwise roll 23:00 UTC into the next local
  // day and falsely fail.
  assert.equal(currentWeekStart(new Date('2026-08-30T12:00:00.000Z')), '2026-08-24');
});
