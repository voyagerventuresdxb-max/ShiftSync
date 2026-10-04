import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../app.js';
import { issueSession } from '../lib/identity.js';

/**
 * On the 86 routes a manager may record an action on behalf of a colleague,
 * but only a colleague at the same venue: naming another venue's person is a
 * 404 and nothing is written. The shift routes take the actor from the
 * session only: whoever the body names, the signed-in manager is recorded.
 */
const prisma = new PrismaClient();
const TAG = '__on-behalf-test__';
let server: Server;
let base = '';
let orgIds: string[] = [];
let fx: { locA: string; roleA: string; manager: string; managerToken: string; colleague: string; outsider: string; shiftId: string; monday: string };

function futureMonday(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 14);
  return d.toISOString().slice(0, 10);
}

before(async () => {
  const [orgA, orgB] = await Promise.all([
    prisma.organization.create({ data: { name: `${TAG} A` } }),
    prisma.organization.create({ data: { name: `${TAG} B` } }),
  ]);
  orgIds = [orgA.id, orgB.id];
  const locA = await prisma.location.create({ data: { organizationId: orgA.id, name: `${TAG} A`, timezone: 'Asia/Dubai' } });
  const locB = await prisma.location.create({ data: { organizationId: orgB.id, name: `${TAG} B`, timezone: 'Asia/Dubai' } });
  const manager = await prisma.user.create({ data: { locationId: locA.id, fullName: `${TAG} manager`, systemRole: 'MANAGER' } });
  const colleague = await prisma.user.create({ data: { locationId: locA.id, fullName: `${TAG} colleague`, systemRole: 'STAFF' } });
  const outsider = await prisma.user.create({ data: { locationId: locB.id, fullName: `${TAG} outsider`, systemRole: 'STAFF' } });
  const roleA = await prisma.role.create({ data: { locationId: locA.id, name: `${TAG} Bartender` } });
  const monday = futureMonday();
  const shift = await prisma.shift.create({
    data: { locationId: locA.id, roleId: roleA.id, userId: colleague.id, date: new Date(`${monday}T00:00:00.000Z`), startTime: new Date(`${monday}T13:00:00.000Z`), endTime: new Date(`${monday}T19:00:00.000Z`) },
  });
  fx = { locA: locA.id, roleA: roleA.id, manager: manager.id, managerToken: (await issueSession(manager.id)).plainToken, colleague: colleague.id, outsider: outsider.id, shiftId: shift.id, monday };
  server = await new Promise<Server>((resolve) => {
    const s = createApp().listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.$disconnect();
});

const send = (method: string, path: string, body: object) =>
  fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fx.managerToken}` }, body: JSON.stringify(body) });

test("another venue's person can't be named as the actor on the 86 routes; nothing is written", async () => {
  assert.equal((await send('POST', '/api/eighty-six', { itemName: `${TAG} lime`, station: 'Bar', createdById: fx.outsider })).status, 404);
  const item = await prisma.eightySixItem.create({ data: { locationId: fx.locA, itemName: `${TAG} mint`, station: 'Bar' } });
  assert.equal((await send('PATCH', `/api/eighty-six/${item.id}/back-on`, { actorId: fx.outsider })).status, 404);

  assert.equal(await prisma.eightySixItem.count({ where: { locationId: fx.locA, itemName: `${TAG} lime` } }), 0);
  assert.equal((await prisma.eightySixItem.findUniqueOrThrow({ where: { id: item.id } })).status, 'EIGHTY_SIXED');
  assert.equal(await prisma.auditLog.count({ where: { actorId: fx.outsider } }), 0, 'no audit row names the outsider');
});

test('shift routes record the signed-in manager, whoever the body names', async () => {
  const shiftBody = { roleId: fx.roleA, date: fx.monday, start: '09:00', end: '11:00' };
  const created = await send('POST', '/api/shifts', { ...shiftBody, createdById: fx.outsider });
  assert.equal(created.status, 201);
  const createdId = ((await created.json()) as { shift: { id: string } }).shift.id;
  assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: createdId } })).createdById, fx.manager);
  const cases: [string, string, object][] = [
    ['POST', '/api/shifts/bulk', { shifts: [{ ...shiftBody, start: '11:00', end: '12:00' }], createdById: fx.colleague }],
    ['PATCH', `/api/shifts/${fx.shiftId}`, { breakMinutes: 30, actorId: fx.outsider }],
    ['DELETE', `/api/shifts/${createdId}`, { actorId: fx.outsider }],
    ['POST', `/api/shifts/${fx.locA}/publish`, { weekStart: fx.monday, publishedById: fx.colleague }],
  ];
  for (const [method, path, body] of cases) {
    const res = await send(method, path, body);
    assert.ok(res.status >= 200 && res.status < 300, `${method} ${path}: ${res.status}`);
  }
  assert.equal(await prisma.auditLog.count({ where: { locationId: fx.locA, actorId: { in: [fx.outsider, fx.colleague] } } }), 0, 'every audit row names the manager');
  assert.equal((await prisma.rotaPublish.findFirstOrThrow({ where: { locationId: fx.locA } })).publishedById, fx.manager);
});

test('a colleague at the same venue can still be named on the 86 routes, and is recorded', async () => {
  const item = await send('POST', '/api/eighty-six', { itemName: `${TAG} olive`, station: 'Bar', createdById: fx.colleague });
  assert.equal(item.status, 201);
  assert.equal((await prisma.eightySixItem.findFirstOrThrow({ where: { locationId: fx.locA, itemName: `${TAG} olive` } })).createdById, fx.colleague);
});
