import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../app.js';
import { createOtpCode, hashOtp, issueSession, resolveSession } from '../lib/identity.js';

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
  // The caller has to be active: a deactivated user's session no longer authenticates.
  const viewer = await prisma.user.create({
    data: { locationId: location.id, fullName: '__staffdirectory-test__ Viewer', systemRole: 'STAFF' },
  });

  try {
    await withServer(async (baseUrl) => {
      const staffToken = await sessionFor(viewer.id);
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
  const takenPhone = `+97150${Date.now().toString().slice(-7)}`; // 050: an assigned UAE mobile range
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
      const freePhone = `+97150${(Date.now() + 1).toString().slice(-7)}`;
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

test('POST /api/staff-directory: optional phone is stored as E.164, invalid is a 400, a number any User holds is a 409, blank creates with no phone', async () => {
  const seedLocation = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seedLocation, 'seed data (a location) must exist to run this test');
  const location = await prisma.location.create({
    data: { organizationId: seedLocation!.organizationId, name: '__staffdirectory-test__ add phone', timezone: 'Asia/Dubai' },
  });
  const other = await prisma.location.create({
    data: { organizationId: seedLocation!.organizationId, name: '__staffdirectory-test__ add phone other', timezone: 'Asia/Dubai' },
  });
  const manager = await prisma.user.create({ data: { locationId: location.id, fullName: '__staffdirectory-test__ Manager P', systemRole: 'MANAGER' } });
  const digits = Date.now().toString().slice(-7);
  const freeLocal = `056 ${digits.slice(0, 3)} ${digits.slice(3)}`;
  const freeE164 = `+97156${digits}`;
  const takenDigits = ((Number(digits) + 1) % 10_000_000).toString().padStart(7, '0');
  // Deactivated and at another venue: the unique index still covers it.
  await prisma.user.create({
    data: { locationId: other.id, fullName: '__staffdirectory-test__ Holder', systemRole: 'STAFF', phone: `+97156${takenDigits}`, isActive: false },
  });
  try {
    await withServer(async (baseUrl) => {
      const token = await sessionFor(manager.id);
      const post = (body: Record<string, unknown>) =>
        fetch(`${baseUrl}/api/staff-directory`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });

      const ok = await post({ fullName: '__staffdirectory-test__ With Phone', phone: freeLocal });
      assert.equal(ok.status, 201);
      assert.equal(((await ok.json()) as { phone: string | null }).phone, freeE164);
      assert.equal((await prisma.user.findUnique({ where: { phone: freeE164 } }))?.locationId, location.id);

      const invalid = await post({ fullName: '__staffdirectory-test__ Bad Phone', phone: '12345' });
      assert.equal(invalid.status, 400);
      assert.equal(((await invalid.json()) as { error: string }).error, 'Enter a valid mobile number, e.g. 050 123 4567 or +971 50 123 4567.');

      const dup = await post({ fullName: '__staffdirectory-test__ Dup Phone', phone: `056${takenDigits}` });
      assert.equal(dup.status, 409);
      assert.equal(((await dup.json()) as { error: string }).error, 'This phone number is already registered to another staff member.');
      assert.equal(await prisma.user.count({ where: { fullName: '__staffdirectory-test__ Dup Phone' } }), 0, 'the refused add must not have created anyone');

      const blank = await post({ fullName: '__staffdirectory-test__ No Phone', phone: '' });
      assert.equal(blank.status, 201);
      assert.equal(((await blank.json()) as { phone: string | null }).phone, null);
    });
  } finally {
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
    await prisma.location.delete({ where: { id: other.id } }).catch(() => {});
  }
});

test('PATCH /api/staff-directory/:userId: roleId assigns one of the venue\'s active roles, null unassigns, another venue\'s role is a 404', async () => {
  const seedLocation = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seedLocation, 'seed data (a location) must exist to run this test');
  const location = await prisma.location.create({
    data: { organizationId: seedLocation!.organizationId, name: '__staffdirectory-test__ roles', timezone: 'Asia/Dubai' },
  });
  const other = await prisma.location.create({
    data: { organizationId: seedLocation!.organizationId, name: '__staffdirectory-test__ roles other', timezone: 'Asia/Dubai' },
  });
  const role = await prisma.role.create({ data: { locationId: location.id, name: 'Host' } });
  const foreignRole = await prisma.role.create({ data: { locationId: other.id, name: 'Host' } });
  const staff = await prisma.user.create({ data: { locationId: location.id, fullName: '__staffdirectory-test__ Roled', systemRole: 'STAFF' } });
  const manager = await prisma.user.create({ data: { locationId: location.id, fullName: '__staffdirectory-test__ Manager R', systemRole: 'MANAGER' } });
  try {
    await withServer(async (baseUrl) => {
      const token = await sessionFor(manager.id);
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
      const assign = await fetch(`${baseUrl}/api/staff-directory/${staff.id}`, { method: 'PATCH', headers, body: JSON.stringify({ roleId: role.id }) });
      assert.equal(assign.status, 200);
      const assigned = (await assign.json()) as { roleId: string | null; roleName: string | null };
      assert.equal(assigned.roleId, role.id);
      assert.equal(assigned.roleName, 'Host');

      const foreign = await fetch(`${baseUrl}/api/staff-directory/${staff.id}`, { method: 'PATCH', headers, body: JSON.stringify({ roleId: foreignRole.id }) });
      assert.equal(foreign.status, 404, "another venue's role must not be assignable");
      assert.equal((await prisma.user.findUnique({ where: { id: staff.id } }))?.roleId, role.id, 'the refused write must not have landed');

      const clear = await fetch(`${baseUrl}/api/staff-directory/${staff.id}`, { method: 'PATCH', headers, body: JSON.stringify({ roleId: null }) });
      assert.equal(clear.status, 200);
      assert.equal(((await clear.json()) as { roleId: string | null }).roleId, null);
    });
  } finally {
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
    await prisma.location.delete({ where: { id: other.id } }).catch(() => {});
  }
});

