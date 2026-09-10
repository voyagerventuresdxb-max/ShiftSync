import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enforceNoDoubleShifts } from './shiftConstraints.js';
import type { ParsedShiftRow } from './types.js';

function shift(over: Partial<ParsedShiftRow>): ParsedShiftRow {
  return {
    rowNumber: 1,
    employeeName: 'X',
    roleName: 'Waiter',
    date: '2026-08-18',
    startTime: '09:00',
    endTime: '17:00',
    overnight: false,
    breakMinutes: 0,
    managerNotes: null,
    ...over,
  };
}

test('accepts a valid AM/PM split with an overnight PM shift', () => {
  const r = enforceNoDoubleShifts([
    shift({ employeeName: 'Andrea', startTime: '11:00', endTime: '17:00', overnight: false, managerNotes: '[AM]' }),
    shift({ employeeName: 'Andrea', startTime: '18:00', endTime: '01:00', overnight: true, managerNotes: '[PM]' }),
  ]);
  assert.equal(r.accepted.length, 2);
  assert.equal(r.anomalies.length, 0);
});

test('accepts a valid AM/PM split with a same-day PM shift', () => {
  const r = enforceNoDoubleShifts([
    shift({ employeeName: 'Ahmed', startTime: '09:00', endTime: '13:00', overnight: false, managerNotes: '[AM]' }),
    shift({ employeeName: 'Ahmed', startTime: '14:00', endTime: '22:00', overnight: false, managerNotes: '[PM]' }),
  ]);
  assert.equal(r.accepted.length, 2);
  assert.equal(r.anomalies.length, 0);
});

test('rejects two overlapping shifts on the same day', () => {
  const r = enforceNoDoubleShifts([
    shift({ startTime: '09:00', endTime: '17:00' }),
    shift({ startTime: '12:00', endTime: '20:00' }),
  ]);
  assert.equal(r.accepted.length, 0);
  assert.equal(r.anomalies.length, 1);
  assert.match(r.anomalies[0].reason, /overlapping/i);
});

test('rejects two shifts with no real break (gap < 30min)', () => {
  const r = enforceNoDoubleShifts([
    shift({ startTime: '09:00', endTime: '17:00' }),
    shift({ startTime: '17:15', endTime: '23:00' }),
  ]);
  assert.equal(r.accepted.length, 0);
  assert.equal(r.anomalies.length, 1);
  assert.match(r.anomalies[0].reason, /too close/i);
});

test('rejects three+ shifts on the same day (cell-splitting hallucination)', () => {
  const r = enforceNoDoubleShifts([
    shift({ startTime: '09:00', endTime: '12:00' }),
    shift({ startTime: '12:00', endTime: '15:00' }),
    shift({ startTime: '15:00', endTime: '18:00' }),
  ]);
  assert.equal(r.accepted.length, 0);
  assert.equal(r.anomalies.length, 1);
  assert.match(r.anomalies[0].reason, /max 2 allowed/i);
});
