import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentWeekStart, reconcileWeekParam } from './weekStart.ts';

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


test('reconcileWeekParam: a first load with ?week= adopts it; a bare URL gets the current week written', () => {
  assert.deepEqual(reconcileWeekParam('2026-10-05', '2026-09-21', null), { adopt: '2026-10-05', lastSynced: '2026-10-05' });
  assert.deepEqual(reconcileWeekParam(null, '2026-09-21', null), { write: '2026-09-21', lastSynced: '2026-09-21' });
});

test('reconcileWeekParam: Next week (state moves, URL still old) writes the new week instead of snapping back', () => {
  assert.deepEqual(reconcileWeekParam('2026-09-21', '2026-09-28', '2026-09-21'), { write: '2026-09-28', lastSynced: '2026-09-28' });
});

test('reconcileWeekParam: back/forward (URL moves away from the last synced week) adopts the URL', () => {
  assert.deepEqual(reconcileWeekParam('2026-09-21', '2026-09-28', '2026-09-28'), { adopt: '2026-09-21', lastSynced: '2026-09-21' });
});

test('reconcileWeekParam: in sync is a no-op; a malformed ?week= is overwritten', () => {
  assert.deepEqual(reconcileWeekParam('2026-09-28', '2026-09-28', '2026-09-28'), { lastSynced: '2026-09-28' });
  assert.deepEqual(reconcileWeekParam('next-tuesday', '2026-09-28', null), { write: '2026-09-28', lastSynced: '2026-09-28' });
});