/** A live login link for `userId`, stored the way the route stores it (hash only). */
async function liveLinkFor(userId: string, locationId: string) {
  const token = randomBytes(32).toString('base64url');
  const row = await prisma.loginLink.create({
    data: { tokenHash: hashOtp(token), userId, locationId, expiresAt: new Date(Date.now() + 3600_000) },
  });
  return { token, id: row.id };
}

function myShifts(baseUrl: string, token: string) {
  return fetch(`${baseUrl}/api/my-shifts`, { headers: { Authorization: `Bearer ${token}` } });
}

function setActive(baseUrl: string, managerToken: string, userId: string, isActive: boolean) {
  return fetch(`${baseUrl}/api/staff-directory/${userId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({ isActive }),
  });
}

async function testLocation(label: string) {
  const seedLocation = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seedLocation, 'seed data (a location) must exist to run this test');
  return prisma.location.create({
    data: { organizationId: seedLocation!.organizationId, name: `__staffdirectory-test__ ${label}`, timezone: 'Asia/Dubai' },
  });
}

test('PATCH isActive:false ends every session of that person at once and revokes their unspent login links; nobody else is touched', async () => {
  const location = await testLocation('deactivate');
  const leaver = await prisma.user.create({ data: { locationId: location.id, fullName: '__staffdirectory-test__ Leaver', systemRole: 'STAFF' } });
  const stayer = await prisma.user.create({ data: { locationId: location.id, fullName: '__staffdirectory-test__ Stayer', systemRole: 'STAFF' } });
  const manager = await prisma.user.create({ data: { locationId: location.id, fullName: '__staffdirectory-test__ Manager D', systemRole: 'MANAGER' } });

  try {
    const phoneToken = await sessionFor(leaver.id);
    const laptopToken = await sessionFor(leaver.id);
    const stayerToken = await sessionFor(stayer.id);
    const managerToken = await sessionFor(manager.id);
    const live = await liveLinkFor(leaver.id, location.id);
    const spent = await prisma.loginLink.create({
      data: {
        tokenHash: hashOtp(randomBytes(32).toString('base64url')),
        userId: leaver.id,
        locationId: location.id,
        expiresAt: new Date(Date.now() + 3600_000),
        consumedAt: new Date(),
      },
    });
    const stayerLink = await liveLinkFor(stayer.id, location.id);

    await withServer(async (baseUrl) => {
      assert.equal((await myShifts(baseUrl, phoneToken)).status, 200);

      // An edit that isn't a status change leaves sessions alone.
      const rename = await fetch(`${baseUrl}/api/staff-directory/${leaver.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${managerToken}` },
        body: JSON.stringify({ jobTitle: 'Runner' }),
      });
      assert.equal(rename.status, 200);
      assert.equal((await myShifts(baseUrl, phoneToken)).status, 200);

      const res = await setActive(baseUrl, managerToken, leaver.id, false);
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { isActive: boolean }).isActive, false);

      for (const token of [phoneToken, laptopToken]) {
        const after = await myShifts(baseUrl, token);
        assert.equal(after.status, 401, "the deactivated person's very next request must be refused");
        assert.equal(((await after.json()) as { error: string }).error, 'Session is invalid or has expired.');
      }
      assert.equal(await prisma.session.count({ where: { userId: leaver.id } }), 0, 'every session row is gone');

      assert.ok((await prisma.loginLink.findUniqueOrThrow({ where: { id: live.id } })).revokedAt, 'the unspent link is revoked');
      assert.equal((await prisma.loginLink.findUniqueOrThrow({ where: { id: spent.id } })).revokedAt, null, 'an already-used link is left as it was');
      const redeem = await fetch(`${baseUrl}/api/login-links/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: live.token }),
      });
      assert.equal(redeem.status, 410);
      const audit = await prisma.auditLog.findFirst({ where: { action: 'LOGIN_LINK_REVOKED', entityId: leaver.id } });
      assert.ok(audit, 'the revocation is audited');
      assert.equal(audit!.actorId, manager.id);
      assert.equal(audit!.locationId, location.id);

      assert.equal((await myShifts(baseUrl, stayerToken)).status, 200, "a colleague's session is untouched");
      assert.equal((await myShifts(baseUrl, managerToken)).status, 200, "the manager's own session is untouched");
      assert.equal((await prisma.loginLink.findUniqueOrThrow({ where: { id: stayerLink.id } })).revokedAt, null, "a colleague's link is untouched");
    });
  } finally {
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});

