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

test('POST /api/availability upserts the mark AND writes a matching AVAILABILITY_MARKED audit-log row', async () => {
  const seedLocation = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seedLocation, 'seed data (a location) must exist to run this test');

  const location = await prisma.location.create({
    data: {
      organizationId: seedLocation!.organizationId,
      name: '__availability-test__ audit',
      timezone: 'Asia/Dubai',
    },
  });
  const staff = await prisma.user.create({
    data: { locationId: location.id, fullName: '__availability-test__ Staff', systemRole: 'STAFF' },
  });

  try {
    const token = await sessionFor(staff.id);
    await withServer(async (baseUrl) => {
      const beforeCount = await prisma.auditLog.count({ where: { locationId: location.id, action: 'AVAILABILITY_MARKED' } });

      const res = await fetch(`${baseUrl}/api/availability`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ date: '2031-05-01', type: 'UNAVAILABLE', note: 'dentist' }),
      });
      assert.equal(res.status, 201);
      const body = (await res.json()) as { id: string; date: string; type: string; note: string | null };

      // The mark-upsert behavior itself is unchanged: the row exists with
      // the right fields.
      const mark = await prisma.availabilityMark.findUnique({ where: { id: body.id } });
      assert.ok(mark, 'the availability mark must have been created');
      assert.equal(mark!.userId, staff.id);
      assert.equal(mark!.type, 'UNAVAILABLE');
      assert.equal(mark!.note, 'dentist');

      // The new behavior under test: exactly one AVAILABILITY_MARKED audit
      // row now exists, matching the mark, the actor, and the location.
      const afterCount = await prisma.auditLog.count({ where: { locationId: location.id, action: 'AVAILABILITY_MARKED' } });
      assert.equal(afterCount, beforeCount + 1, 'exactly one AVAILABILITY_MARKED audit row must be written');

      const auditRow = await prisma.auditLog.findFirst({
        where: { locationId: location.id, action: 'AVAILABILITY_MARKED', entityId: body.id },
      });
      assert.ok(auditRow, 'the audit row must reference the created mark by entityId');
      assert.equal(auditRow!.entityType, 'AvailabilityMark');
      assert.equal(auditRow!.actorId, staff.id);
      assert.equal(auditRow!.locationId, location.id);
      assert.equal(auditRow!.note, 'dentist');
    });
  } finally {
    await prisma.auditLog.deleteMany({ where: { locationId: location.id } }).catch(() => {});
    await prisma.availabilityMark.deleteMany({ where: { userId: staff.id } }).catch(() => {});
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});

test("GET /api/availability?weekStart= returns every mark at the caller's venue that week (people with no shift included), managers only", async () => {
  const seedLocation = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seedLocation, 'seed data (a location) must exist to run this test');
  const mkLocation = (label: string) =>
    prisma.location.create({ data: { organizationId: seedLocation!.organizationId, name: `__availability-test__ ${label}`, timezone: 'Asia/Dubai' } });
  const venue = await mkLocation('venue week');
  const other = await mkLocation('other venue');
  const manager = await prisma.user.create({ data: { locationId: venue.id, fullName: '__availability-test__ manager', systemRole: 'MANAGER' } });
  const staff = await prisma.user.create({ data: { locationId: venue.id, fullName: '__availability-test__ no shift yet', systemRole: 'STAFF' } });
  const outsider = await prisma.user.create({ data: { locationId: other.id, fullName: '__availability-test__ outsider', systemRole: 'STAFF' } });
  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
  await prisma.availabilityMark.createMany({
    data: [
      { userId: staff.id, date: day('2031-03-04'), type: 'UNAVAILABLE', note: 'exam' },
      { userId: staff.id, date: day('2031-03-11'), type: 'PREFERRED_OFF' },
      { userId: outsider.id, date: day('2031-03-04'), type: 'UNAVAILABLE' },
    ],
  });
  try {
    const managerToken = await sessionFor(manager.id);
    const staffToken = await sessionFor(staff.id);
    await withServer(async (baseUrl) => {
      const get = (token: string | null, query: string) =>
        fetch(`${baseUrl}/api/availability${query}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      const res = await get(managerToken, '?weekStart=2031-03-03');
      assert.equal(res.status, 200);
      const { marks } = (await res.json()) as { marks: { userId: string; date: string; type: string; note: string | null }[] };
      assert.deepEqual(
        marks.map(({ userId, date, type, note }) => ({ userId, date, type, note })),
        [{ userId: staff.id, date: '2031-03-04', type: 'UNAVAILABLE', note: 'exam' }],
        "only this venue's marks, only that week",
      );
      assert.equal((await get(managerToken, '?weekStart=nope')).status, 400);
      assert.equal((await get(staffToken, '?weekStart=2031-03-03')).status, 403, 'staff read their own marks per user, not the whole venue');
      assert.equal((await get(null, '?weekStart=2031-03-03')).status, 401);
    });
  } finally {
    await prisma.availabilityMark.deleteMany({ where: { userId: { in: [staff.id, outsider.id] } } });
    await prisma.user.deleteMany({ where: { locationId: { in: [venue.id, other.id] } } });
    await prisma.location.deleteMany({ where: { id: { in: [venue.id, other.id] } } });
  }
});
