import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRequestWindowClose, isRequestLocked } from './swapRequestPolicy.ts';

test('nextRequestWindowClose rolls forward to the next Wednesday 17:00 Asia/Dubai', () => {
  // Monday 2026-08-24 10:00 Asia/Dubai (UTC+4) -> Wed 2026-08-26 17:00 Asia/Dubai
  const monday = new Date('2026-08-24T06:00:00.000Z'); // 10:00 Dubai
  const close = nextRequestWindowClose(monday);
  assert.equal(close.toISOString(), '2026-08-26T13:00:00.000Z'); // Wed 17:00 Dubai = 13:00 UTC
});

test('nextRequestWindowClose on Wednesday before 17:00 stays same day', () => {
  const wedMorning = new Date('2026-08-26T06:00:00.000Z'); // 10:00 Dubai, same Wednesday
  const close = nextRequestWindowClose(wedMorning);
  assert.equal(close.toISOString(), '2026-08-26T13:00:00.000Z');
});

test('nextRequestWindowClose on Wednesday after 17:00 rolls to next week', () => {
  const wedEvening = new Date('2026-08-26T15:00:00.000Z'); // 19:00 Dubai, past the 17:00 cutoff
  const close = nextRequestWindowClose(wedEvening);
  assert.equal(close.toISOString(), '2026-09-02T13:00:00.000Z');
});

test('isRequestLocked is false for a pending request whose shift is still owned by the requester', () => {
  const locked = isRequestLocked({ status: 'PENDING' }, { userId: 'user-a' }, 'user-a');
  assert.equal(locked, false);
});

test('isRequestLocked is true when a different approved request already reassigned the shift', () => {
  const locked = isRequestLocked({ status: 'PENDING' }, { userId: 'user-b' }, 'user-a');
  assert.equal(locked, true);
});

test('isRequestLocked is false for an already-decided request regardless of shift ownership', () => {
  const locked = isRequestLocked({ status: 'APPROVED' }, { userId: 'user-b' }, 'user-a');
  assert.equal(locked, false);
});

test('isRequestLocked is false when the shift is unassigned', () => {
  const locked = isRequestLocked({ status: 'PENDING' }, { userId: null }, 'user-a');
  assert.equal(locked, false);
});
