import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../app.js';
import { issueSession } from '../lib/identity.js';
import { VENUE_NAME_MAX_LENGTH } from '../../../shared/venueName.js';

/**
 * Venue rename over real HTTP (`PATCH /api/locations/:id`): Location.name is
 * the one venue name every screen reads (`GET` returns it straight back), the
 * name is trimmed, non-empty and at most VENUE_NAME_MAX_LENGTH characters,
 * owner and manager may rename and staff may not, and Organization.name
 * never changes — it keeps its signup-time value, the key test-venue cleanup
 * matches on — whether the organization has one venue or several. Two
 * organizations — one with a single venue, one with two — and everything
 * hangs off them, deleted in `after`.
 */
const prisma = new PrismaClient();
const TAG = '__locations-test__';

let server: Server;
let baseUrl = '';
let orgIds: string[] = [];
const fx = {} as { orgSolo: string; locSolo: string; orgGroup: string; locGroup1: string };
const sessions = {} as Record<'owner' | 'manager' | 'staff' | 'groupManager', string>;
const randomPhone = () => `+97150${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;

before(async () => {
  const [orgSolo, orgGroup] = await Promise.all([
    prisma.organization.create({ data: { name: `${TAG} solo` } }),
    prisma.organization.create({ data: { name: `${TAG} group` } }),
  ]);
  orgIds = [orgSolo.id, orgGroup.id];
  const locSolo = await prisma.location.create({ data: { organizationId: orgSolo.id, name: `${TAG} solo` } });
  const locGroup1 = await prisma.location.create({ data: { organizationId: orgGroup.id, name: `${TAG} group venue 1` } });
  await prisma.location.create({ data: { organizationId: orgGroup.id, name: `${TAG} group venue 2` } });
  const user = (locationId: string, systemRole: 'OWNER' | 'MANAGER' | 'STAFF', label: string) =>
    prisma.user.create({ data: { locationId, systemRole, fullName: `${TAG} ${label}`, phone: randomPhone() } });
  const owner = await user(locSolo.id, 'OWNER', 'owner');
  const manager = await user(locSolo.id, 'MANAGER', 'manager');
  const staff = await user(locSolo.id, 'STAFF', 'staff');
  const groupManager = await user(locGroup1.id, 'MANAGER', 'group manager');
  for (const [key, id] of [['owner', owner.id], ['manager', manager.id], ['staff', staff.id], ['groupManager', groupManager.id]] as const) {
    sessions[key] = (await issueSession(id)).plainToken;
  }
  Object.assign(fx, { orgSolo: orgSolo.id, locSolo: locSolo.id, orgGroup: orgGroup.id, locGroup1: locGroup1.id });

  server = await new Promise<Server>((resolve) => {
    const s = createApp().listen(0, () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.$disconnect();
});

function patch(token: string, locationId: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/locations/${locationId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

async function names(locationId: string, organizationId: string): Promise<{ location: string; organization: string }> {
  const [location, organization] = await Promise.all([
    prisma.location.findUniqueOrThrow({ where: { id: locationId }, select: { name: true } }),
    prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { name: true } }),
  ]);
  return { location: location.name, organization: organization.name };
}

test('owner renames: trimmed, returned, read back by GET; the single-venue organization keeps its name', async () => {
  const res = await patch(sessions.owner, fx.locSolo, { name: `  ${TAG} Casa Lumen  ` });
  assert.equal(res.status, 200);
  const { location } = (await res.json()) as { location: { id: string; name: string } };
  assert.equal(location.name, `${TAG} Casa Lumen`);
  assert.deepEqual(await names(fx.locSolo, fx.orgSolo), { location: `${TAG} Casa Lumen`, organization: `${TAG} solo` });

  const get = await fetch(`${baseUrl}/api/locations/${fx.locSolo}`, { headers: { Authorization: `Bearer ${sessions.staff}` } });
  assert.equal(get.status, 200);
  assert.equal(((await get.json()) as { location: { name: string } }).location.name, `${TAG} Casa Lumen`, 'staff read the new name too');
});

test('manager renames too; the organization still keeps its name', async () => {
  const res = await patch(sessions.manager, fx.locSolo, { name: `${TAG} renamed by manager` });
  assert.equal(res.status, 200);
  assert.deepEqual(await names(fx.locSolo, fx.orgSolo), { location: `${TAG} renamed by manager`, organization: `${TAG} solo` });
});

test('staff cannot rename', async () => {
  const before = await names(fx.locSolo, fx.orgSolo);
  const res = await patch(sessions.staff, fx.locSolo, { name: `${TAG} renamed by staff` });
  assert.equal(res.status, 403);
  assert.deepEqual(await names(fx.locSolo, fx.orgSolo), before);
});

test('blank and over-long names are refused and change nothing; exactly the maximum is fine', async () => {
  const before = await names(fx.locSolo, fx.orgSolo);
  const blank = await patch(sessions.owner, fx.locSolo, { name: '   ' });
  assert.equal(blank.status, 400);
  assert.match(((await blank.json()) as { error: string }).error, /cannot be empty/);

  const tooLong = await patch(sessions.owner, fx.locSolo, { name: `${TAG} `.padEnd(VENUE_NAME_MAX_LENGTH + 1, 'x') });
  assert.equal(tooLong.status, 400);
  assert.match(((await tooLong.json()) as { error: string }).error, new RegExp(`${VENUE_NAME_MAX_LENGTH} characters or fewer`));
  assert.deepEqual(await names(fx.locSolo, fx.orgSolo), before);

  const longest = `${TAG} `.padEnd(VENUE_NAME_MAX_LENGTH, 'x');
  const ok = await patch(sessions.owner, fx.locSolo, { name: `  ${longest}  ` });
  assert.equal(ok.status, 200, 'the limit applies to the trimmed name');
  assert.deepEqual(await names(fx.locSolo, fx.orgSolo), { location: longest, organization: `${TAG} solo` });
});

test('a patch without a name leaves both names alone', async () => {
  const before = await names(fx.locSolo, fx.orgSolo);
  const res = await patch(sessions.owner, fx.locSolo, { venueType: 'Fine Dining' });
  assert.equal(res.status, 200);
  assert.deepEqual(await names(fx.locSolo, fx.orgSolo), before);
});

test('in an organization with several venues, a rename leaves the organization name alone', async () => {
  const res = await patch(sessions.groupManager, fx.locGroup1, { name: `${TAG} group venue 1 renamed` });
  assert.equal(res.status, 200);
  assert.deepEqual(await names(fx.locGroup1, fx.orgGroup), { location: `${TAG} group venue 1 renamed`, organization: `${TAG} group` });
});
