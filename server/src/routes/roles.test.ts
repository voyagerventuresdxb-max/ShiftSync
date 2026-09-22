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

async function sessionFor(userId: string): Promise<string> {
  const { plainToken } = await issueSession(userId);
  return plainToken;
}

async function createVenue(nameSuffix: string) {
  const seedLocation = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seedLocation, 'seed data (a location) must exist to run this test');
  const location = await prisma.location.create({
    data: { organizationId: seedLocation!.organizationId, name: `__roles-test__ ${nameSuffix}`, timezone: 'Asia/Dubai' },
  });
  const manager = await prisma.user.create({
    data: { locationId: location.id, fullName: `__roles-test__ ${nameSuffix} manager`, systemRole: 'MANAGER' },
  });
  const staff = await prisma.user.create({
    data: { locationId: location.id, fullName: `__roles-test__ ${nameSuffix} staff`, systemRole: 'STAFF' },
  });
  return { location, manager, staff };
}

async function cleanupVenue(locationId: string) {
  await prisma.shift.deleteMany({ where: { locationId } });
  await prisma.user.deleteMany({ where: { locationId } });
  await prisma.role.deleteMany({ where: { locationId } });
  await prisma.location.delete({ where: { id: locationId } }).catch(() => {});
}

const json = (token: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

test('roles.ts: create → assign to staff → rename follows on staff and shifts → remove unassigns staff, keeps shifts, hides from the list, blocks new shifts, and re-adding reactivates', async () => {
  const venue = await createVenue('lifecycle');
  try {
    await withServer(async (baseUrl) => {
      const token = await sessionFor(venue.manager.id);

      // Create.
      const create = await fetch(`${baseUrl}/api/roles`, { method: 'POST', headers: json(token), body: JSON.stringify({ name: 'Sommelier' }) });
      assert.equal(create.status, 201);
      const { role } = (await create.json()) as { role: { id: string; name: string } };
      const dup = await fetch(`${baseUrl}/api/roles`, { method: 'POST', headers: json(token), body: JSON.stringify({ name: 'Sommelier' }) });
      assert.equal(dup.status, 409, 'a second active role with the same name is refused');

      // Assign via the staff directory; the directory reflects it.
      const assign = await fetch(`${baseUrl}/api/staff-directory/${venue.staff.id}`, { method: 'PATCH', headers: json(token), body: JSON.stringify({ roleId: role.id }) });
      assert.equal(assign.status, 200);
      assert.equal(((await assign.json()) as { roleName: string }).roleName, 'Sommelier');

      // A shift on the role (the rota builder's write path).
      const shiftRes = await fetch(`${baseUrl}/api/shifts`, {
        method: 'POST',
        headers: json(token),
        body: JSON.stringify({ roleId: role.id, userId: venue.staff.id, date: '2030-01-07', start: '17:00', end: '23:00' }),
      });
      assert.equal(shiftRes.status, 201, `a shift can be created on the new role: ${await shiftRes.clone().text()}`);
      const { shift } = (await shiftRes.json()) as { shift: { id: string } };

      // Rename: staff and shifts follow, since both hold the id.
      const rename = await fetch(`${baseUrl}/api/roles/${role.id}`, { method: 'PATCH', headers: json(token), body: JSON.stringify({ name: 'Wine Lead' }) });
      assert.equal(rename.status, 200);
      const directory = (await (await fetch(`${baseUrl}/api/staff-directory/${venue.location.id}`, { headers: json(token) })).json()) as { staff: { id: string; roleName: string | null }[] };
      assert.equal(directory.staff.find((s) => s.id === venue.staff.id)?.roleName, 'Wine Lead');
      const shiftRow = await prisma.shift.findUnique({ where: { id: shift.id }, include: { role: true } });
      assert.equal(shiftRow?.role.name, 'Wine Lead');

      // Rename into an existing name is refused.
      await fetch(`${baseUrl}/api/roles`, { method: 'POST', headers: json(token), body: JSON.stringify({ name: 'Runner' }) });
      const clash = await fetch(`${baseUrl}/api/roles/${role.id}`, { method: 'PATCH', headers: json(token), body: JSON.stringify({ name: 'Runner' }) });
      assert.equal(clash.status, 409);

      // Remove: deactivated, staff unassigned, shift untouched, gone from the list, no new shifts on it.
      const remove = await fetch(`${baseUrl}/api/roles/${role.id}`, { method: 'DELETE', headers: json(token) });
      assert.equal(remove.status, 204);
      assert.equal((await prisma.role.findUnique({ where: { id: role.id } }))?.isActive, false);
      assert.equal((await prisma.user.findUnique({ where: { id: venue.staff.id } }))?.roleId, null, 'staff on the role are unassigned');
      assert.equal((await prisma.shift.findUnique({ where: { id: shift.id } }))?.roleId, role.id, 'existing shifts keep the role — nothing orphaned');
      const list = (await (await fetch(`${baseUrl}/api/roles`, { headers: json(token) })).json()) as { roles: { id: string }[] };
      assert.ok(!list.roles.some((r) => r.id === role.id), 'a removed role is not offered any more');
      const blocked = await fetch(`${baseUrl}/api/shifts`, {
        method: 'POST',
        headers: json(token),
        body: JSON.stringify({ roleId: role.id, userId: venue.staff.id, date: '2030-01-08', start: '17:00', end: '23:00' }),
      });
      assert.equal(blocked.status, 404, 'no NEW shift can be created on a removed role');
      const reassignBlocked = await fetch(`${baseUrl}/api/staff-directory/${venue.staff.id}`, { method: 'PATCH', headers: json(token), body: JSON.stringify({ roleId: role.id }) });
      assert.equal(reassignBlocked.status, 404, 'a removed role cannot be assigned to staff');

      // Re-adding the same name reactivates the same row (its shift still points at it).
      const readd = await fetch(`${baseUrl}/api/roles`, { method: 'POST', headers: json(token), body: JSON.stringify({ name: 'Wine Lead' }) });
      assert.equal(readd.status, 200);
      assert.equal(((await readd.json()) as { role: { id: string } }).role.id, role.id);
    });
  } finally {
    await cleanupVenue(venue.location.id);
  }
});

test('roles.ts: STAFF cannot create, rename or remove roles (403); a manager is confined to their own venue (404)', async () => {
  const venueA = await createVenue('perm-A');
  const venueB = await createVenue('perm-B');
  const roleA = await prisma.role.create({ data: { locationId: venueA.location.id, name: 'Barback' } });
  try {
    await withServer(async (baseUrl) => {
      const staffToken = await sessionFor(venueA.staff.id);
      const managerBToken = await sessionFor(venueB.manager.id);

      assert.equal((await fetch(`${baseUrl}/api/roles`, { method: 'POST', headers: json(staffToken), body: JSON.stringify({ name: 'X' }) })).status, 403);
      assert.equal((await fetch(`${baseUrl}/api/roles/${roleA.id}`, { method: 'PATCH', headers: json(staffToken), body: JSON.stringify({ name: 'X' }) })).status, 403);
      assert.equal((await fetch(`${baseUrl}/api/roles/${roleA.id}`, { method: 'DELETE', headers: json(staffToken) })).status, 403);

      assert.equal((await fetch(`${baseUrl}/api/roles/${roleA.id}`, { method: 'PATCH', headers: json(managerBToken), body: JSON.stringify({ name: 'Hijacked' }) })).status, 404);
      assert.equal((await fetch(`${baseUrl}/api/roles/${roleA.id}`, { method: 'DELETE', headers: json(managerBToken) })).status, 404);
      const crossAssign = await fetch(`${baseUrl}/api/staff-directory/${venueB.staff.id}`, { method: 'PATCH', headers: json(managerBToken), body: JSON.stringify({ roleId: roleA.id }) });
      assert.equal(crossAssign.status, 404, "another venue's role cannot be assigned to this venue's staff");

      const untouched = await prisma.role.findUnique({ where: { id: roleA.id } });
      assert.equal(untouched?.name, 'Barback');
      assert.equal(untouched?.isActive, true);
    });
  } finally {
    await cleanupVenue(venueA.location.id);
    await cleanupVenue(venueB.location.id);
  }
});
