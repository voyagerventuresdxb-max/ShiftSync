import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../app.js';
import { issueSession } from '../lib/identity.js';

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

const TAG = '__rota-leave-test__';
const WEEK = '2031-04-07';
const MON = '2031-04-07';
const TUE = '2031-04-08';

async function fixture() {
  const org = await prisma.organization.create({ data: { name: `${TAG} org ${Date.now()}` } });
  const location = await prisma.location.create({ data: { organizationId: org.id, name: `${TAG} venue`, timezone: 'Asia/Dubai' } });
  const role = await prisma.role.create({ data: { locationId: location.id, name: `${TAG} Host` } });
  const manager = await prisma.user.create({ data: { locationId: location.id, fullName: `${TAG} manager`, systemRole: 'MANAGER' } });
  const staff = await prisma.user.create({ data: { locationId: location.id, fullName: `${TAG} staff`, systemRole: 'STAFF' } });
  const [mgr, stf] = await Promise.all([issueSession(manager.id), issueSession(staff.id)]);
  return { org, location, role, manager, staff, mgrToken: mgr.plainToken, staffToken: stf.plainToken };
}

type F = Awaited<ReturnType<typeof fixture>>;

function api(baseUrl: string, token: string | null) {
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
}

async function run(fn: (f: F, baseUrl: string) => Promise<void>) {
  const f = await fixture();
  try {
    await withServer((baseUrl) => fn(f, baseUrl));
  } finally {
    await prisma.organization.delete({ where: { id: f.org.id } }).catch(() => {});
  }
}

test('PUT /api/rota-leaves marks a DRAFT leave; staff/anonymous cannot see it until published, and publish flips it in the same call', () =>
  run(async (f, baseUrl) => {
    const mgr = api(baseUrl, f.mgrToken);
    const put = await mgr('PUT', '/api/rota-leaves', { userId: f.staff.id, date: MON, type: 'ANNUAL_LEAVE' });
    assert.equal(put.status, 201);
    assert.equal(put.body.leave.status, 'draft');

    const listAs = async (token: string | null) =>
      (await api(baseUrl, token)('GET', `/api/rota-leaves/${f.location.id}?weekStart=${WEEK}`)).body.leaves as { type: string }[];
    assert.equal((await listAs(f.mgrToken)).length, 1, 'manager sees the draft');
    assert.equal((await listAs(f.staffToken)).length, 0, 'staff never sees a draft');
    assert.equal((await listAs(null)).length, 0, 'anonymous kiosk never sees a draft');

    const status = await mgr('GET', `/api/shifts/${f.location.id}/publish-status?weekStart=${WEEK}`);
    assert.equal(status.body.publishedAt, null);

    // A leave-only week can be published, and the person on leave is notified.
    const pub = await mgr('POST', `/api/shifts/${f.location.id}/publish`, { weekStart: WEEK });
    assert.equal(pub.status, 200);
    assert.equal(pub.body.notifiedCount, 1);
    assert.equal((await listAs(f.staffToken))[0]?.type, 'ANNUAL_LEAVE');

    const after = await mgr('GET', `/api/shifts/${f.location.id}/publish-status?weekStart=${WEEK}`);
    assert.equal(after.body.hasUnpublishedChanges, false);
    // A new draft leave after publishing shows as an unpublished change.
    await mgr('PUT', '/api/rota-leaves', { userId: f.staff.id, date: TUE, type: 'SICK_LEAVE' });
    const again = await mgr('GET', `/api/shifts/${f.location.id}/publish-status?weekStart=${WEEK}`);
    assert.equal(again.body.hasUnpublishedChanges, true);

    const audit = await prisma.auditLog.findFirst({ where: { entityType: 'RotaLeave', entityId: put.body.leave.id } });
    assert.equal(audit?.actorId, f.manager.id);
    assert.equal(audit?.action, 'LEAVE_MARKED');
  }));

