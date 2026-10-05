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

// MVP readiness review (2026-09-22): the author used to come from the request
// body — the client sent its "Viewing" employee, or nothing for a fresh venue
// — so a manager's announcement was attributed to a colleague or to nobody,
// and an author-less row then rendered under the READER's own name on their
// My Shifts screen. The author is the session user, whatever the body says.
test('announcements.ts: POST attributes the announcement to the session user, ignoring any body authorId', async () => {
  const venue = await createVenue('author');
  const colleague = await prisma.user.create({
    data: { locationId: venue.location.id, fullName: '__announcements-test__ author colleague', systemRole: 'STAFF' },
  });
  try {
    await withServer(async (baseUrl) => {
      const token = await sessionFor(venue.manager.id);
      for (const authorId of [undefined, null, colleague.id]) {
        const res = await fetch(`${baseUrl}/api/announcements`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ body: `__announcements-test__ posted with authorId=${String(authorId)}`, authorId }),
        });
        assert.equal(res.status, 201);
        const { announcement } = (await res.json()) as { announcement: { id: string; authorId: string | null; authorName: string | null } };
        assert.equal(announcement.authorId, venue.manager.id, `authorId=${String(authorId)} in the body must not change the author`);
        assert.equal(announcement.authorName, venue.manager.fullName);
        const row = await prisma.announcement.findUnique({ where: { id: announcement.id } });
        assert.equal(row?.authorId, venue.manager.id);
      }
    });
  } finally {
    await cleanupVenue(venue.location.id);
  }
});

// Permission model (2026-09-22, deliberate product decision — see the PATCH
// route's doc comment): anyone signed in at the venue may POST, but PATCH and
// DELETE are manager/owner only, with NO author exception. Tenant isolation
// is unchanged: a manager is still confined to their own venue.
test('announcements.ts permission model: STAFF can post, cannot edit/delete even their own post (403); a manager can edit/delete a STAFF-authored post; a manager is still confined to their own venue (404)', async () => {
  const venueA = await createVenue('perm-A');
  const venueB = await createVenue('perm-B');
  const staffA = await prisma.user.create({
    data: { locationId: venueA.location.id, fullName: '__announcements-test__ perm-A staff', systemRole: 'STAFF' },
  });
  try {
    await withServer(async (baseUrl) => {
      const staffToken = await sessionFor(staffA.id);
      const managerAToken = await sessionFor(venueA.manager.id);
      const managerBToken = await sessionFor(venueB.manager.id);
      const json = (token: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

      // STAFF can create.
      const post = await fetch(`${baseUrl}/api/announcements`, {
        method: 'POST',
        headers: json(staffToken),
        body: JSON.stringify({ body: '__announcements-test__ posted by staff' }),
      });
      assert.equal(post.status, 201, 'a STAFF session must be able to post an announcement');
      const { announcement } = (await post.json()) as { announcement: { id: string } };

      // STAFF cannot edit or delete — not even their own post.
      const staffPatch = await fetch(`${baseUrl}/api/announcements/${announcement.id}`, {
        method: 'PATCH',
        headers: json(staffToken),
        body: JSON.stringify({ body: 'edited by its own STAFF author' }),
      });
      assert.equal(staffPatch.status, 403, 'STAFF editing their own post must be refused');
      const staffDelete = await fetch(`${baseUrl}/api/announcements/${announcement.id}`, { method: 'DELETE', headers: json(staffToken) });
      assert.equal(staffDelete.status, 403, 'STAFF deleting their own post must be refused');
      const untouched = await prisma.announcement.findUnique({ where: { id: announcement.id } });
      assert.equal(untouched?.body, '__announcements-test__ posted by staff');

      // A manager from ANOTHER venue is still confined to their own (tenant isolation regression check).
      const crossPatch = await fetch(`${baseUrl}/api/announcements/${announcement.id}`, {
        method: 'PATCH',
        headers: json(managerBToken),
        body: JSON.stringify({ body: 'edited cross-venue' }),
      });
      assert.equal(crossPatch.status, 404, "a manager must not be able to edit another venue's announcement");
      const crossDelete = await fetch(`${baseUrl}/api/announcements/${announcement.id}`, { method: 'DELETE', headers: json(managerBToken) });
      assert.equal(crossDelete.status, 404, "a manager must not be able to delete another venue's announcement");
      assert.ok(await prisma.announcement.findUnique({ where: { id: announcement.id } }), 'cross-venue delete must not have landed');

      // The venue's own manager can edit and delete the STAFF-authored post.
      const managerPatch = await fetch(`${baseUrl}/api/announcements/${announcement.id}`, {
        method: 'PATCH',
        headers: json(managerAToken),
        body: JSON.stringify({ body: '__announcements-test__ edited by manager' }),
      });
      assert.equal(managerPatch.status, 200, "the venue's manager must be able to edit a STAFF-authored post");
      assert.equal((await prisma.announcement.findUnique({ where: { id: announcement.id } }))?.body, '__announcements-test__ edited by manager');
      const managerDelete = await fetch(`${baseUrl}/api/announcements/${announcement.id}`, { method: 'DELETE', headers: json(managerAToken) });
      assert.equal(managerDelete.status, 204, "the venue's manager must be able to delete a STAFF-authored post");
      assert.equal(await prisma.announcement.findUnique({ where: { id: announcement.id } }), null);
    });
  } finally {
    await cleanupVenue(venueA.location.id);
    await cleanupVenue(venueB.location.id);
  }
});
