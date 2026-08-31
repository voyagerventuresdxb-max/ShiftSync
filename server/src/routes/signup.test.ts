import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../app.js';
import { createOtpCode, phoneDigits } from '../lib/identity.js';

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

/** Unique-enough test phone number per test run, so parallel/rerun tests never collide. */
function testPhone(): string {
  return `05${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
}

test('POST /api/signup/verify-otp: a real new signup creates Organization+Location+User(OWNER) and returns a working session', async () => {
  const phone = testPhone();
  const venueName = '__task-signup-test__ New Venue';
  const fullName = '__task-signup-test__ Owner One';

  const { plainCode } = await createOtpCode(phone, 'SIGNUP');

  let organizationId = '';
  let locationId = '';
  let userId = '';
  let token = '';

  try {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/signup/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, code: plainCode, fullName, venueName }),
      });
      assert.equal(res.status, 201, 'a real new signup must succeed and create resources (201)');
      const body = (await res.json()) as {
        token: string;
        expiresAt: string;
        user: { id: string; fullName: string; jobTitle: string | null; locationId: string; systemRole: string };
      };
      assert.ok(body.token, 'response must carry a real session token');
      assert.equal(body.user.fullName, fullName);
      assert.equal(body.user.jobTitle, null, 'a freshly-created owner has no jobTitle yet');
      assert.equal(body.user.systemRole, 'OWNER');
      token = body.token;
      userId = body.user.id;
      locationId = body.user.locationId;
    });

    // The session must actually work — verify via an authenticated follow-up call.
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/locations/${locationId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200, 'the returned session token must resolve to a real, working session');
      const body = (await res.json()) as { location: { id: string; name: string } };
      assert.equal(body.location.id, locationId);
      assert.equal(body.location.name, venueName);
    });

    const user = await prisma.user.findUnique({ where: { id: userId } });
    assert.ok(user, 'a real User row must exist');
    assert.equal(user!.systemRole, 'OWNER');
    assert.equal(user!.locationId, locationId);
    assert.equal(user!.fullName, fullName);
    assert.equal(user!.phone, phone);

    const location = await prisma.location.findUnique({ where: { id: locationId } });
    assert.ok(location, 'a real Location row must exist');
    assert.equal(location!.name, venueName);
    // timezone/currency must come from the schema's own @default, not a
    // hand-copied literal in the route.
    assert.equal(location!.timezone, 'Asia/Dubai');
    assert.equal(location!.currency, 'AED');
    organizationId = location!.organizationId;

    const organization = await prisma.organization.findUnique({ where: { id: organizationId } });
    assert.ok(organization, 'a real Organization row must exist');
    assert.equal(organization!.name, venueName);

    const auditRow = await prisma.auditLog.findFirst({
      where: { locationId, entityType: 'Location', entityId: locationId },
    });
    assert.ok(auditRow, 'a real AuditLog row for the new venue must exist');
    assert.equal(auditRow!.actorId, userId);
    assert.match(auditRow!.note ?? '', /\[signup\]/);
  } finally {
    await prisma.session.deleteMany({ where: { userId } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityType: 'Location', entityId: locationId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
    await prisma.location.deleteMany({ where: { id: locationId } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: organizationId } }).catch(() => {});

    // Independently re-confirm zero rows remain.
    if (userId) assert.equal(await prisma.user.count({ where: { id: userId } }), 0);
    if (locationId) assert.equal(await prisma.location.count({ where: { id: locationId } }), 0);
    if (organizationId) assert.equal(await prisma.organization.count({ where: { id: organizationId } }), 0);
  }
});

test('POST /api/signup/verify-otp: a phone that already matches an existing active User gets a clean 409 and creates nothing', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');

  const rawPhone = `+971 50 ${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
  const existingUser = await prisma.user.create({
    data: {
      locationId: location!.id,
      fullName: '__task-signup-test__ existing staff',
      systemRole: 'STAFF',
      phone: rawPhone,
    },
  });

  // Submit a differently-formatted string that normalizes to the same digits
  // (same phoneDigits-lossy-normalization semantics as the rest of identity).
  const digits = phoneDigits(rawPhone);
  const submittedPhone = `0${digits}`;

  const { plainCode } = await createOtpCode(submittedPhone, 'SIGNUP');

  try {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/signup/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: submittedPhone,
          code: plainCode,
          fullName: '__task-signup-test__ duplicate signer',
          venueName: '__task-signup-test__ duplicate venue',
        }),
      });
      assert.equal(res.status, 409, 'a phone matching an existing active User must be rejected with 409');
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /already exists/i);
      assert.match(body.error, /log in/i);
    });

    // Nothing new was created anywhere — verify via a fresh DB re-query,
    // scoped to this test's own distinctively-named venue rather than a
    // raw global count. `node --test` runs test files concurrently against
    // the same live DB, and other files (shifts.test.ts, floorPlan.test.ts)
    // create/delete their own throwaway Location rows mid-run — a global
    // `count()` snapshot taken before/after is a real race against that
    // unrelated churn, not a check on this test's own effect. Same class of
    // hazard as the unordered-`findFirst()` race already fixed elsewhere
    // (see MEMORY.md); name-scoping here is the fix, not a workaround,
    // since venueName ends up as both Organization.name and Location.name
    // (confirmed by the "real new signup" test above) and this test's own
    // venueName is unique to it.
    const leakedOrg = await prisma.organization.findFirst({ where: { name: '__task-signup-test__ duplicate venue' } });
    assert.equal(leakedOrg, null, 'no new Organization may be created');
    const leakedLocation = await prisma.location.findFirst({ where: { name: '__task-signup-test__ duplicate venue' } });
    assert.equal(leakedLocation, null, 'no new Location may be created');
    const leaked = await prisma.user.findMany({
      where: { fullName: '__task-signup-test__ duplicate signer' },
    });
    assert.equal(leaked.length, 0, 'no new User may be created for the duplicate phone');
  } finally {
    await prisma.user.delete({ where: { id: existingUser.id } }).catch(() => {});
    assert.equal(await prisma.user.count({ where: { id: existingUser.id } }), 0);
  }
});

