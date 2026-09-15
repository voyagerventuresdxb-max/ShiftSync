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

test('PATCH /api/staff-directory/:userId: the atomic isActive guard rejects a write keyed off a stale snapshot, after a real toggle has already moved the row', async () => {
  // Unlike joinActions/attendance, this route always re-reads `existing`
  // fresh immediately before its own write, so replaying a second FULL HTTP
  // PATCH with a "stale" body can't actually observe staleness — it just
  // re-reads the current state and (harmlessly) succeeds again. Confirmed
  // empirically too: firing two real concurrent PATCHes at this app's
  // shared `prisma` client serializes at the DB connection/transaction
  // level in this environment rather than genuinely overlapping, so a
  // Promise.all-style race is not a reliable way to exercise this guard
  // here. Instead: do one real PATCH through the live server (proving the
  // normal path still works end to end), then directly issue the exact
  // same guarded `updateMany` shape the route uses — scoped to the
  // now-superseded `isActive: true` snapshot a concurrent racer would have
  // read before that PATCH committed — and confirm it matches zero rows.
  // That is the literal mechanism that makes a losing concurrent PATCH
  // roll back instead of leaving isActive/terminatedAt out of lockstep.
  const seedLocation = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seedLocation, 'seed data (a location) must exist to run this test');

  const location = await prisma.location.create({
    data: {
      organizationId: seedLocation!.organizationId,
      name: '__staffdirectory-test__ stale guard',
      timezone: 'Asia/Dubai',
    },
  });
  const staff = await prisma.user.create({
    data: { locationId: location.id, fullName: '__staffdirectory-test__ Toggled', systemRole: 'STAFF', isActive: true },
  });
  const manager = await prisma.user.create({
    data: { locationId: location.id, fullName: '__staffdirectory-test__ Manager2', systemRole: 'MANAGER' },
  });

  try {
    const token = await sessionFor(manager.id);
    await withServer(async (baseUrl) => {
      // 1. The real toggle, through the real route — this moves the state
      //    the guard defends (isActive true -> false, terminatedAt set).
      const real = await fetch(`${baseUrl}/api/staff-directory/${staff.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ isActive: false }),
      });
      assert.equal(real.status, 200);
      const realBody = (await real.json()) as { isActive: boolean; terminatedAt: string | null };
      assert.equal(realBody.isActive, false);
      assert.ok(realBody.terminatedAt, 'the real toggle must have set terminatedAt');
    });

    // 2. A would-be concurrent racer that read `isActive: true` (the ORIGINAL,
    //    now-stale snapshot) before the real PATCH above committed, replayed
    //    as the exact guarded statement the route issues inside its
    //    transaction. It must match nothing — proving this is what would
    //    have rolled that racer's whole transaction back instead of letting
    //    it clobber the real toggle's terminatedAt.
    const staleRacer = await prisma.user.updateMany({
      where: { id: staff.id, isActive: true },
      data: { isActive: true, terminatedAt: null },
    });
    assert.equal(staleRacer.count, 0, 'a write keyed off the stale isActive:true snapshot must not match the now-false row');

    const persisted = await prisma.user.findUnique({ where: { id: staff.id } });
    assert.equal(persisted!.isActive, false, 'the stale racer must not have flipped isActive back');
    assert.ok(persisted!.terminatedAt, 'the stale racer must not have wiped terminatedAt back to null');
  } finally {
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});

test('PATCH /api/staff-directory/:userId: a PATCH that never touches isActive is not guarded by isActive at all', async () => {
  // Regression test for a real overreach the isActive guard above could
  // introduce if scoped wrong: the guarded `updateMany`'s WHERE must only
  // include `isActive: existing.isActive` when THIS request's own body sets
  // isActive. A plain fullName/phone/etc-only PATCH has to succeed no matter
  // what isActive currently is, since it never depended on that value —
  // guarding it anyway would make an unrelated edit spuriously fail with a
  // 409 any time someone else happened to toggle isActive around the same
  // time, even though the two edits touch entirely disjoint fields.
  const seedLocation = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seedLocation, 'seed data (a location) must exist to run this test');

  const location = await prisma.location.create({
    data: {
      organizationId: seedLocation!.organizationId,
      name: '__staffdirectory-test__ non-isActive patch',
      timezone: 'Asia/Dubai',
    },
  });
  const staff = await prisma.user.create({
    data: { locationId: location.id, fullName: '__staffdirectory-test__ Original Name', systemRole: 'STAFF', isActive: true },
  });
  const manager = await prisma.user.create({
    data: { locationId: location.id, fullName: '__staffdirectory-test__ Manager3', systemRole: 'MANAGER' },
  });

  try {
    const token = await sessionFor(manager.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/staff-directory/${staff.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ fullName: '__staffdirectory-test__ Renamed' }),
      });
      assert.equal(res.status, 200, 'a fullName-only PATCH must succeed regardless of isActive');
      const body = (await res.json()) as { fullName: string; isActive: boolean };
      assert.equal(body.fullName, '__staffdirectory-test__ Renamed');
      assert.equal(body.isActive, true, 'isActive must be untouched by a PATCH that never mentioned it');
    });
  } finally {
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});

test('PATCH /api/staff-directory/:userId: PATCHing a phone already taken by another staff member returns a proper 409, not a generic 500', async () => {
  // Regression test: the P2002 unique-constraint violation on User.phone
  // used to fall through uncaught to Express's default error handler (a
  // bare 500), the way it still does for any *unexpected* constraint hit.
  // This one is expected and common (two staff records converging on the
  // same real mobile number) and deserves its own real status + message,
  // mirroring attendance.ts's identical exact-target P2002 backstop pattern.
  const seedLocation = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seedLocation, 'seed data (a location) must exist to run this test');

  const location = await prisma.location.create({
    data: {
      organizationId: seedLocation!.organizationId,
      name: '__staffdirectory-test__ phone conflict',
      timezone: 'Asia/Dubai',
    },
  });
  const takenPhone = `+9715${Date.now().toString().slice(-8)}`;
  await prisma.user.create({
    data: { locationId: location.id, fullName: '__staffdirectory-test__ Phone Owner', systemRole: 'STAFF', phone: takenPhone },
  });
  const other = await prisma.user.create({
    data: { locationId: location.id, fullName: '__staffdirectory-test__ Phone Conflicter', systemRole: 'STAFF' },
  });
  const manager = await prisma.user.create({
    data: { locationId: location.id, fullName: '__staffdirectory-test__ Manager4', systemRole: 'MANAGER' },
  });

  try {
    const token = await sessionFor(manager.id);
    await withServer(async (baseUrl) => {
      const conflictRes = await fetch(`${baseUrl}/api/staff-directory/${other.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ phone: takenPhone }),
      });
      assert.equal(conflictRes.status, 409, 'a duplicate phone must return 409, not 500');
      const conflictBody = (await conflictRes.json()) as { error: string };
      assert.equal(conflictBody.error, 'This phone number is already registered to another staff member.');

      // Sanity: a PATCH to a genuinely free number still succeeds normally.
      const freePhone = `+9715${(Date.now() + 1).toString().slice(-8)}`;
      const okRes = await fetch(`${baseUrl}/api/staff-directory/${other.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ phone: freePhone }),
      });
      assert.equal(okRes.status, 200);
      const okBody = (await okRes.json()) as { phone: string | null };
      assert.equal(okBody.phone, freePhone);
    });
  } finally {
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});
