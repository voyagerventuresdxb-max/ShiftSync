import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../app.js';
import { issueSession } from '../lib/identity.js';

/**
 * A decided cover request stays decided: PATCH /api/swap-requests/:id on an
 * APPROVED or DECLINED request answers 409 and changes nothing (no status
 * flip, no shift reassignment, no second audit row). Two managers deciding
 * the same PENDING request at once: exactly one wins.
 */
const prisma = new PrismaClient();
const TAG = '__swapdecide-test__';
const day = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);

let locationId = '';
let roleId = '';
const ids = { requester: '', target: '', manager: '', manager2: '' };

async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function freshRequest() {
  const shift = await prisma.shift.create({
    data: { locationId, roleId, userId: ids.requester, date: new Date(`${day}T00:00:00.000Z`), startTime: new Date(`${day}T05:00:00.000Z`), endTime: new Date(`${day}T13:00:00.000Z`), status: 'PUBLISHED' },
  });
  const request = await prisma.shiftSwapRequest.create({
    data: { shiftId: shift.id, requestedById: ids.requester, targetUserId: ids.target, expiresAt: new Date(`${day}T00:00:00.000Z`) },
  });
  return { shiftId: shift.id, requestId: request.id };
}

async function decide(base: string, managerId: string, requestId: string, decision: 'approved' | 'denied') {
  const res = await fetch(`${base}/api/swap-requests/${requestId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${(await issueSession(managerId)).plainToken}` },
    body: JSON.stringify({ decision }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const auditRows = (requestId: string) => prisma.auditLog.count({ where: { entityType: 'ShiftSwapRequest', entityId: requestId } });

before(async () => {
  const seed = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seed, 'seed data (a location) must exist');
  locationId = (await prisma.location.create({ data: { organizationId: seed!.organizationId, name: `${TAG} venue`, timezone: 'Asia/Dubai' } })).id;
  roleId = (await prisma.role.create({ data: { locationId, name: `${TAG} role` } })).id;
  ids.requester = (await prisma.user.create({ data: { locationId, fullName: `${TAG} requester`, systemRole: 'STAFF' } })).id;
  ids.target = (await prisma.user.create({ data: { locationId, fullName: `${TAG} cover`, systemRole: 'STAFF' } })).id;
  ids.manager = (await prisma.user.create({ data: { locationId, fullName: `${TAG} manager`, systemRole: 'MANAGER' } })).id;
  ids.manager2 = (await prisma.user.create({ data: { locationId, fullName: `${TAG} manager 2`, systemRole: 'MANAGER' } })).id;
});

after(async () => {
  const userIds = Object.values(ids);
  await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.shiftSwapRequest.deleteMany({ where: { shift: { locationId } } });
  await prisma.auditLog.deleteMany({ where: { locationId } });
  await prisma.shift.deleteMany({ where: { locationId } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { locationId } });
  await prisma.role.deleteMany({ where: { locationId } });
  await prisma.location.delete({ where: { id: locationId } });
  await prisma.$disconnect();
});

test('a declined request cannot be approved afterwards: 409, the shift stays with the requester, no new audit row', async () => {
  const { shiftId, requestId } = await freshRequest();
  await withServer(async (base) => {
    assert.equal((await decide(base, ids.manager, requestId, 'denied')).status, 200);
    const audits = await auditRows(requestId);
    const again = await decide(base, ids.manager2, requestId, 'approved');
    assert.equal(again.status, 409);
    assert.equal(again.body.errorCode, 'swap_already_decided');
    assert.equal((await prisma.shiftSwapRequest.findUniqueOrThrow({ where: { id: requestId } })).status, 'DECLINED');
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })).userId, ids.requester);
    assert.equal(await auditRows(requestId), audits);
  });
});

test('an approved request cannot be declined afterwards: 409, the cover keeps the shift', async () => {
  const { shiftId, requestId } = await freshRequest();
  await withServer(async (base) => {
    assert.equal((await decide(base, ids.manager, requestId, 'approved')).status, 200);
    const again = await decide(base, ids.manager, requestId, 'denied');
    assert.equal(again.status, 409);
    const sr = await prisma.shiftSwapRequest.findUniqueOrThrow({ where: { id: requestId } });
    assert.equal(sr.status, 'APPROVED');
    assert.equal(sr.reviewedById, ids.manager);
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })).userId, ids.target);
  });
});

test('two managers deciding the same pending request at once: exactly one decision lands', async () => {
  for (let round = 0; round < 5; round++) {
    const { shiftId, requestId } = await freshRequest();
    await withServer(async (base) => {
      const [a, b] = await Promise.all([decide(base, ids.manager, requestId, 'approved'), decide(base, ids.manager2, requestId, 'denied')]);
      assert.deepEqual([a.status, b.status].sort(), [200, 409], `round ${round}: ${a.status}/${b.status}`);
      const sr = await prisma.shiftSwapRequest.findUniqueOrThrow({ where: { id: requestId } });
      const owner = (await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })).userId;
      if (a.status === 200) {
        assert.equal(sr.status, 'APPROVED');
        assert.equal(owner, ids.target);
      } else {
        assert.equal(sr.status, 'DECLINED');
        assert.equal(owner, ids.requester);
      }
      assert.equal(await auditRows(requestId), 1, 'one audit row for the one decision');
    });
  }
});
