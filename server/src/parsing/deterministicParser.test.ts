import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTime, parseShiftCell, resolveRoleCategory } from './deterministicParser.js';

test('normalizeTime converts 12h and 24h formats to 24h HH:mm', () => {
  assert.equal(normalizeTime('10'), '10:00');
  assert.equal(normalizeTime('10:30'), '10:30');
  assert.equal(normalizeTime('10am'), '10:00');
  assert.equal(normalizeTime('3pm'), '15:00');
  assert.equal(normalizeTime('12am'), '00:00');
  assert.equal(normalizeTime('12pm'), '12:00');
  assert.equal(normalizeTime('7:30pm'), '19:30');
  assert.equal(normalizeTime('24'), '00:00');
  assert.equal(normalizeTime('00:00'), '00:00');
  assert.equal(normalizeTime('garbage'), null);
});

test('parseShiftCell handles a simple single shift', () => {
  const r = parseShiftCell('10:00-15:00');
  assert.equal(r.type, 'WORKING');
  assert.equal(r.intervals.length, 1);
  assert.deepEqual(r.intervals[0], { start: '10:00', end: '15:00' });
});

test('parseShiftCell handles 12-hour single shift', () => {
  const r = parseShiftCell('10am-3pm');
  assert.equal(r.type, 'WORKING');
  assert.deepEqual(r.intervals[0], { start: '10:00', end: '15:00' });
});

test('parseShiftCell splits multi-segmented split shifts (10am/3pm-7pm/12am)', () => {
  const r = parseShiftCell('10am/3pm-7pm/12am');
  assert.equal(r.type, 'WORKING');
  assert.equal(r.intervals.length, 2, 'two intervals from compact split notation');
  assert.deepEqual(r.intervals[0], { start: '10:00', end: '15:00' });
  assert.deepEqual(r.intervals[1], { start: '19:00', end: '00:00' });
});

test('parseShiftCell splits slash-separated full pairs (10:00-15:00/17:00-00:00)', () => {
  const r = parseShiftCell('10:00-15:00/17:00-00:00');
  assert.equal(r.type, 'WORKING');
  assert.equal(r.intervals.length, 2);
  assert.deepEqual(r.intervals[0], { start: '10:00', end: '15:00' });
  assert.deepEqual(r.intervals[1], { start: '17:00', end: '00:00' });
});

test('parseShiftCell recognizes leave/absence codes', () => {
  for (const code of ['Off', 'A/L', 'Annual Leave', 'PH', 'Sick', '-', '']) {
    const r = parseShiftCell(code);
    assert.equal(r.type, 'OFF', `"${code}" should be OFF`);
    assert.equal(r.intervals.length, 0);
  }
});

test('parseShiftCell returns UNKNOWN for unparseable values', () => {
  const r = parseShiftCell('X2');
  assert.equal(r.type, 'UNKNOWN');
  assert.equal(r.intervals.length, 0);
});

test('resolveRoleCategory maps titles to hierarchy', () => {
  assert.equal(resolveRoleCategory('Manager'), 'MANAGER');
  assert.equal(resolveRoleCategory('General Manager'), 'MANAGER');
  assert.equal(resolveRoleCategory('GM'), 'MANAGER');
  assert.equal(resolveRoleCategory('Floor Manager'), 'MANAGER');
  assert.equal(resolveRoleCategory('Supervisor'), 'SUPERVISOR');
  assert.equal(resolveRoleCategory('Head Waiter'), 'HEAD_WAITER');
  assert.equal(resolveRoleCategory('Captain'), 'HEAD_WAITER');
  assert.equal(resolveRoleCategory('Waiter'), 'WAITER');
  assert.equal(resolveRoleCategory('Bartender'), 'WAITER');
  assert.equal(resolveRoleCategory('Runner'), 'RUNNER');
  assert.equal(resolveRoleCategory('Food Runner'), 'RUNNER');
  assert.equal(resolveRoleCategory('Unknown Title'), 'WAITER'); // fallback default
});
