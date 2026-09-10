import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLE_SECTIONS, roleKey, sectionForRole, isManagementTitle, sectionForEmployee, groupIntoSections } from './roleGrouping.ts';

test('roleKey normalizes case, punctuation, and whitespace', () => {
  assert.equal(roleKey('Head Waiter'), 'head waiter');
  assert.equal(roleKey('  Floor-Manager  '), 'floor manager');
});

test('sectionForRole matches known role synonyms to the right section', () => {
  assert.equal(sectionForRole('Manager'), 'manager');
  assert.equal(sectionForRole('Restaurant Manager'), 'manager');
  assert.equal(sectionForRole('Team Leader'), 'supervisor');
  assert.equal(sectionForRole('Head Server'), 'head-waiter');
  assert.equal(sectionForRole('Server'), 'waiter');
  assert.equal(sectionForRole('Food Runner'), 'runner');
});

test('sectionForRole falls back to other for unknown roles', () => {
  assert.equal(sectionForRole('Sommelier'), 'other');
});

test('isManagementTitle matches any casing containing manager/management', () => {
  assert.equal(isManagementTitle('Assistant Restaurant Manager'), true);
  assert.equal(isManagementTitle('Floor Management'), true);
  assert.equal(isManagementTitle('Waiter'), false);
});

test('sectionForEmployee prefers a management job title over the parsed role', () => {
  const jobTitles = new Map([['jane doe', 'Duty Manager']]);
  const emp = { name: 'Jane Doe', role: 'Server' };
  assert.equal(sectionForEmployee(emp, jobTitles), 'manager');
});

test('sectionForEmployee falls back to role-based classification when no job title match', () => {
  const jobTitles = new Map<string, string | null | undefined>();
  const emp = { name: 'Jane Doe', role: 'Runner' };
  assert.equal(sectionForEmployee(emp, jobTitles), 'runner');
});

test('groupIntoSections orders sections per ROLE_SECTIONS, puts needsRoleReview first, other last', () => {
  const employees = [
    { id: 'e1', name: 'A', role: 'Runner', needsRoleReview: false },
    { id: 'e2', name: 'B', role: 'Server', needsRoleReview: false },
    { id: 'e3', name: 'C', role: 'Sommelier', needsRoleReview: false },
    { id: 'e4', name: 'D', role: 'Unknown', needsRoleReview: true },
  ];
  const sections = groupIntoSections(employees, new Map());
  assert.equal(sections[0].key, 'needs-review');
  assert.equal(sections[0].flagged, true);
  assert.deepEqual(sections[0].employees.map((e) => e.id), ['e4']);
  const keys = sections.map((s) => s.key);
  assert.deepEqual(keys, ['needs-review', 'waiter', 'runner', 'other']);
  assert.deepEqual(sections.find((s) => s.key === 'other')!.employees.map((e) => e.id), ['e3']);
});

test('ROLE_SECTIONS is exported in display order, Management first', () => {
  assert.deepEqual(ROLE_SECTIONS.map((s) => s.key), ['manager', 'supervisor', 'head-waiter', 'waiter', 'runner']);
});
