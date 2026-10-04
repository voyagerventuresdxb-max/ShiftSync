import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../app.js';
import { issueSession } from '../lib/identity.js';

/**
 * DELETE /api/identity/account — self-service deletion against the real route and the branch
 * schema: what is erased, what is kept de-identified, and the last-owner refusal.
 */
const prisma = new PrismaClient();
let orgId = '';

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const app = createApp();
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function call(token: string, method: string, path: string, body?: unknown) {
  return withServer(async (base) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
  });
}

// Unique synthetic mobile numbers for this run (User.phone is unique).
let seq = Date.now() % 9_000_000;
const phone = () => `+97155${String(1_000_000 + (seq++ % 9_000_000)).padStart(7, '0')}`;

async function venue(roles: ('OWNER' | 'MANAGER' | 'STAFF')[]) {
  const location = await prisma.location.create({ data: { organizationId: orgId, name: '__deletion-test__ venue', timezone: 'Asia/Dubai' } });
  const users = [];
  for (const [i, systemRole] of roles.entries()) {
    users.push(await prisma.user.create({ data: { locationId: location.id, systemRole, fullName: `__deletion-test__ ${systemRole} ${i}`, phone: phone(), jobTitle: 'Bartender', emiratesIdNumber: '784-0000-0000000-0' } }));
  }
  return { location, users };
}

before(async () => {
  const org = await prisma.organization.create({ data: { name: '__deletion-test__ org' } });
  orgId = org.id;
});

after(async () => {
  const locations = await prisma.location.findMany({ where: { organizationId: orgId }, select: { id: true } });
  const ids = locations.map((l) => l.id);
  await prisma.auditLog.deleteMany({ where: { locationId: { in: ids } } });
  await prisma.shift.deleteMany({ where: { locationId: { in: ids } } });
  await prisma.joinRequest.deleteMany({ where: { locationId: { in: ids } } });
  await prisma.organization.delete({ where: { id: orgId } }).catch(async () => {
    await prisma.location.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.delete({ where: { id: orgId } });
  });
  await prisma.$disconnect();
});

test('a staff member deletes their account: personal details erased, sessions ended, shifts kept de-identified, audit row written', async () => {
  const { location, users } = await venue(['OWNER', 'STAFF']);
  const staff = users[1]!;
  const role = await prisma.role.create({ data: { locationId: location.id, name: '__deletion-test__ role' } });
  const shift = await prisma.shift.create({
    data: { locationId: location.id, roleId: role.id, userId: staff.id, date: new Date('2026-09-01T00:00:00.000Z'), startTime: new Date('2026-09-01T05:00:00.000Z'), endTime: new Date('2026-09-01T13:00:00.000Z'), status: 'PUBLISHED' },
  });
  await prisma.joinRequest.create({ data: { locationId: location.id, phone: staff.phone!, fullName: staff.fullName, status: 'APPROVED' } });
  await prisma.pushSubscription.create({ data: { userId: staff.id, endpoint: 'https://push.example/x', p256dh: 'k', auth: 'a' } });
  await prisma.notification.create({ data: { userId: staff.id, title: 't', body: 'b' } });
  await prisma.otpCode.create({ data: { phone: staff.phone!, codeHash: 'h', purpose: 'LOGIN', expiresAt: new Date(Date.now() + 60_000) } });
  const token = (await issueSession(staff.id)).plainToken;

  const refused = await call(token, 'DELETE', '/api/identity/account', {});
  assert.equal(refused.status, 400, 'an explicit confirm is required');

  const res = await call(token, 'DELETE', '/api/identity/account', { confirm: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const row = await prisma.user.findUniqueOrThrow({ where: { id: staff.id } });
  assert.deepEqual(
    [row.fullName, row.phone, row.jobTitle, row.emiratesIdNumber, row.isActive],
    ['Deleted user', null, null, null, false],
  );
  assert.ok(row.deletedAt);
  assert.equal(await prisma.session.count({ where: { userId: staff.id } }), 0);
  assert.equal(await prisma.pushSubscription.count({ where: { userId: staff.id } }), 0);
  assert.equal(await prisma.notification.count({ where: { userId: staff.id } }), 0);
  assert.equal(await prisma.otpCode.count({ where: { phone: staff.phone! } }), 0);
  assert.equal(await prisma.joinRequest.count({ where: { locationId: location.id, fullName: staff.fullName } }), 0);
  assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: shift.id } })).userId, staff.id, 'the shift stays, now de-identified');
  const audit = await prisma.auditLog.findFirstOrThrow({ where: { locationId: location.id, action: 'ACCOUNT_DELETED' } });
  assert.equal(audit.entityId, staff.id);
  assert.ok(!(audit.note ?? '').includes(staff.fullName), 'no name in the audit note');

  const after = await call(token, 'DELETE', '/api/identity/account', { confirm: true });
  assert.equal(after.status, 401, 'the old session is gone');
});

test("the venue's only active owner is refused with advice, and nothing changes", async () => {
  const { users } = await venue(['OWNER', 'STAFF']);
  const owner = users[0]!;
  const token = (await issueSession(owner.id)).plainToken;
  const res = await call(token, 'DELETE', '/api/identity/account', { confirm: true });
  assert.equal(res.status, 409);
  assert.equal(res.body.errorCode, 'last_owner');
  assert.match(res.body.error, /only owner of this venue/);
  const row = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
  assert.deepEqual([row.isActive, row.deletedAt, row.fullName], [true, null, owner.fullName]);
});

test('an owner with another active owner can delete their account', async () => {
  const { users } = await venue(['OWNER', 'OWNER']);
  const token = (await issueSession(users[0]!.id)).plainToken;
  const res = await call(token, 'DELETE', '/api/identity/account', { confirm: true });
  assert.equal(res.status, 200);
});

test('a deleted account disappears from the Staff Directory and cannot be reactivated', async () => {
  const { location, users } = await venue(['OWNER', 'STAFF']);
  const [owner, staff] = [users[0]!, users[1]!];
  await call((await issueSession(staff.id)).plainToken, 'DELETE', '/api/identity/account', { confirm: true });
  const ownerToken = (await issueSession(owner.id)).plainToken;
  const list = await call(ownerToken, 'GET', `/api/staff-directory/${location.id}`);
  assert.equal(list.status, 200);
  assert.ok(!(list.body.staff as { id: string }[]).some((s) => s.id === staff.id));
  const reactivate = await call(ownerToken, 'PATCH', `/api/staff-directory/${staff.id}`, { isActive: true });
  assert.equal(reactivate.status, 409);
  assert.equal(reactivate.body.errorCode, 'account_deleted');
});
