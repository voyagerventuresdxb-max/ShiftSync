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
