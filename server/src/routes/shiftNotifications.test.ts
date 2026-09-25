import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../app.js';
import { issueSession } from '../lib/identity.js';

/**
 * Published-week edits stay live and notify staff (golden-path v0,
 * 2026-09-25). The notification lives in lib/actions/shiftActions.ts's
 * editShift/removeShift, so REST and voice EDIT_SHIFT must behave the same.
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

const TAG = '__shift-notify-test__';
const WEEK = '2031-05-05';
const DAY = '2031-05-06';

async function fixture() {
  const org = await prisma.organization.create({ data: { name: `${TAG} org ${Date.now()}` } });
  const location = await prisma.location.create({ data: { organizationId: org.id, name: `${TAG} venue`, timezone: 'Asia/Dubai' } });
  const role = await prisma.role.create({ data: { locationId: location.id, name: `${TAG} Bar` } });
  const manager = await prisma.user.create({ data: { locationId: location.id, fullName: `${TAG} manager`, systemRole: 'MANAGER' } });
  const sara = await prisma.user.create({ data: { locationId: location.id, fullName: `${TAG} sara`, systemRole: 'STAFF' } });
  const omar = await prisma.user.create({ data: { locationId: location.id, fullName: `${TAG} omar`, systemRole: 'STAFF' } });
  const token = (await issueSession(manager.id)).plainToken;
  return { org, location, role, manager, sara, omar, token };
}
type F = Awaited<ReturnType<typeof fixture>>;

async function run(fn: (f: F, call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>) => Promise<void>) {
  const f = await fixture();
  try {
    await withServer(async (baseUrl) => {
      const call = async (method: string, path: string, body?: unknown) => {
        const res = await fetch(`${baseUrl}${path}`, {
          method,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${f.token}` },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
      };
      await fn(f, call);
    });
  } finally {
    await prisma.organization.delete({ where: { id: f.org.id } }).catch(() => {});
  }
}

/** Notifications are sent after commit, in the background — poll briefly rather than race them. */
async function notificationsFor(userId: string, expected: number) {
  const deadline = Date.now() + 3000;
  let rows = await prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  while (rows.length < expected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    rows = await prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  }
  return rows;
}

async function createAndMaybePublish(f: F, call: Parameters<Parameters<typeof run>[0]>[1], publish: boolean) {
  const created = await call('POST', '/api/shifts', { roleId: f.role.id, userId: f.sara.id, date: DAY, start: '17:00', end: '23:00' });
  assert.equal(created.status, 201);
  if (publish) {
    assert.equal((await call('POST', `/api/shifts/${f.location.id}/publish`, { weekStart: WEEK })).status, 200);
    // The publish digest is sent in the background too — wait for it to land
    // before clearing, or it arrives after the clear and reads as the change
    // notification under suite load.
    assert.equal((await notificationsFor(f.sara.id, 1))[0]?.title, 'Schedule updated');
  }
  // Clear the publish digest so each test only sees the change notification.
  await prisma.notification.deleteMany({ where: { userId: { in: [f.sara.id, f.omar.id] } } });
  return created.body.shift.id as string;
}

test('editing a DRAFT shift notifies no one', () =>
  run(async (f, call) => {
    const id = await createAndMaybePublish(f, call, false);
    assert.equal((await call('PATCH', `/api/shifts/${id}`, { start: '18:00' })).status, 200);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await notificationsFor(f.sara.id, 0)).length, 0);
  }));

test('REST: changing a PUBLISHED shift\'s times notifies its staff member, in venue time; the week stays "published"', () =>
  run(async (f, call) => {
    const id = await createAndMaybePublish(f, call, true);
    assert.equal((await call('PATCH', `/api/shifts/${id}`, { start: '18:00', end: '23:30' })).status, 200);
    const [n] = await notificationsFor(f.sara.id, 1);
    assert.equal(n?.title, 'Shift changed');
    assert.equal(n?.body, 'Your shift on Tue 6 May · 17:00–23:00 is now Tue 6 May · 18:00–23:30.');
    const status = await call('GET', `/api/shifts/${f.location.id}/publish-status?weekStart=${WEEK}`);
    assert.equal(status.body.hasUnpublishedChanges, false, 'a live edit is not an unpublished change');
    assert.equal((await prisma.shift.findUnique({ where: { id } }))!.status, 'PUBLISHED');
  }));

test('REST: reassigning a PUBLISHED shift tells the old assignee it was removed and the new one they were added', () =>
  run(async (f, call) => {
    const id = await createAndMaybePublish(f, call, true);
    assert.equal((await call('PATCH', `/api/shifts/${id}`, { userId: f.omar.id })).status, 200);
    assert.equal((await notificationsFor(f.sara.id, 1))[0]?.title, 'Shift removed');
    assert.equal((await notificationsFor(f.omar.id, 1))[0]?.title, 'You were added to a shift');
  }));

