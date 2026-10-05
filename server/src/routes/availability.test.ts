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

test("DELETE /api/availability/:id answers someone else's mark exactly like a missing one (404), and the owner can delete it", async () => {
  const seedLocation = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seedLocation, 'seed data (a location) must exist to run this test');
  const location = await prisma.location.create({
    data: { organizationId: seedLocation!.organizationId, name: '__availability-test__ delete', timezone: 'Asia/Dubai' },
  });
  const owner = await prisma.user.create({ data: { locationId: location.id, fullName: '__availability-test__ Owner of mark', systemRole: 'STAFF' } });
  const other = await prisma.user.create({ data: { locationId: location.id, fullName: '__availability-test__ Other', systemRole: 'STAFF' } });
  const mark = await prisma.availabilityMark.create({ data: { userId: owner.id, date: new Date('2031-05-02T00:00:00.000Z'), type: 'UNAVAILABLE' } });

  try {
    await withServer(async (baseUrl) => {
      const del = async (userId: string, id: string) => {
        const res = await fetch(`${baseUrl}/api/availability/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${await sessionFor(userId)}` } });
        return { status: res.status, body: res.status === 204 ? '' : await res.text() };
      };
      const someoneElses = await del(other.id, mark.id);
      const missing = await del(other.id, '00000000-0000-0000-0000-000000000000');
      assert.equal(someoneElses.status, 404);
      assert.deepEqual(someoneElses, missing, 'no difference between "not yours" and "does not exist"');
      assert.ok(await prisma.availabilityMark.findUnique({ where: { id: mark.id } }), 'the mark is untouched');

      assert.equal((await del(owner.id, mark.id)).status, 204);
      assert.equal(await prisma.availabilityMark.findUnique({ where: { id: mark.id } }), null);
    });
  } finally {
    await prisma.availabilityMark.deleteMany({ where: { userId: { in: [owner.id, other.id] } } }).catch(() => {});
    await prisma.session.deleteMany({ where: { userId: { in: [owner.id, other.id] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, other.id] } } }).catch(() => {});
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});
