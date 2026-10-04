import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escalationConfig } from '../lib/aiConfig.js';
import { deterministicEscalationReason, isAllCapsLabel } from './escalation.js';

const row = (employeeName: string, roleName: string) => ({ employeeName, roleName });

test('isAllCapsLabel: capitals with at least 3 letters; initials, mixed case, digits and case-less scripts are not', () => {
  for (const yes of ['TEST ALPHA', "O'NEIL TEST", 'ÉLODIE TEST', 'TEST AL-SAYED']) assert.ok(isAllCapsLabel(yes), yes);
  // Arabic has no letter case, so an Arabic-only roster is never mistaken for an ALL-CAPS one.
  for (const no of ['Test Alpha', 'AM', 'J.K.', '1234', 'TEST alpha', 'مدير']) assert.ok(!isAllCapsLabel(no), no);
});

test('no rows → no escalation; roles present and mixed-case names → none', () => {
  assert.equal(deterministicEscalationReason({ rows: [] }), null);
  assert.equal(deterministicEscalationReason({ rows: [row('Test Alpha', 'Bartender'), row('Test Beta', 'Host')] }), null);
});

test('every name in capitals (two or more people) → all_caps_venue; a single caps name is not enough', () => {
  assert.equal(deterministicEscalationReason({ rows: [row('TEST ALPHA', 'Bartender'), row('TEST BETA', 'Host')] }), 'all_caps_venue');
  assert.equal(deterministicEscalationReason({ rows: [row('TEST ALPHA', 'Bartender'), row('TEST ALPHA', 'Bartender')] }), null);
  assert.equal(deterministicEscalationReason({ rows: [row('TEST ALPHA', 'Bartender'), row('Test Beta', 'Host')] }), null);
});

test('empty roles above the share → empty_roles; at or below → none; the share comes from config', () => {
  const rows = [row('A One', ''), row('B Two', 'Host'), row('C Three', 'Host'), row('D Four', 'Host')]; // 25 % empty
  assert.equal(deterministicEscalationReason({ rows }), null);
  assert.equal(deterministicEscalationReason({ rows: [...rows, row('E Five', '')] }), 'empty_roles'); // 40 %
  assert.equal(deterministicEscalationReason({ rows }, { emptyRoleShare: 0.2 }), 'empty_roles');
});

test('ROSTER_ESCALATE_EMPTY_ROLE_SHARE: valid 0–1 values are used; anything else falls back to 0.3', () => {
  assert.equal(escalationConfig({}).emptyRoleShare, 0.3);
  assert.equal(escalationConfig({ ROSTER_ESCALATE_EMPTY_ROLE_SHARE: '0.5' }).emptyRoleShare, 0.5);
  assert.equal(escalationConfig({ ROSTER_ESCALATE_EMPTY_ROLE_SHARE: '0' }).emptyRoleShare, 0);
  for (const bad of ['', 'abc', '-0.1', '1.5']) assert.equal(escalationConfig({ ROSTER_ESCALATE_EMPTY_ROLE_SHARE: bad }).emptyRoleShare, 0.3, bad);
});
