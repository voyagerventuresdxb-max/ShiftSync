import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickViewedEmployee, totalHours } from './rosterView';
import type { Shift } from './types';

const employees = [
  { id: 'layla', name: 'Layla' },
  { id: 'omar', name: 'Omar' },
];

test('an explicit Viewing selection always wins, for any role', () => {
  assert.equal(pickViewedEmployee(employees, 'layla', { id: 'omar', systemRole: 'STAFF' })?.id, 'layla');
  assert.equal(pickViewedEmployee(employees, 'omar', { id: 'x', systemRole: 'MANAGER' })?.id, 'omar');
});

test('a STAFF session with no selection defaults to THEMSELVES, not the first roster entry', () => {
  assert.equal(pickViewedEmployee(employees, undefined, { id: 'omar', systemRole: 'STAFF' })?.id, 'omar');
});

test('a MANAGER/OWNER session with no selection keeps the first roster entry (they are reviewing the team)', () => {
  assert.equal(pickViewedEmployee(employees, undefined, { id: 'omar', systemRole: 'MANAGER' })?.id, 'layla');
  assert.equal(pickViewedEmployee(employees, undefined, { id: 'omar', systemRole: 'OWNER' })?.id, 'layla');
});

test('a STAFF session not on this week’s roster, or no session at all, falls back to the first entry', () => {
  assert.equal(pickViewedEmployee(employees, undefined, { id: 'nobody', systemRole: 'STAFF' })?.id, 'layla');
  assert.equal(pickViewedEmployee(employees, undefined, null)?.id, 'layla');
  assert.equal(pickViewedEmployee([], undefined, { id: 'omar', systemRole: 'STAFF' }), undefined);
});

test('a stale selection that is no longer on the roster is ignored in favour of the default', () => {
  assert.equal(pickViewedEmployee(employees, 'gone', { id: 'omar', systemRole: 'STAFF' })?.id, 'omar');
});

test('totalHours sums both segments of a split shift (per day) and every segment across the week', () => {
  const seg = (id: string, date: string, start: string, end: string): Shift => ({ id, employeeId: 'sara', date, start, end, type: 'service', overnight: end <= start });
  const tuesday = [seg('a', '2031-04-08', '11:00', '15:00'), seg('b', '2031-04-08', '18:00', '23:00')];
  assert.equal(totalHours(tuesday), 9);
  assert.equal(totalHours([...tuesday, seg('c', '2031-04-09', '22:00', '02:00')]), 13, 'an overnight segment counts its hours past midnight');
});
