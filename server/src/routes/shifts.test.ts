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

// 2026-09-05 — a whole-branch review found every mutation route below was
// requireSession-only, with no requireManager check at all: any signed-in
// STAFF session could create, edit, delete, bulk-create, or publish shifts
// at their own venue via a direct API call, including a coworker's — the
// Shift Editor's own client renders these controls with no role check of
// its own either, so this was reachable through the real UI, not just a
// crafted request. These prove the fix: every one of the 5 routes now
// rejects a real STAFF session with a clean 403, not a raw 500 and not a
// silent success.
test('shifts.ts mutation routes reject a real STAFF session with 403 — POST /, PATCH /:id, DELETE /:id, POST /bulk, POST /:locationId/publish', async () => {
  const seedLocation = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seedLocation, 'seed data (a location) must exist to run this test');

  const location = await prisma.location.create({
    data: { organizationId: seedLocation!.organizationId, name: '__task2-test__ requireManager gate', timezone: 'Asia/Dubai' },
  });
  const role = await prisma.role.create({ data: { locationId: location.id, name: '__task2-test__ requireManager role' } });
  const manager = await prisma.user.create({
    data: { locationId: location.id, fullName: '__task2-test__ requireManager owner', systemRole: 'MANAGER' },
  });
  const staff = await prisma.user.create({
    data: { locationId: location.id, fullName: '__task2-test__ requireManager staff', systemRole: 'STAFF' },
  });
  // A real shift a MANAGER owns, to attempt PATCH/DELETE against as STAFF.
  const shift = await prisma.shift.create({
    data: {
      locationId: location.id,
      roleId: role.id,
      date: new Date('2026-08-24T00:00:00.000Z'),
      startTime: new Date('2026-08-24T05:00:00.000Z'),
      endTime: new Date('2026-08-24T13:00:00.000Z'),
      status: 'DRAFT',
    },
  });

  try {
    const staffToken = await sessionFor(staff.id);
    await withServer(async (baseUrl) => {
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${staffToken}` };

      const post = await fetch(`${baseUrl}/api/shifts`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ roleId: role.id, date: '2031-04-04', start: '09:00', end: '17:00' }),
      });
      assert.equal(post.status, 403, 'POST / must reject a STAFF session');

      const patch = await fetch(`${baseUrl}/api/shifts/${shift.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ breakMinutes: 45 }),
      });
      assert.equal(patch.status, 403, 'PATCH /:id must reject a STAFF session');

      const del = await fetch(`${baseUrl}/api/shifts/${shift.id}`, { method: 'DELETE', headers });
      assert.equal(del.status, 403, 'DELETE /:id must reject a STAFF session');

      const bulk = await fetch(`${baseUrl}/api/shifts/bulk`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ shifts: [{ roleId: role.id, date: '2031-04-04', start: '09:00', end: '17:00' }] }),
      });
      assert.equal(bulk.status, 403, 'POST /bulk must reject a STAFF session');

      const publish = await fetch(`${baseUrl}/api/shifts/${location.id}/publish`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ weekStart: '2031-04-01' }),
      });
      assert.equal(publish.status, 403, 'POST /:locationId/publish must reject a STAFF session');
    });

    // Nothing any of the rejected calls attempted should have actually landed.
    const persisted = await prisma.shift.findMany({ where: { locationId: location.id } });
    assert.equal(persisted.length, 1, 'only the original manager-created shift should exist — no STAFF mutation attempt should have succeeded');
    assert.equal(persisted[0]!.id, shift.id);
    assert.equal(persisted[0]!.breakMinutes, 0, 'the rejected PATCH must not have applied its breakMinutes change');
  } finally {
    await prisma.shift.deleteMany({ where: { locationId: location.id } });
    await prisma.role.delete({ where: { id: role.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: staff.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});

// Companion to the STAFF-403 test above: proves adding `requireManager`
// didn't also break the LEGITIMATE case. PATCH /:id and POST /bulk already
// get manager-session coverage from the two pre-existing tests earlier in
// this file; this covers the three routes that didn't otherwise have any
// manager-session assertion — POST /, DELETE /:id, POST /:locationId/publish
// — so a middleware-ordering mistake (e.g. requireManager placed before
// requireSession, leaving req.user undefined for everyone) would fail here
// instead of only showing up as a real manager's report that shift
// creation/deletion/publishing silently stopped working.
test('shifts.ts mutation routes still work normally for a real MANAGER session — POST /, DELETE /:id, POST /:locationId/publish', async () => {
  const seedLocation = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seedLocation, 'seed data (a location) must exist to run this test');

  const location = await prisma.location.create({
    data: { organizationId: seedLocation!.organizationId, name: '__task2-test__ requireManager still works', timezone: 'Asia/Dubai' },
  });
  const role = await prisma.role.create({ data: { locationId: location.id, name: '__task2-test__ requireManager works role' } });
  const manager = await prisma.user.create({
    data: { locationId: location.id, fullName: '__task2-test__ requireManager works manager', systemRole: 'MANAGER' },
  });
  const weekStart = '2031-06-02'; // a Monday, isolated from other tests' fixture dates

  try {
    const token = await sessionFor(manager.id);
    let shiftId = '';
    await withServer(async (baseUrl) => {
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

      const post = await fetch(`${baseUrl}/api/shifts`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ roleId: role.id, date: weekStart, start: '09:00', end: '17:00' }),
      });
      assert.equal(post.status, 201, 'a real manager session must still be able to create a shift');
      const postBody = (await post.json()) as { shift: { id: string } };
      shiftId = postBody.shift.id;

      const publish = await fetch(`${baseUrl}/api/shifts/${location.id}/publish`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ weekStart }),
      });
      assert.equal(publish.status, 200, 'a real manager session must still be able to publish the week');

      const del = await fetch(`${baseUrl}/api/shifts/${shiftId}`, { method: 'DELETE', headers });
      assert.equal(del.status, 204, 'a real manager session must still be able to delete a shift');
    });

    const remaining = await prisma.shift.findMany({ where: { locationId: location.id } });
    assert.equal(remaining.length, 0, 'the created-then-deleted shift should leave nothing behind');
  } finally {
    await prisma.shift.deleteMany({ where: { locationId: location.id } });
    await prisma.rotaPublish.deleteMany({ where: { locationId: location.id } });
    await prisma.role.delete({ where: { id: role.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});

// 2026-09-05 — found by the performance audit: publish used to fetch every
// column of every shift in the week just to check non-emptiness and count
// distinct assigned users, replaced with prisma.shift.count() + a
// distinct-select query. This proves the rewrite preserves the exact same
// notifiedCount semantics: two shifts assigned to the SAME user count once,
// an unassigned (userId: null) shift doesn't count at all.
test('shifts.ts POST /:locationId/publish computes notifiedCount as distinct assigned users, not total shifts', async () => {
  const seedLocation = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seedLocation, 'seed data (a location) must exist to run this test');

  const location = await prisma.location.create({
    data: { organizationId: seedLocation!.organizationId, name: '__perfaudit-test__ publish notifiedCount', timezone: 'Asia/Dubai' },
  });
  const role = await prisma.role.create({ data: { locationId: location.id, name: '__perfaudit-test__ role' } });
  const manager = await prisma.user.create({
    data: { locationId: location.id, fullName: '__perfaudit-test__ manager', systemRole: 'MANAGER' },
  });
  const staffA = await prisma.user.create({ data: { locationId: location.id, fullName: '__perfaudit-test__ staff A', systemRole: 'STAFF' } });
  const staffB = await prisma.user.create({ data: { locationId: location.id, fullName: '__perfaudit-test__ staff B', systemRole: 'STAFF' } });
  const weekStart = '2031-07-07'; // a Monday, isolated from other tests' fixture dates

  const makeShift = (userId: string | null, dayOffset: number) => {
    const date = new Date(`${weekStart}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + dayOffset);
    return prisma.shift.create({
      data: {
        locationId: location.id,
        roleId: role.id,
        userId,
        date,
        startTime: new Date(`${date.toISOString().slice(0, 10)}T09:00:00.000Z`),
        endTime: new Date(`${date.toISOString().slice(0, 10)}T17:00:00.000Z`),
        status: 'DRAFT',
      },
    });
  };

  try {
    // staffA gets 2 shifts (same user, different days), staffB gets 1, one shift is unassigned.
    await Promise.all([makeShift(staffA.id, 0), makeShift(staffA.id, 1), makeShift(staffB.id, 2), makeShift(null, 3)]);

    const token = await sessionFor(manager.id);
    await withServer(async (baseUrl) => {
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
      const publish = await fetch(`${baseUrl}/api/shifts/${location.id}/publish`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ weekStart }),
      });
      assert.equal(publish.status, 200);
      const body = (await publish.json()) as { notifiedCount: number };
      assert.equal(body.notifiedCount, 2, 'staffA (2 shifts) + staffB (1 shift) = 2 distinct users; the unassigned shift must not count');
    });
  } finally {
    await prisma.shift.deleteMany({ where: { locationId: location.id } });
    await prisma.rotaPublish.deleteMany({ where: { locationId: location.id } });
    await prisma.role.delete({ where: { id: role.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: staffA.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: staffB.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});
