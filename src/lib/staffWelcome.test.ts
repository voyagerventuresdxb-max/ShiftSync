import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldShowStaffWelcome } from './staffWelcome';

test("shouldShowStaffWelcome: only a STAFF member's very first sign-in", () => {
  assert.equal(shouldShowStaffWelcome({ firstSignIn: true, user: { systemRole: 'STAFF' } }), true);
  assert.equal(shouldShowStaffWelcome({ firstSignIn: false, user: { systemRole: 'STAFF' } }), false);
  assert.equal(shouldShowStaffWelcome({ user: { systemRole: 'STAFF' } }), false, 'an older server without the flag shows nothing');
  assert.equal(shouldShowStaffWelcome({ firstSignIn: true, user: { systemRole: 'MANAGER' } }), false);
  assert.equal(shouldShowStaffWelcome({ firstSignIn: true, user: { systemRole: 'OWNER' } }), false);
});
