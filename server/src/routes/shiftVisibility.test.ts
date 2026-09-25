import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../app.js';
import { issueSession } from '../lib/identity.js';
import { requireManager } from '../middleware/requireSession.js';

/**
 * Golden-path v0 security (2026-09-25): drafts are manager-only on every
 * read, actor ids always come from the session, and `requireManager` is a
 * positive allowlist.
 */
const prisma = new PrismaClient();

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
  return (await issueSession(userId)).plainToken;
}

const TAG = '__visibility-test__';
// A Monday far enough ahead that /my-shifts (today onward) always includes it.
const WEEK = '2031-03-03';
const DAY = '2031-03-04';

async function fixture() {
  const org = await prisma.organization.create({ data: { name: `${TAG} org ${Date.now()}` } });
  const location = await prisma.location.create({ data: { organizationId: org.id, name: `${TAG} venue`, timezone: 'Asia/Dubai' } });
  const otherLocation = await prisma.location.create({ data: { organizationId: org.id, name: `${TAG} other venue`, timezone: 'Asia/Dubai' } });
  const role = await prisma.role.create({ data: { locationId: location.id, name: `${TAG} Bartender` } });
  const manager = await prisma.user.create({ data: { locationId: location.id, fullName: `${TAG} manager`, systemRole: 'MANAGER' } });
  const otherManager = await prisma.user.create({ data: { locationId: otherLocation.id, fullName: `${TAG} other manager`, systemRole: 'MANAGER' } });
  const staff = await prisma.user.create({ data: { locationId: location.id, fullName: `${TAG} staff`, systemRole: 'STAFF' } });
  const coworker = await prisma.user.create({ data: { locationId: location.id, fullName: `${TAG} coworker`, systemRole: 'STAFF' } });
  const mk = (status: 'DRAFT' | 'PUBLISHED', hour: number) =>
    prisma.shift.create({
      data: {
        locationId: location.id,
        roleId: role.id,
        userId: staff.id,
        date: new Date(`${DAY}T00:00:00.000Z`),
        startTime: new Date(`${DAY}T${String(hour).padStart(2, '0')}:00:00.000Z`),
        endTime: new Date(`${DAY}T${String(hour + 4).padStart(2, '0')}:00:00.000Z`),
        status,
      },
    });
  const draft = await mk('DRAFT', 5);
  const published = await mk('PUBLISHED', 12);
  return { org, location, role, manager, otherManager, staff, coworker, draft, published };
}

async function teardown(orgId: string) {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
}

test('GET /api/shifts/:locationId — drafts only for a manager of that venue; staff, anonymous and other-venue managers get PUBLISHED only', async () => {
  const f = await fixture();
  try {
    const [mgrToken, staffToken, otherMgrToken] = await Promise.all([sessionFor(f.manager.id), sessionFor(f.staff.id), sessionFor(f.otherManager.id)]);
    await withServer(async (baseUrl) => {
      const ids = async (token?: string) => {
        const res = await fetch(`${baseUrl}/api/shifts/${f.location.id}?weekStart=${WEEK}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        assert.equal(res.status, 200);
        return ((await res.json()) as { shifts: { id: string }[] }).shifts.map((s) => s.id).sort();
      };
      assert.deepEqual(await ids(), [f.published.id], 'anonymous kiosk read must not see drafts');
      assert.deepEqual(await ids(staffToken), [f.published.id], 'staff must not see drafts');
      assert.deepEqual(await ids(otherMgrToken), [f.published.id], "another venue's manager must not see this venue's drafts");
      assert.deepEqual(await ids('not-a-real-token'), [f.published.id], 'an invalid token is treated as anonymous');
      assert.deepEqual(await ids(mgrToken), [f.draft.id, f.published.id].sort(), 'a manager of the venue sees drafts');
    });
  } finally {
    await teardown(f.org.id);
  }
});

test('GET /api/my-shifts never returns a draft', async () => {
  const f = await fixture();
  try {
    const token = await sessionFor(f.staff.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/my-shifts`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { shifts: { id: string }[] };
      assert.deepEqual(body.shifts.map((s) => s.id), [f.published.id]);
    });
  } finally {
    await teardown(f.org.id);
  }
});

test('POST /api/swap-requests — a STAFF session cannot file a swap on its own DRAFT shift (404)', async () => {
  const f = await fixture();
  try {
    const token = await sessionFor(f.staff.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/swap-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ locationId: f.location.id, shiftId: f.draft.id, targetUserId: f.coworker.id }),
      });
      assert.equal(res.status, 404);
      // Control: the identical request on the PUBLISHED shift goes through,
      // so the 404 above is the draft rule, not some other validation.
      const ok = await fetch(`${baseUrl}/api/swap-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ locationId: f.location.id, shiftId: f.published.id, targetUserId: f.coworker.id }),
      });
      assert.equal(ok.status, 201);
    });
    assert.equal(await prisma.shiftSwapRequest.count({ where: { shiftId: f.draft.id } }), 0);
  } finally {
    await teardown(f.org.id);
  }
});

test('actor ids come from the session: body createdById/publishedById naming a STAFF member are ignored', async () => {
  const f = await fixture();
  try {
    const token = await sessionFor(f.manager.id);
    await withServer(async (baseUrl) => {
      const created = await fetch(`${baseUrl}/api/shifts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ roleId: f.role.id, userId: f.staff.id, date: DAY, start: '18:00', end: '23:00', createdById: f.staff.id }),
      });
      assert.equal(created.status, 201);
      const { shift } = (await created.json()) as { shift: { id: string } };
      const row = await prisma.shift.findUnique({ where: { id: shift.id } });
      assert.equal(row!.createdById, f.manager.id);
      const audit = await prisma.auditLog.findFirst({ where: { entityId: shift.id, action: 'SHIFT_CREATED' } });
      assert.equal(audit!.actorId, f.manager.id);

      const pub = await fetch(`${baseUrl}/api/shifts/${f.location.id}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ weekStart: WEEK, publishedById: f.staff.id }),
      });
      assert.equal(pub.status, 200);
      const rp = await prisma.rotaPublish.findFirst({ where: { locationId: f.location.id } });
      assert.equal(rp!.publishedById, f.manager.id, 'RotaPublish must name the signed-in manager, never a body-supplied id');
    });
  } finally {
    await teardown(f.org.id);
  }
});

test('requireManager is a positive allowlist — an unknown role is refused (fail-closed)', () => {
  const run = (systemRole: string) => {
    let status = 0;
    let nextCalled = false;
    const res = { status: (s: number) => ((status = s), { json: () => undefined }) };
    requireManager({ user: { systemRole } } as never, res as never, () => (nextCalled = true));
    return { status, nextCalled };
  };
  assert.deepEqual(run('OWNER'), { status: 0, nextCalled: true });
  assert.deepEqual(run('MANAGER'), { status: 0, nextCalled: true });
  assert.deepEqual(run('STAFF'), { status: 403, nextCalled: false });
  assert.deepEqual(run('SUPERVISOR'), { status: 403, nextCalled: false });
  assert.deepEqual(run(''), { status: 403, nextCalled: false });
});
