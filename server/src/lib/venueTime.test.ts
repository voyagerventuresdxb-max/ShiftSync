import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatVenueTime } from './venueTime.js';

test('formatVenueTime renders a UTC instant as venue-local HH:MM (Asia/Dubai, UTC+4)', () => {
  // 13:00 UTC = 17:00 in Asia/Dubai
  const instant = new Date('2026-08-24T13:00:00.000Z');
  assert.equal(formatVenueTime(instant, 'Asia/Dubai'), '17:00');
});

test('formatVenueTime handles a time that rolls the venue-local hour past midnight UTC', () => {
  // 21:30 UTC = 01:30 next day in Asia/Dubai
  const instant = new Date('2026-08-24T21:30:00.000Z');
  assert.equal(formatVenueTime(instant, 'Asia/Dubai'), '01:30');
});

test('formatVenueTime zero-pads single-digit hours and minutes', () => {
  // 04:05 UTC = 08:05 in Asia/Dubai
  const instant = new Date('2026-08-24T04:05:00.000Z');
  assert.equal(formatVenueTime(instant, 'Asia/Dubai'), '08:05');
});
