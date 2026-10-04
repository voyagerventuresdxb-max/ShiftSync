import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeInviteExpiry, describeInviteUses } from './inviteLinkFormat';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const at = (ms: number) => new Date(NOW + ms).toISOString();
const HOUR = 60 * 60 * 1000;

test('describeInviteExpiry: whole days rounded up, hours under a day, Expired once past', () => {
  assert.equal(describeInviteExpiry(at(30 * 24 * HOUR - 5), NOW), 'Expires in 30 days');
  assert.equal(describeInviteExpiry(at(7 * 24 * HOUR), NOW), 'Expires in 7 days');
  assert.equal(describeInviteExpiry(at(24 * HOUR + 1), NOW), 'Expires in 2 days');
  assert.equal(describeInviteExpiry(at(24 * HOUR), NOW), 'Expires in 24 hours');
  assert.equal(describeInviteExpiry(at(90 * 60 * 1000), NOW), 'Expires in 2 hours');
  assert.equal(describeInviteExpiry(at(60 * 1000), NOW), 'Expires in 1 hour');
  assert.equal(describeInviteExpiry(at(0), NOW), 'Expired');
  assert.equal(describeInviteExpiry(at(-HOUR), NOW), 'Expired');
  assert.equal(describeInviteExpiry('not a date', NOW), 'Expired');
});

test('describeInviteUses: "N of M uses" with a cap, "N joins" without', () => {
  assert.equal(describeInviteUses(3, 10), '3 of 10 uses');
  assert.equal(describeInviteUses(0, 1), '0 of 1 use');
  assert.equal(describeInviteUses(0, null), '0 joins');
  assert.equal(describeInviteUses(1, null), '1 join');
  assert.equal(describeInviteUses(3, null), '3 joins');
});
