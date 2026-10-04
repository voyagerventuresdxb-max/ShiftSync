import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../app.js';
import { issueSession } from '../lib/identity.js';
import { createSwapRequest } from '../lib/actions/swapActions.js';
import { requestWindowCloseForShift, SwapWindowClosedError } from '../lib/swapRequestPolicy.js';

/**
 * The cover-request window is enforced on the server: once Wednesday 17:00 (venue time) of a
 * shift's week has passed, nobody can file a new request for that shift — through REST or voice —
 * while a manager can still decide requests already filed.
 */
const prisma = new PrismaClient();
const TZ = 'Asia/Dubai';
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const LAST_WEEK = iso(-7); // its week's window closed at least a few days ago
const NEXT_WEEK = iso(7); // its week's window is still days away

let locationId = '';
let roleId = '';
const ids = { requester: '', target: '', manager: '' };
const shifts = { closed: '', open: '' };

async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = createApp();
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
const tokenFor = async (userId: string) => (await issueSession(userId)).plainToken;
const shiftOn = (day: string) =>
  prisma.shift.create({
    data: { locationId, roleId, userId: ids.requester, date: new Date(`${day}T00:00:00.000Z`), startTime: new Date(`${day}T05:00:00.000Z`), endTime: new Date(`${day}T13:00:00.000Z`), status: 'PUBLISHED' },
  });

before(async () => {
  const seed = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seed, 'seed data (a location) must exist');
  const location = await prisma.location.create({ data: { organizationId: seed!.organizationId, name: '__swapwindow-test__ venue', timezone: TZ } });
  locationId = location.id;
  roleId = (await prisma.role.create({ data: { locationId, name: '__swapwindow-test__ role' } })).id;
  ids.requester = (await prisma.user.create({ data: { locationId, fullName: '__swapwindow-test__ requester', systemRole: 'STAFF' } })).id;
  ids.target = (await prisma.user.create({ data: { locationId, fullName: '__swapwindow-test__ cover', systemRole: 'STAFF' } })).id;
  ids.manager = (await prisma.user.create({ data: { locationId, fullName: '__swapwindow-test__ manager', systemRole: 'MANAGER' } })).id;
  shifts.closed = (await shiftOn(LAST_WEEK)).id;
  shifts.open = (await shiftOn(NEXT_WEEK)).id;
});

after(async () => {
  const userIds = Object.values(ids);
  await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.shiftSwapRequest.deleteMany({ where: { shift: { locationId } } });
  await prisma.auditLog.deleteMany({ where: { locationId } });
  await prisma.shift.deleteMany({ where: { locationId } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { locationId } });
  await prisma.role.deleteMany({ where: { locationId } });
  await prisma.location.delete({ where: { id: locationId } });
  await prisma.$disconnect();
});

async function postSwap(shiftId: string) {
  const token = await tokenFor(ids.requester);
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/swap-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ shiftId, targetUserId: ids.target }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  });
}

test('REST: a request for a shift whose week has closed is refused with a clear 409, and nothing is written', async () => {
  const { status, body } = await postSwap(shifts.closed);
  assert.equal(status, 409);
  assert.equal(body.errorCode, 'swap_window_closed');
  assert.match(body.error, /closed on \w+day \d{1,2} \w{3} at 17:00 \(venue time\)/);
  assert.match(body.error, /Ask your manager directly/);
  assert.equal(await prisma.shiftSwapRequest.count({ where: { shiftId: shifts.closed } }), 0);
});

test('REST: a request for a shift in an open week is filed, and expires when that week closes', async () => {
  const { status, body } = await postSwap(shifts.open);
  assert.equal(status, 201, JSON.stringify(body));
  assert.equal(body.request.expiresAt, requestWindowCloseForShift(NEXT_WEEK, TZ).toISOString());
});

test('voice REQUEST_SWAP for a closed week gets the same 409 and writes nothing', async () => {
  const token = await tokenFor(ids.requester);
  const res = await withServer((base) =>
    fetch(`${base}/api/voice/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        transcript: 'ask my colleague to cover my shift',
        intent: { intent: 'REQUEST_SWAP', shiftId: shifts.closed, targetUserId: ids.target, targetUserName: '__swapwindow-test__ cover', reason: null, summary: 'Request a cover swap.' },
      }),
    }),
  );
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { errorCode?: string }).errorCode, 'swap_window_closed');
  assert.equal(await prisma.shiftSwapRequest.count({ where: { shiftId: shifts.closed } }), 0);
});

test('a manager can still decide a request filed before its week closed', async () => {
  const request = await prisma.shiftSwapRequest.create({
    data: { shiftId: shifts.closed, requestedById: ids.requester, targetUserId: ids.target, type: 'COVER', status: 'PENDING', reason: null, expiresAt: requestWindowCloseForShift(LAST_WEEK, TZ) },
  });
  const token = await tokenFor(ids.manager);
  const res = await withServer((base) =>
    fetch(`${base}/api/swap-requests/${request.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ decision: 'approved' }),
    }),
  );
  assert.equal(res.status, 200, await res.text());
  assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: shifts.closed } })).userId, ids.target);
  await prisma.shift.update({ where: { id: shifts.closed }, data: { userId: ids.requester } }); // restore for the other tests
});

test('boundary, with an injected clock: open at Wednesday 16:59 venue time, closed at exactly 17:00', async () => {
  const close = requestWindowCloseForShift(NEXT_WEEK, TZ);
  const input = { shiftId: shifts.open, requestedById: ids.requester, targetUserId: ids.target, reason: null };
  const filed = await createSwapRequest(input, prisma, new Date(close.getTime() - 60_000));
  assert.equal(filed.expiresAt.toISOString(), close.toISOString());
  await assert.rejects(createSwapRequest(input, prisma, close), (err: unknown) => err instanceof SwapWindowClosedError);
});