test('a blocking leave refuses a shift that day (REST create, bulk, and edit onto the day); HALF_DAY allows one', () =>
  run(async (f, baseUrl) => {
    const mgr = api(baseUrl, f.mgrToken);
    await mgr('PUT', '/api/rota-leaves', { userId: f.staff.id, date: MON, type: 'DAY_OFF' });
    const shift = { roleId: f.role.id, userId: f.staff.id, start: '17:00', end: '23:00' };

    const blocked = await mgr('POST', '/api/shifts', { ...shift, date: MON });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /Day Off/);

    const bulk = await mgr('POST', '/api/shifts/bulk', { shifts: [{ ...shift, date: TUE }, { ...shift, date: MON }] });
    assert.equal(bulk.status, 409, 'one blocked row rejects the whole batch');
    assert.equal(await prisma.shift.count({ where: { locationId: f.location.id } }), 0);

    const tue = await mgr('POST', '/api/shifts', { ...shift, date: TUE });
    assert.equal(tue.status, 201);
    const moved = await mgr('PATCH', `/api/shifts/${tue.body.shift.id}`, { date: MON });
    assert.equal(moved.status, 409, 'moving a shift onto a leave day is refused too');

    const half = await mgr('PUT', '/api/rota-leaves', { userId: f.staff.id, date: MON, type: 'HALF_DAY' });
    assert.equal(half.status, 200, 'changing the type of an existing row is an update, not a second row');
    const ok = await mgr('POST', '/api/shifts', { ...shift, date: MON, start: '18:00' });
    assert.equal(ok.status, 201, 'HALF_DAY may coexist with a shift');
  }));

test('a blocking leave is refused while the person already has a shift that day (409)', () =>
  run(async (f, baseUrl) => {
    const mgr = api(baseUrl, f.mgrToken);
    const created = await mgr('POST', '/api/shifts', { roleId: f.role.id, userId: f.staff.id, date: MON, start: '17:00', end: '23:00' });
    assert.equal(created.status, 201);
    const leave = await mgr('PUT', '/api/rota-leaves', { userId: f.staff.id, date: MON, type: 'SICK_LEAVE' });
    assert.equal(leave.status, 409);
    const half = await mgr('PUT', '/api/rota-leaves', { userId: f.staff.id, date: MON, type: 'HALF_DAY' });
    assert.equal(half.status, 201);
  }));

test('rota-leaves writes are manager-only, own venue only, and validate their input', () =>
  run(async (f, baseUrl) => {
    const staff = api(baseUrl, f.staffToken);
    assert.equal((await staff('PUT', '/api/rota-leaves', { userId: f.staff.id, date: MON, type: 'DAY_OFF' })).status, 403);
    const mgr = api(baseUrl, f.mgrToken);
    assert.equal((await mgr('PUT', '/api/rota-leaves', { userId: f.staff.id, date: MON, type: 'VACATION' })).status, 400);
    assert.equal((await mgr('PUT', '/api/rota-leaves', { userId: f.staff.id, date: '8 April', type: 'DAY_OFF' })).status, 400);

    const other = await prisma.location.create({ data: { organizationId: f.org.id, name: `${TAG} other`, timezone: 'Asia/Dubai' } });
    const outsider = await prisma.user.create({ data: { locationId: other.id, fullName: `${TAG} outsider` } });
    assert.equal((await mgr('PUT', '/api/rota-leaves', { userId: outsider.id, date: MON, type: 'DAY_OFF' })).status, 404);

    const put = await mgr('PUT', '/api/rota-leaves', { userId: f.staff.id, date: MON, type: 'DAY_OFF' });
    assert.equal((await staff('DELETE', `/api/rota-leaves/${put.body.leave.id}`)).status, 403);
    assert.equal((await mgr('DELETE', `/api/rota-leaves/${put.body.leave.id}`)).status, 204);
    assert.equal((await prisma.auditLog.findFirst({ where: { entityType: 'RotaLeave', entityId: put.body.leave.id, action: 'LEAVE_REMOVED' } }))?.actorId, f.manager.id);
    assert.equal(await prisma.rotaLeave.count({ where: { userId: f.staff.id } }), 0);
  }));

test('voice /execute honors the same rule: CREATE_SHIFT and EDIT_SHIFT onto a blocking-leave day are refused (409)', () =>
  run(async (f, baseUrl) => {
    const mgr = api(baseUrl, f.mgrToken);
    await mgr('PUT', '/api/rota-leaves', { userId: f.staff.id, date: MON, type: 'UNPAID_LEAVE' });
    const create = await mgr('POST', '/api/voice/execute', {
      transcript: 'put staff on monday 5 to 11',
      intent: { intent: 'CREATE_SHIFT', roleId: f.role.id, date: MON, start: '17:00', end: '23:00', userId: f.staff.id, confidence: 0.9, summary: 'x' },
    });
    assert.equal(create.status, 409);
    assert.match(create.body.error, /Unpaid Leave/);

    const tue = await mgr('POST', '/api/shifts', { roleId: f.role.id, userId: f.staff.id, date: TUE, start: '17:00', end: '23:00' });
    const edit = await mgr('POST', '/api/voice/execute', {
      transcript: 'move it to monday',
      intent: { intent: 'EDIT_SHIFT', shiftId: tue.body.shift.id, date: MON, confidence: 0.9, summary: 'x' },
    });
    assert.equal(edit.status, 409);
    assert.equal((await prisma.shift.findUnique({ where: { id: tue.body.shift.id } }))!.date.toISOString().slice(0, 10), TUE);
  }));

