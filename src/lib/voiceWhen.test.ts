import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endsNextDay, fullDay, shiftWhen, timeSpan } from './voiceWhen';

test('a day is spelled out in full: weekday, date, month and year', () => {
  assert.equal(fullDay('2026-10-09'), 'Friday 9 October 2026');
  assert.equal(fullDay('2026-12-31'), 'Thursday 31 December 2026');
  assert.equal(fullDay('not-a-date'), 'not-a-date');
});

test('a day shift reads as one span on its own day', () => {
  assert.equal(shiftWhen('2026-10-09', '09:00', '17:00'), 'Friday 9 October 2026, 09:00 – 17:00');
});

test('an overnight shift says which day it ends', () => {
  assert.equal(shiftWhen('2026-10-09', '18:30', '01:00'), 'Friday 9 October 2026, 18:30 – 01:00 (ends Saturday)');
  // "6 to 2": 18:00 – 02:00.
  assert.equal(timeSpan('2026-10-10', '18:00', '02:00'), '18:00 – 02:00 (ends Sunday)');
  // Across a month and a year end.
  assert.equal(shiftWhen('2026-12-31', '20:00', '03:00'), 'Thursday 31 December 2026, 20:00 – 03:00 (ends Friday)');
  assert.equal(timeSpan(undefined, '22:00', '04:00'), '22:00 – 04:00 (ends next day)');
});

test('overnight detection: end at or before start; malformed times are never called overnight', () => {
  assert.equal(endsNextDay('18:30', '01:00'), true);
  assert.equal(endsNextDay('9:00', '17:00'), false);
  assert.equal(endsNextDay('12:00', '12:00'), true);
  assert.equal(endsNextDay('evening', '01:00'), false);
});

test('a split shift is two spans on the same day, each read on its own', () => {
  assert.equal(shiftWhen('2026-10-09', '11:00', '15:00'), 'Friday 9 October 2026, 11:00 – 15:00');
  assert.equal(shiftWhen('2026-10-09', '18:00', '23:00'), 'Friday 9 October 2026, 18:00 – 23:00');
});