test('a session row whose user is inactive never authenticates; reactivating does not revive it, a fresh sign-in works', async () => {
  const location = await testLocation('reactivate');
  const phone = `+97150${(Date.now() + 7).toString().slice(-7)}`;
  // Inactive yet holding a session row: what a sign-in racing a deactivation could leave behind.
  const returner = await prisma.user.create({
    data: { locationId: location.id, fullName: '__staffdirectory-test__ Returner', systemRole: 'STAFF', phone, isActive: false, terminatedAt: new Date() },
  });
  const manager = await prisma.user.create({ data: { locationId: location.id, fullName: '__staffdirectory-test__ Manager E', systemRole: 'MANAGER' } });

  try {
    const stale = await sessionFor(returner.id);
    const managerToken = await sessionFor(manager.id);
    assert.equal(await resolveSession(stale), null, 'resolveSession refuses an inactive user');

    await withServer(async (baseUrl) => {
      assert.equal((await myShifts(baseUrl, stale)).status, 401);

      assert.equal((await setActive(baseUrl, managerToken, returner.id, true)).status, 200);
      assert.equal((await myShifts(baseUrl, stale)).status, 401, 'reactivation must not bring the old session back');
      assert.equal(await prisma.session.count({ where: { userId: returner.id } }), 0);

      const { plainCode } = await createOtpCode(phone, 'LOGIN');
      const login = await fetch(`${baseUrl}/api/identity/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, code: plainCode }),
      });
      assert.equal(login.status, 200);
      const { token } = (await login.json()) as { token: string };
      assert.equal((await myShifts(baseUrl, token)).status, 200, 'a fresh sign-in after reactivation works');
    });
  } finally {
    await prisma.otpCode.deleteMany({ where: { phone } });
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});

test('a manager who deactivates themselves gets a clean 200, and that session ends with it', async () => {
  const location = await testLocation('self');
  const manager = await prisma.user.create({ data: { locationId: location.id, fullName: '__staffdirectory-test__ Manager F', systemRole: 'MANAGER' } });

  try {
    const token = await sessionFor(manager.id);
    await withServer(async (baseUrl) => {
      const res = await setActive(baseUrl, token, manager.id, false);
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { isActive: boolean }).isActive, false);
      const next = await fetch(`${baseUrl}/api/staff-directory/${location.id}`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(next.status, 401);
    });
  } finally {
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});