test('leave is refused on the other shift-writing paths too: template apply (409), swap approval (409), roster upload (row skipped)', () =>
  run(async (f, baseUrl) => {
    const mgr = api(baseUrl, f.mgrToken);
    await mgr('PUT', '/api/rota-leaves', { userId: f.staff.id, date: TUE, type: 'SICK_LEAVE' });

    // Template with the staff member on Tuesday (dayOffset 1 from WEEK).
    const template = await prisma.rotaTemplate.create({
      data: { locationId: f.location.id, name: `${TAG} tpl`, entries: [{ dayOffset: 1, roleId: f.role.id, userId: f.staff.id, start: '17:00', end: '23:00' }], createdById: f.manager.id },
    });
    const applied = await mgr('POST', `/api/rota-templates/${template.id}/apply`, { weekStart: WEEK });
    assert.equal(applied.status, 409);
    assert.match(applied.body.error, /Sick Leave/);
    assert.equal(await prisma.shift.count({ where: { locationId: f.location.id } }), 0);

    // A coworker asks the staff member (on leave Tuesday) to cover their Tuesday shift.
    const coworker = await prisma.user.create({ data: { locationId: f.location.id, fullName: `${TAG} coworker`, systemRole: 'STAFF' } });
    const shift = await prisma.shift.create({
      data: { locationId: f.location.id, roleId: f.role.id, userId: coworker.id, date: new Date(`${TUE}T00:00:00.000Z`), startTime: new Date(`${TUE}T13:00:00.000Z`), endTime: new Date(`${TUE}T19:00:00.000Z`), status: 'PUBLISHED' },
    });
    const swap = await prisma.shiftSwapRequest.create({
      data: { shiftId: shift.id, requestedById: coworker.id, targetUserId: f.staff.id, type: 'COVER', status: 'PENDING', expiresAt: new Date(Date.now() + 86_400_000) },
    });
    const decided = await mgr('PATCH', `/api/swap-requests/${swap.id}`, { decision: 'approved' });
    assert.equal(decided.status, 409);
    assert.equal((await prisma.shift.findUnique({ where: { id: shift.id } }))!.userId, coworker.id, 'the shift was not handed to someone on leave');

    // Roster upload confirm: the row for the person on leave is skipped, not imported over the leave.
    const { persistShifts } = await import('../parsing/persistShifts.js');
    const row = (userId: string, date: string, rowNumber: number) =>
      ({ rowNumber, date, startTime: '17:00', endTime: '23:00', overnight: false, breakMinutes: 0, managerNotes: null, resolvedRoleId: f.role.id, resolvedUserId: userId }) as unknown as Parameters<typeof persistShifts>[3][number];
    const persisted = await persistShifts(prisma, f.location.id, f.manager.id, [row(f.staff.id, TUE, 1), row(f.staff.id, MON, 2)]);
    assert.equal(persisted.createdCount, 1);
    assert.equal(persisted.blockedByLeaveCount, 1);
  }));

test('GET /api/rota-leaves: staff see only their own published leave; colleagues and the anonymous kiosk see none; bad dates are 400', () =>
  run(async (f, baseUrl) => {
    const mgr = api(baseUrl, f.mgrToken);
    await mgr('PUT', '/api/rota-leaves', { userId: f.staff.id, date: MON, type: 'SICK_LEAVE' });
    await mgr('POST', `/api/shifts/${f.location.id}/publish`, { weekStart: WEEK });
    const colleague = await prisma.user.create({ data: { locationId: f.location.id, fullName: `${TAG} colleague`, systemRole: 'STAFF' } });
    const colleagueToken = (await issueSession(colleague.id)).plainToken;

    const list = async (token: string | null) => (await api(baseUrl, token)('GET', `/api/rota-leaves/${f.location.id}?weekStart=${WEEK}`)).body.leaves as { userId: string }[];
    assert.deepEqual((await list(f.staffToken)).map((l) => l.userId), [f.staff.id]);
    assert.deepEqual(await list(colleagueToken), [], "a colleague never sees someone else's leave type");
    assert.deepEqual(await list(null), [], 'the anonymous kiosk never sees leave');
    assert.equal((await list(f.mgrToken)).length, 1);

    assert.equal((await mgr('PUT', '/api/rota-leaves', { userId: f.staff.id, date: '2031-02-31', type: 'DAY_OFF' })).status, 400);
    assert.equal((await mgr('GET', `/api/rota-leaves/${f.location.id}?weekStart=2031-13-01`)).status, 400);
  }));

