import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickViewedEmployee } from './rosterView';

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
