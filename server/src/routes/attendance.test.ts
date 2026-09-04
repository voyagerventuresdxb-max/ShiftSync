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

test('POST /api/attendance/clock-in rejects a second clock-in while one is already open — no double open AttendanceLog', async () => {
  const seedLocation = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seedLocation, 'seed data (a location) must exist to run this test');

  const location = await prisma.location.create({
    data: {
      organizationId: seedLocation!.organizationId,
      name: '__attendance-test__ double clock-in',
      timezone: 'Asia/Dubai',
    },
  });
  const staff = await prisma.user.create({
    data: { locationId: location.id, fullName: '__attendance-test__ Server', systemRole: 'STAFF' },
  });

  try {
    const token = await sessionFor(staff.id);
    await withServer(async (baseUrl) => {
      const clockIn = () =>
        fetch(`${baseUrl}/api/attendance/clock-in`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({}),
        });

      // 1. Clock in once, for real — this moves the state the guard defends
      //    (an open AttendanceLog for this user now exists).
      const first = await clockIn();
      assert.equal(first.status, 201);
      const firstBody = (await first.json()) as { id: string; clockOutAt: string | null };
      assert.equal(firstBody.clockOutAt, null);

      // 2. Clock in again with the ORIGINAL stale expectation (no open log)
      //    a naive caller might have started from. The guard re-checked
      //    inside the transaction must find the open log and reject this
      //    as a conflict, not create a second open AttendanceLog.
      const second = await clockIn();
      assert.equal(second.status, 409, 'a second clock-in while one is already open must be rejected');

      const openLogs = await prisma.attendanceLog.findMany({ where: { userId: staff.id, clockOutAt: null } });
      assert.equal(openLogs.length, 1, 'the losing call must not have created a second open AttendanceLog');
      assert.equal(openLogs[0]!.id, firstBody.id, 'the one open log must still be the FIRST call\'s row');
    });
  } finally {
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});