test('rota template apply takes createdById from the session, never the body', () =>
  run(async (f, baseUrl) => {
    const template = await prisma.rotaTemplate.create({
      data: { locationId: f.location.id, name: `${TAG} tpl2`, entries: [{ dayOffset: 0, roleId: f.role.id, userId: null, start: '09:00', end: '12:00' }], createdById: f.manager.id },
    });
    const res = await api(baseUrl, f.mgrToken)('POST', `/api/rota-templates/${template.id}/apply`, { weekStart: WEEK, createdById: f.staff.id });
    assert.equal(res.status, 201);
    assert.equal((await prisma.shift.findFirst({ where: { locationId: f.location.id } }))!.createdById, f.manager.id);
  }));

test('voice publish preview counts leave: a leave-only week is publishable and its staff are counted', () =>
  run(async (f, baseUrl) => {
    await api(baseUrl, f.mgrToken)('PUT', '/api/rota-leaves', { userId: f.staff.id, date: MON, type: 'DAY_OFF' });
    const { getRotaPublishPreview } = await import('../lib/actions/rotaActions.js');
    assert.deepEqual(await getRotaPublishPreview(f.location.id, new Date(`${WEEK}T00:00:00.000Z`)), { shiftCount: 0, leaveCount: 1, staffCount: 1 });
  }));

async function notificationsFor(userId: string, expected: number) {
  const deadline = Date.now() + 3000;
  let rows = await prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  while (rows.length < expected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    rows = await prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  }
  return rows;
}

const LEAVE_WORDS = /day off|annual|sick|unpaid|half day/i;

test('changing or removing a PUBLISHED leave notifies only that staff member, and the copy never names the leave type', () =>
  run(async (f, baseUrl) => {
    const mgr = api(baseUrl, f.mgrToken);
    const colleague = await prisma.user.create({ data: { locationId: f.location.id, fullName: `${TAG} colleague`, systemRole: 'STAFF' } });
    const put = await mgr('PUT', '/api/rota-leaves', { userId: f.staff.id, date: MON, type: 'SICK_LEAVE' });
    assert.equal((await mgr('POST', `/api/shifts/${f.location.id}/publish`, { weekStart: WEEK })).status, 200);
    assert.equal((await notificationsFor(f.staff.id, 1))[0]?.title, 'Schedule updated'); // publish digest landed
    await prisma.notification.deleteMany({ where: { userId: { in: [f.staff.id, f.manager.id, colleague.id] } } });

    assert.equal((await mgr('PUT', '/api/rota-leaves', { userId: f.staff.id, date: MON, type: 'UNPAID_LEAVE' })).status, 200);
    const [updated] = await notificationsFor(f.staff.id, 1);
    assert.equal(updated?.title, 'Leave updated');
    assert.match(updated!.body, /^Your leave on \w{3} 7 Apr was updated\.$/);
    assert.doesNotMatch(`${updated!.title} ${updated!.body}`, LEAVE_WORDS);

    assert.equal((await mgr('DELETE', `/api/rota-leaves/${put.body.leave.id}`)).status, 204);
    const all = await notificationsFor(f.staff.id, 2);
    assert.equal(all[1]?.title, 'Leave removed');
    assert.match(all[1]!.body, /^Your leave on \w{3} 7 Apr was removed\.$/);
    assert.doesNotMatch(`${all[1]!.title} ${all[1]!.body}`, LEAVE_WORDS);

    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await prisma.notification.count({ where: { userId: { in: [f.manager.id, colleague.id] } } }), 0, 'managers and colleagues are not notified');
  }));

test('changing or removing a DRAFT leave, or re-saving the same type, notifies no one', () =>
  run(async (f, baseUrl) => {
    const mgr = api(baseUrl, f.mgrToken);
    const put = await mgr('PUT', '/api/rota-leaves', { userId: f.staff.id, date: MON, type: 'DAY_OFF' });
    await mgr('PUT', '/api/rota-leaves', { userId: f.staff.id, date: MON, type: 'ANNUAL_LEAVE' });
    await mgr('DELETE', `/api/rota-leaves/${put.body.leave.id}`);

    await mgr('PUT', '/api/rota-leaves', { userId: f.staff.id, date: TUE, type: 'DAY_OFF' });
    await mgr('POST', `/api/shifts/${f.location.id}/publish`, { weekStart: WEEK });
    await notificationsFor(f.staff.id, 1);
    await prisma.notification.deleteMany({ where: { userId: f.staff.id } });
    await mgr('PUT', '/api/rota-leaves', { userId: f.staff.id, date: TUE, type: 'DAY_OFF' }); // same type: no change
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await prisma.notification.count({ where: { userId: f.staff.id } }), 0);
  }));
