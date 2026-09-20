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
    data: { organizationId: seedLocation!.organizationId, name: `__announcements-test__ ${nameSuffix}`, timezone: 'Asia/Dubai' },
  });
  const manager = await prisma.user.create({
    data: { locationId: location.id, fullName: `__announcements-test__ ${nameSuffix} manager`, systemRole: 'MANAGER' },
  });
  return { location, manager };
}

async function cleanupVenue(locationId: string) {
  await prisma.announcement.deleteMany({ where: { locationId } });
  await prisma.user.deleteMany({ where: { locationId } });
  await prisma.location.delete({ where: { id: locationId } }).catch(() => {});
}

// 2026-09-20 tenant-isolation audit finding #1 (CRITICAL): PATCH /:id and
// DELETE /:id had no `requireSession` middleware at all — anyone, signed in
// or not, who had or guessed an announcement id could edit or delete any
// venue's announcement. Confirms the fix actually rejects a bare request
// with no Authorization header, not just a request from the wrong venue.
test('announcements.ts: PATCH/DELETE /:id reject a request with no Authorization header at all — 401', async () => {
  const { location } = await createVenue('unauth');
  const announcement = await prisma.announcement.create({
    data: { locationId: location.id, authorId: null, body: '__announcements-test__ original body' },
  });

  try {
    await withServer(async (baseUrl) => {
      const patch = await fetch(`${baseUrl}/api/announcements/${announcement.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'tampered by an anonymous caller' }),
      });
      assert.equal(patch.status, 401, 'PATCH /:id must reject a request with no session at all');

      const del = await fetch(`${baseUrl}/api/announcements/${announcement.id}`, { method: 'DELETE' });
      assert.equal(del.status, 401, 'DELETE /:id must reject a request with no session at all');
    });

    const stillThere = await prisma.announcement.findUnique({ where: { id: announcement.id } });
    assert.ok(stillThere, 'the announcement must still exist — the unauthenticated DELETE must not have landed');
    assert.equal(stillThere!.body, '__announcements-test__ original body', 'the unauthenticated PATCH must not have landed');
  } finally {
    await cleanupVenue(location.id);
  }
});

// 2026-09-20 tenant-isolation audit finding #1/#2: even once auth is
// required, a signed-in user from a DIFFERENT venue must not be able to
// read/write another venue's announcement — via a guessed id (PATCH/DELETE)
// or via naming the other venue's locationId in a POST body.
test("announcements.ts: a Venue A session cannot write, edit, or delete Venue B's announcements", async () => {
  const venueA = await createVenue('venueA');
  const venueB = await createVenue('venueB');
  const bsAnnouncement = await prisma.announcement.create({
    data: { locationId: venueB.location.id, authorId: venueB.manager.id, body: "__announcements-test__ Venue B's real announcement" },
  });

  try {
    const tokenA = await sessionFor(venueA.manager.id);
    await withServer(async (baseUrl) => {
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` };

      // POST naming Venue B's locationId must land in Venue A's own venue
      // instead (locationId is forced from the session, not trusted from
      // the body) — never create anything attributed to Venue B.
      const post = await fetch(`${baseUrl}/api/announcements`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ locationId: venueB.location.id, body: '__announcements-test__ cross-tenant post attempt' }),
      });
      assert.equal(post.status, 201, 'a real session may still post — just scoped to its own venue');

      const patch = await fetch(`${baseUrl}/api/announcements/${bsAnnouncement.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ body: 'tampered by a Venue A session' }),
      });
      assert.equal(patch.status, 404, "PATCH must 404 on another venue's announcement (not found, not 403 — see ownedOrNotFound)");

      const del = await fetch(`${baseUrl}/api/announcements/${bsAnnouncement.id}`, { method: 'DELETE', headers });
      assert.equal(del.status, 404, "DELETE must 404 on another venue's announcement");
    });

    const crossTenantPost = await prisma.announcement.findFirst({
      where: { body: '__announcements-test__ cross-tenant post attempt' },
    });
    assert.ok(crossTenantPost, 'the POST must have actually created something');
    assert.equal(crossTenantPost!.locationId, venueA.location.id, "the cross-tenant POST must land in the caller's own venue (A), never Venue B");

    const untouched = await prisma.announcement.findUnique({ where: { id: bsAnnouncement.id } });
    assert.ok(untouched, "Venue B's announcement must still exist — the DELETE from Venue A must not have landed");
    assert.equal(untouched!.body, "__announcements-test__ Venue B's real announcement", "Venue B's announcement must be unmodified — the PATCH from Venue A must not have landed");
  } finally {
    await cleanupVenue(venueA.location.id);
    await cleanupVenue(venueB.location.id);
  }
});

// Companion to both tests above: proves the fix didn't also break the
// legitimate same-venue case.
test('announcements.ts: a real owner session can still edit and delete its own venue\'s announcement', async () => {
  const venue = await createVenue('legit');
  const announcement = await prisma.announcement.create({
    data: { locationId: venue.location.id, authorId: venue.manager.id, body: '__announcements-test__ legit original' },
  });

  try {
    const token = await sessionFor(venue.manager.id);
    await withServer(async (baseUrl) => {
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

      const patch = await fetch(`${baseUrl}/api/announcements/${announcement.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ body: '__announcements-test__ legit edited' }),
      });
      assert.equal(patch.status, 200, 'a real manager must still be able to edit their own venue\'s announcement');

      const del = await fetch(`${baseUrl}/api/announcements/${announcement.id}`, { method: 'DELETE', headers });
      assert.equal(del.status, 204, 'a real manager must still be able to delete their own venue\'s announcement');
    });

    const gone = await prisma.announcement.findUnique({ where: { id: announcement.id } });
    assert.equal(gone, null, 'the announcement must have actually been deleted');
  } finally {
    await cleanupVenue(venue.location.id);
  }
});
