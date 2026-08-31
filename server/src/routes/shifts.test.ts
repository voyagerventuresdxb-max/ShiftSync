import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../app.js';
import { issueSession } from '../lib/identity.js';

const prisma = new PrismaClient();

/** Starts the real Express app on an ephemeral port and hands the caller its base URL. */
async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = createApp();
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Issues a real bearer session token for a real User, exactly like a login would. */
async function sessionFor(userId: string): Promise<string> {
  const { plainToken } = await issueSession(userId);
  return plainToken;
}

test('PATCH /api/shifts/:id rejects a roleId that belongs to a different location (404, not a raw FK 500)', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  const role = await prisma.role.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && role, 'seed data (location + role) must exist to run this test');

  // A role that genuinely exists — just not in this shift's location.
  const otherLocation = await prisma.location.create({
    data: { organizationId: location!.organizationId, name: '__task2-test__ other venue', timezone: 'Asia/Dubai' },
  });
  const otherRole = await prisma.role.create({ data: { locationId: otherLocation.id, name: '__task2-test__ cross-location role' } });
  const manager = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task2-test__ manager', systemRole: 'MANAGER' },
  });

  const shift = await prisma.shift.create({
    data: {
      locationId: location!.id,
      roleId: role!.id,
      date: new Date('2026-08-24T00:00:00.000Z'),
      startTime: new Date('2026-08-24T05:00:00.000Z'),
      endTime: new Date('2026-08-24T13:00:00.000Z'),
      status: 'DRAFT',
    },
  });

  try {
    const token = await sessionFor(manager.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/shifts/${shift.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ roleId: otherRole.id }),
      });
      assert.equal(res.status, 404, 'a role from a different location must be rejected with 404, not applied or 500ed');
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /not found/i);
    });

    // Confirm the shift's roleId was never actually changed.
    const unchanged = await prisma.shift.findUnique({ where: { id: shift.id } });
    assert.equal(unchanged!.roleId, role!.id, 'the invalid PATCH must not have mutated the shift');
  } finally {
    await prisma.shift.delete({ where: { id: shift.id } }).catch(() => {});
    await prisma.role.delete({ where: { id: otherRole.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
    await prisma.location.delete({ where: { id: otherLocation.id } }).catch(() => {});
  }
});

test('PATCH /api/shifts/:id rejects a userId that belongs to a different location (404)', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  const role = await prisma.role.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && role, 'seed data (location + role) must exist to run this test');

  const otherLocation = await prisma.location.create({
    data: { organizationId: location!.organizationId, name: '__task2-test__ other venue 2', timezone: 'Asia/Dubai' },
  });
  const otherUser = await prisma.user.create({
    data: { locationId: otherLocation.id, fullName: '__task2-test__ Cross-Location Staff', systemRole: 'STAFF' },
  });
  const manager = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task2-test__ manager 2', systemRole: 'MANAGER' },
  });

  const shift = await prisma.shift.create({
    data: {
      locationId: location!.id,
      roleId: role!.id,
      date: new Date('2026-08-24T00:00:00.000Z'),
      startTime: new Date('2026-08-24T05:00:00.000Z'),
      endTime: new Date('2026-08-24T13:00:00.000Z'),
      status: 'DRAFT',
    },
  });

  try {
    const token = await sessionFor(manager.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/shifts/${shift.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ userId: otherUser.id }),
      });
      assert.equal(res.status, 404, 'a user from a different location must be rejected with 404');
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /not found/i);
    });
  } finally {
    await prisma.shift.delete({ where: { id: shift.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: otherUser.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
    await prisma.location.delete({ where: { id: otherLocation.id } }).catch(() => {});
  }
});

test('POST /api/shifts/bulk rejects the whole batch when one row references a roleId from a different location', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  const role = await prisma.role.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && role, 'seed data (location + role) must exist to run this test');

  const otherLocation = await prisma.location.create({
    data: { organizationId: location!.organizationId, name: '__task2-test__ other venue 3', timezone: 'Asia/Dubai' },
  });
  const otherRole = await prisma.role.create({ data: { locationId: otherLocation.id, name: '__task2-test__ cross-location role 2' } });
  const manager = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task2-test__ manager 3', systemRole: 'MANAGER' },
  });

  // A marker date unlikely to collide with real seed data, so we can assert
  // nothing at all landed in the DB even for the batch's otherwise-valid row.
  const markerDate = '2031-03-03';

  try {
    const token = await sessionFor(manager.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/shifts/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          shifts: [
            { roleId: role!.id, date: markerDate, start: '09:00', end: '17:00' }, // valid
            { roleId: otherRole.id, date: markerDate, start: '10:00', end: '18:00' }, // invalid: wrong location
          ],
        }),
      });
      assert.equal(res.status, 404, 'one bad roleId in the batch must reject the whole request');
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /not found/i);
    });

    const leaked = await prisma.shift.findMany({ where: { locationId: location!.id, date: new Date(`${markerDate}T00:00:00.000Z`) } });
    assert.equal(leaked.length, 0, 'no row from the rejected batch — including the otherwise-valid one — should have been committed');
  } finally {
    await prisma.shift.deleteMany({ where: { locationId: location!.id, date: new Date(`${markerDate}T00:00:00.000Z`) } });
    await prisma.role.delete({ where: { id: otherRole.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
    await prisma.location.delete({ where: { id: otherLocation.id } }).catch(() => {});
  }
});
