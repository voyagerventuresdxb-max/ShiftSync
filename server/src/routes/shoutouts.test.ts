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

async function createVenue(nameSuffix: string) {
  const seedLocation = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seedLocation, 'seed data (a location) must exist to run this test');

  const location = await prisma.location.create({
    data: { organizationId: seedLocation!.organizationId, name: `__shoutouts-test__ ${nameSuffix}`, timezone: 'Asia/Dubai' },
  });
  const manager = await prisma.user.create({
    data: { locationId: location.id, fullName: `__shoutouts-test__ ${nameSuffix} manager`, systemRole: 'MANAGER' },
  });
  const staff = await prisma.user.create({
    data: { locationId: location.id, fullName: `__shoutouts-test__ ${nameSuffix} staff`, systemRole: 'STAFF' },
  });
  return { location, manager, staff };
}

async function cleanupVenue(locationId: string) {
  await prisma.shoutout.deleteMany({ where: { locationId } });
  await prisma.user.deleteMany({ where: { locationId } });
  await prisma.location.delete({ where: { id: locationId } }).catch(() => {});
}

// 2026-09-20 tenant-isolation audit finding #2: POST /api/shoutouts trusted
// `req.body.locationId` (only checked that the location *existed*, never
// that it belonged to the caller), so a signed-in user at Venue A could
// shout out a Venue B employee by naming Venue B's locationId. locationId is
// now forced from the session, which also means a crafted body naming
// Venue B's own employeeId alongside it now fails employee ownership
// (`employee.locationId !== forced locationId`) — this test proves BOTH the
// forced-locationId scoping AND that it can't be defeated by also supplying
// a real cross-tenant employeeId.
test("shoutouts.ts: a Venue A session cannot post a shoutout for a Venue B employee, even naming Venue B's own locationId + employeeId", async () => {
  const venueA = await createVenue('venueA');
  const venueB = await createVenue('venueB');

  try {
    const tokenA = await sessionFor(venueA.manager.id);
    await withServer(async (baseUrl) => {
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` };

      const res = await fetch(`${baseUrl}/api/shoutouts`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          locationId: venueB.location.id,
          employeeId: venueB.staff.id,
          note: '__shoutouts-test__ cross-tenant attempt',
        }),
      });
      // `locationId` is forced to Venue A (the caller's real session), so
      // Venue B's staff member no longer matches it — the same 404 shape
      // `createShoutout` already uses for "employee not found".
      assert.equal(res.status, 404, "posting a shoutout for a different venue's employee must 404, not succeed");
    });

    const leaked = await prisma.shoutout.findFirst({ where: { note: '__shoutouts-test__ cross-tenant attempt' } });
    assert.equal(leaked, null, 'no shoutout must have been created at all — not for Venue A, not for Venue B');
  } finally {
    await cleanupVenue(venueA.location.id);
    await cleanupVenue(venueB.location.id);
  }
});

// Companion: proves the fix didn't also break the legitimate same-venue case.
test('shoutouts.ts: a real manager session can still post a shoutout for their own venue\'s employee', async () => {
  const venue = await createVenue('legit');

  try {
    const token = await sessionFor(venue.manager.id);
    let shoutoutId = '';
    await withServer(async (baseUrl) => {
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

      const res = await fetch(`${baseUrl}/api/shoutouts`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          locationId: venue.location.id,
          employeeId: venue.staff.id,
          note: '__shoutouts-test__ legit shoutout',
        }),
      });
      assert.equal(res.status, 201, 'a real manager must still be able to post a shoutout for their own venue\'s employee');
      const body = (await res.json()) as { shoutout: { id: string } };
      shoutoutId = body.shoutout.id;
    });

    const created = await prisma.shoutout.findUnique({ where: { id: shoutoutId } });
    assert.ok(created, 'the shoutout must have actually been created');
    assert.equal(created!.locationId, venue.location.id);
    assert.equal(created!.employeeId, venue.staff.id);
  } finally {
    await cleanupVenue(venue.location.id);
  }
});

// MVP readiness review (2026-09-22): same fix as announcements.ts — the
// author is the session user, never the body's authorId (which the client
// filled from its "Viewing" employee, i.e. usually someone else).
test('shoutouts.ts: POST attributes the shoutout to the session user, ignoring any body authorId', async () => {
  const venue = await createVenue('author');
  const employee = await prisma.user.create({
    data: { locationId: venue.location.id, fullName: '__shoutouts-test__ author employee', systemRole: 'STAFF' },
  });
  try {
    await withServer(async (baseUrl) => {
      const token = await sessionFor(venue.manager.id);
      const res = await fetch(`${baseUrl}/api/shoutouts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ employeeId: employee.id, authorId: employee.id, note: '__shoutouts-test__ great service' }),
      });
      assert.equal(res.status, 201);
      const { shoutout } = (await res.json()) as { shoutout: { id: string; authorId: string | null; authorName: string | null } };
      assert.equal(shoutout.authorId, venue.manager.id, 'a body authorId naming someone else must be ignored');
      assert.equal(shoutout.authorName, venue.manager.fullName);
    });
  } finally {
    await cleanupVenue(venue.location.id);
  }
});

// Permission model (2026-09-22, deliberate product decision — see the DELETE
// route's doc comment): anyone signed in at the venue may POST a shoutout;
// removing one is manager/owner only, with NO author exception; managers
// stay confined to their own venue.
test('shoutouts.ts permission model: STAFF can post, cannot delete even their own (403); a manager can delete a STAFF-authored one; a manager is still confined to their own venue (404)', async () => {
  const venueA = await createVenue('perm-A');
  const venueB = await createVenue('perm-B');
  try {
    await withServer(async (baseUrl) => {
      const staffToken = await sessionFor(venueA.staff.id);
      const managerAToken = await sessionFor(venueA.manager.id);
      const managerBToken = await sessionFor(venueB.manager.id);
      const json = (token: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

      const post = await fetch(`${baseUrl}/api/shoutouts`, {
        method: 'POST',
        headers: json(staffToken),
        body: JSON.stringify({ employeeId: venueA.manager.id, note: '__shoutouts-test__ posted by staff' }),
      });
      assert.equal(post.status, 201, 'a STAFF session must be able to post a shoutout');
      const { shoutout } = (await post.json()) as { shoutout: { id: string } };

      const staffDelete = await fetch(`${baseUrl}/api/shoutouts/${shoutout.id}`, { method: 'DELETE', headers: json(staffToken) });
      assert.equal(staffDelete.status, 403, 'STAFF deleting their own shoutout must be refused');

      const crossDelete = await fetch(`${baseUrl}/api/shoutouts/${shoutout.id}`, { method: 'DELETE', headers: json(managerBToken) });
      assert.equal(crossDelete.status, 404, "a manager must not be able to delete another venue's shoutout");
      assert.ok(await prisma.shoutout.findUnique({ where: { id: shoutout.id } }), 'neither refused delete may have landed');

      const managerDelete = await fetch(`${baseUrl}/api/shoutouts/${shoutout.id}`, { method: 'DELETE', headers: json(managerAToken) });
      assert.equal(managerDelete.status, 204, "the venue's manager must be able to delete a STAFF-authored shoutout");
      assert.equal(await prisma.shoutout.findUnique({ where: { id: shoutout.id } }), null);
    });
  } finally {
    await cleanupVenue(venueA.location.id);
    await cleanupVenue(venueB.location.id);
  }
});
