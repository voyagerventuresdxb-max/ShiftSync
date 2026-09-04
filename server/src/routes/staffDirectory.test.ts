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

test('GET /api/staff-directory/:locationId redacts personal fields for a STAFF caller but not for a MANAGER', async () => {
  const seedLocation = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seedLocation, 'seed data (a location) must exist to run this test');

  const location = await prisma.location.create({
    data: {
      organizationId: seedLocation!.organizationId,
      name: '__staffdirectory-test__ redaction',
      timezone: 'Asia/Dubai',
    },
  });
  const staff = await prisma.user.create({
    data: {
      locationId: location.id,
      fullName: '__staffdirectory-test__ Server',
      systemRole: 'STAFF',
      phone: '+971500000001',
      preferredLanguage: 'ur',
      hiredAt: new Date('2025-01-01T00:00:00.000Z'),
      isActive: false,
      terminatedAt: new Date('2025-06-01T00:00:00.000Z'),
    },
  });
  const manager = await prisma.user.create({
    data: { locationId: location.id, fullName: '__staffdirectory-test__ Manager', systemRole: 'MANAGER' },
  });

  try {
    await withServer(async (baseUrl) => {
      const staffToken = await sessionFor(staff.id);
      const staffRes = await fetch(`${baseUrl}/api/staff-directory/${location.id}`, {
        headers: { Authorization: `Bearer ${staffToken}` },
      });
      assert.equal(staffRes.status, 200);
      const staffBody = (await staffRes.json()) as { staff: Array<Record<string, unknown>> };
      const seenByStaff = staffBody.staff.find((u) => u.id === staff.id);
      assert.ok(seenByStaff, 'the STAFF caller should still see the roster entry itself');
      assert.equal(seenByStaff!.phone, null);
      assert.equal(seenByStaff!.preferredLanguage, null);
      assert.equal(seenByStaff!.hiredAt, null);
      assert.equal(seenByStaff!.terminatedAt, null);
      assert.equal(seenByStaff!.fullName, staff.fullName, 'non-personal fields stay intact');

      const managerToken = await sessionFor(manager.id);
      const managerRes = await fetch(`${baseUrl}/api/staff-directory/${location.id}`, {
        headers: { Authorization: `Bearer ${managerToken}` },
      });
      assert.equal(managerRes.status, 200);
      const managerBody = (await managerRes.json()) as { staff: Array<Record<string, unknown>> };
      const seenByManager = managerBody.staff.find((u) => u.id === staff.id);
      assert.ok(seenByManager);
      assert.equal(seenByManager!.phone, '+971500000001');
      assert.equal(seenByManager!.preferredLanguage, 'ur');
      assert.equal(seenByManager!.hiredAt, '2025-01-01');
      assert.equal(seenByManager!.terminatedAt, '2025-06-01');
    });
  } finally {
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});