test('POST /api/signup/verify-otp: missing fullName or venueName gets a 400, nothing created', async () => {
  const phoneA = testPhone();
  const phoneB = testPhone();
  const { plainCode: codeA } = await createOtpCode(phoneA, 'SIGNUP');
  const { plainCode: codeB } = await createOtpCode(phoneB, 'SIGNUP');

  const orgCountBefore = await prisma.organization.count();

  await withServer(async (baseUrl) => {
    const resNoFullName = await fetch(`${baseUrl}/api/signup/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: phoneA, code: codeA, fullName: '  ', venueName: '__task-signup-test__ venue A' }),
    });
    assert.equal(resNoFullName.status, 400, 'a blank fullName must 400');
    const bodyA = (await resNoFullName.json()) as { error: string };
    assert.match(bodyA.error, /fullName/i);

    const resNoVenueName = await fetch(`${baseUrl}/api/signup/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: phoneB, code: codeB, fullName: '__task-signup-test__ Owner B', venueName: '' }),
    });
    assert.equal(resNoVenueName.status, 400, 'a blank venueName must 400');
    const bodyB = (await resNoVenueName.json()) as { error: string };
    assert.match(bodyB.error, /venueName/i);
  });

  assert.equal(await prisma.organization.count(), orgCountBefore, 'no Organization may be created on a 400');
  const leaked = await prisma.user.findMany({
    where: { fullName: { in: ['__task-signup-test__ Owner B'] } },
  });
  assert.equal(leaked.length, 0, 'no User may be created on a 400');
});

test('POST /api/signup/request-otp: returns expiresAt for a bare phone (no locationId needed)', async () => {
  const phone = testPhone();
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/signup/request-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { expiresAt: string };
    assert.ok(body.expiresAt, 'response must carry an expiresAt');
  });

  await prisma.otpCode.deleteMany({ where: { phone: phoneDigits(phone), purpose: 'SIGNUP' } });
});