test('REST: deleting a PUBLISHED shift tells its staff member; deleting a DRAFT tells no one', () =>
  run(async (f, call) => {
    const id = await createAndMaybePublish(f, call, true);
    assert.equal((await call('DELETE', `/api/shifts/${id}`)).status, 204);
    const [n] = await notificationsFor(f.sara.id, 1);
    assert.equal(n?.body, 'Your shift on Tue 6 May · 17:00–23:00 was removed.');
    const audit = await prisma.auditLog.findFirst({ where: { entityId: id, action: 'SHIFT_DELETED' } });
    assert.equal(audit?.actorId, f.manager.id);

    await prisma.notification.deleteMany({ where: { userId: f.sara.id } });
    const draft = await call('POST', '/api/shifts', { roleId: f.role.id, userId: f.sara.id, date: DAY, start: '09:00', end: '12:00' });
    assert.equal((await call('DELETE', `/api/shifts/${draft.body.shift.id}`)).status, 204);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await notificationsFor(f.sara.id, 0)).length, 0);
  }));

test('voice EDIT_SHIFT on a PUBLISHED shift notifies exactly like REST (shared mutator)', () =>
  run(async (f, call) => {
    const id = await createAndMaybePublish(f, call, true);
    const res = await call('POST', '/api/voice/execute', {
      transcript: 'move sara to six till half eleven',
      intent: { intent: 'EDIT_SHIFT', shiftId: id, start: '18:00', end: '23:30', confidence: 0.95, summary: 'x' },
    });
    assert.equal(res.status, 200);
    const [n] = await notificationsFor(f.sara.id, 1);
    assert.equal(n?.body, 'Your shift on Tue 6 May · 17:00–23:00 is now Tue 6 May · 18:00–23:30.');
    const audit = await prisma.auditLog.findFirst({ where: { entityId: id, action: 'SHIFT_UPDATED' } });
    assert.match(audit?.note ?? '', /^\[voice\]/);
  }));

// A shift takes the publish state of the week it lives in (2026-09-25).
const NEXT_WEEK = '2031-05-12';
const NEXT_TUE = '2031-05-13';

test('moving a PUBLISHED shift into an unpublished week makes it DRAFT, hides it from staff, and tells them it was removed', () =>
  run(async (f, call) => {
    const id = await createAndMaybePublish(f, call, true);
    const moved = await call('PATCH', `/api/shifts/${id}`, { date: NEXT_TUE });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.shift.status, 'draft');
    assert.equal((await prisma.shift.findUnique({ where: { id } }))!.status, 'DRAFT');
    const [n] = await notificationsFor(f.sara.id, 1);
    assert.equal(n?.title, 'Shift removed');
    assert.equal(n?.body, 'Your shift on Tue 6 May · 17:00–23:00 was removed.');
    // DRAFT = invisible to staff and the kiosk (lib/shiftVisibility.ts, covered in shiftVisibility.test.ts).
    assert.equal(await prisma.shift.count({ where: { userId: f.sara.id, status: 'PUBLISHED' } }), 0);
  }));

test('moving a PUBLISHED shift into a published week keeps it live and sends the normal change notification', () =>
  run(async (f, call) => {
    // Publish next week first (it needs something in it).
    await call('POST', '/api/shifts', { roleId: f.role.id, userId: f.omar.id, date: NEXT_TUE, start: '10:00', end: '14:00' });
    assert.equal((await call('POST', `/api/shifts/${f.location.id}/publish`, { weekStart: NEXT_WEEK })).status, 200);
    const id = await createAndMaybePublish(f, call, true);
    await prisma.notification.deleteMany({ where: { userId: { in: [f.sara.id, f.omar.id] } } });

    const moved = await call('PATCH', `/api/shifts/${id}`, { date: NEXT_TUE });
    assert.equal(moved.status, 200);
    assert.equal((await prisma.shift.findUnique({ where: { id } }))!.status, 'PUBLISHED');
    const [n] = await notificationsFor(f.sara.id, 1);
    assert.equal(n?.title, 'Shift changed');
    assert.equal(n?.body, 'Your shift on Tue 6 May · 17:00–23:00 is now Tue 13 May · 17:00–23:00.');
  }));

test('voice EDIT_SHIFT follows the same week-state rule (shared mutator)', () =>
  run(async (f, call) => {
    const id = await createAndMaybePublish(f, call, true);
    const res = await call('POST', '/api/voice/execute', {
      transcript: 'move it to next tuesday',
      intent: { intent: 'EDIT_SHIFT', shiftId: id, date: NEXT_TUE, confidence: 0.9, summary: 'x' },
    });
    assert.equal(res.status, 200);
    assert.equal((await prisma.shift.findUnique({ where: { id } }))!.status, 'DRAFT');
    assert.equal((await notificationsFor(f.sara.id, 1))[0]?.title, 'Shift removed');
  }));

test('a DRAFT shift moved into a published week stays DRAFT (never auto-published) and notifies no one', () =>
  run(async (f, call) => {
    await call('POST', '/api/shifts', { roleId: f.role.id, userId: f.omar.id, date: NEXT_TUE, start: '10:00', end: '14:00' });
    assert.equal((await call('POST', `/api/shifts/${f.location.id}/publish`, { weekStart: NEXT_WEEK })).status, 200);
    const id = await createAndMaybePublish(f, call, false);
    await prisma.notification.deleteMany({ where: { userId: { in: [f.sara.id, f.omar.id] } } });
    assert.equal((await call('PATCH', `/api/shifts/${id}`, { date: NEXT_TUE })).status, 200);
    assert.equal((await prisma.shift.findUnique({ where: { id } }))!.status, 'DRAFT');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await notificationsFor(f.sara.id, 0)).length, 0);
  }));
