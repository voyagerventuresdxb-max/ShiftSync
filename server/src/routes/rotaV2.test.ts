import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../app.js';
import { issueSession } from '../lib/identity.js';
import { venueToday } from '../lib/venueTime.js';
import type { WeekDocDto, WeekPatchOp } from '../../../shared/rotaWeek.js';

/**
 * Rota builder v2 routes through the real app: the week document API (shapes
 * of 200 / 409 / 422, what a staff session may see), shift types,
 * departments, time-off requests and their approval through the week patch,
 * /api/my-shifts' v2 fields, attendance's shift auto-match and v2 templates.
 * One venue ("Demo Venue") in its own organization; every week used is in
 * the future, one per test, so no test shares a version counter.
 */
const prisma = new PrismaClient();
const TAG = '__rota-v2-routes__';
const TZ = 'Asia/Dubai';

let server: Server;
let baseUrl = '';
let orgId = '';
let locationId = '';
let otherLocationId = '';
let floorRoleId = '';
let barRoleId = '';
let otherVenueRoleId = '';
let managerId = '';
let personA = '';
let personB = '';
const tokens = { manager: '', personA: '', personB: '' };
let weekCounter = 6;

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** The Monday `weeksAhead` weeks from now (UTC calendar). */
function mondayAhead(weeksAhead: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + weeksAhead * 7);
  return d.toISOString().slice(0, 10);
}
const nextWeek = () => mondayAhead(weekCounter++);
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

async function api<T = Record<string, unknown>>(token: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}
const getWeek = (token: string, week: string) => api<WeekDocDto>(token, 'GET', `/api/weeks/${locationId}/${week}`);
const patchWeek = (week: string, ops: WeekPatchOp[], extra: Record<string, unknown> = {}) =>
  api<Record<string, unknown> & { version: number; results: { shiftId?: string }[]; week: WeekDocDto }>(tokens.manager, 'PATCH', `/api/weeks/${locationId}/${week}`, { ops, ...extra });
async function publish(week: string) {
  const preview = await api<{ fingerprint: string; version: number }>(tokens.manager, 'POST', `/api/weeks/${locationId}/${week}/publish-preview`);
  assert.equal(preview.status, 200);
  const done = await api(tokens.manager, 'POST', `/api/weeks/${locationId}/${week}/publish`, { expectedVersion: preview.body.version, fingerprint: preview.body.fingerprint });
  assert.equal(done.status, 200, JSON.stringify(done.body));
}

before(async () => {
  const org = await prisma.organization.create({ data: { name: `${TAG} org` } });
  orgId = org.id;
  locationId = (await prisma.location.create({ data: { organizationId: orgId, name: `${TAG} Demo Venue`, timezone: TZ } })).id;
  otherLocationId = (await prisma.location.create({ data: { organizationId: orgId, name: `${TAG} Other Venue`, timezone: TZ } })).id;
  floorRoleId = (await prisma.role.create({ data: { locationId, name: 'Waiter' } })).id;
  barRoleId = (await prisma.role.create({ data: { locationId, name: 'Bartender' } })).id;
  otherVenueRoleId = (await prisma.role.create({ data: { locationId: otherLocationId, name: 'Waiter' } })).id;
  managerId = (await prisma.user.create({ data: { locationId, fullName: 'Demo Manager', systemRole: 'MANAGER' } })).id;
  personA = (await prisma.user.create({ data: { locationId, fullName: 'Person A', systemRole: 'STAFF', roleId: floorRoleId } })).id;
  personB = (await prisma.user.create({ data: { locationId, fullName: 'Person B', systemRole: 'STAFF', roleId: barRoleId } })).id;
  tokens.manager = (await issueSession(managerId)).plainToken;
  tokens.personA = (await issueSession(personA)).plainToken;
  tokens.personB = (await issueSession(personB)).plainToken;
  server = await new Promise<Server>((resolve) => {
    const s = createApp().listen(0, () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  // Shifts first: their role foreign key is RESTRICT, which a cascade from the venue would trip over.
  await prisma.attendanceLog.deleteMany({ where: { user: { location: { organizationId: orgId } } } });
  await prisma.shift.deleteMany({ where: { location: { organizationId: orgId } } });
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

test('weeks API: 200 / 409 / 422 / 400 shapes; staff are refused writes and see only what they were told', async () => {
  const week = nextWeek();
  const wed = addDays(week, 2);

  const created = await patchWeek(week, [{ op: 'create', userId: personA, date: wed, ranges: [{ start: '09:00', end: '17:00' }], tempId: 't1' }], { expectedVersion: 1 });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.result, 'ok');
  assert.equal(created.body.version, 2);
  const shiftId = created.body.results[0]!.shiftId!;

  const stale = await patchWeek(week, [{ op: 'delete', shiftId }], { expectedVersion: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.result, 'version_conflict');
  assert.equal(stale.body.currentVersion, 2);
  assert.ok(stale.body.week, 'a conflict carries the current week');

  const clash = await patchWeek(week, [{ op: 'create', userId: personA, date: wed, ranges: [{ start: '18:00', end: '22:00' }] }], { expectedVersion: 2 });
  assert.equal(clash.status, 422);
  assert.equal(clash.body.refusal, 'already_has_shift');
  assert.equal(clash.body.op, 0);
  assert.equal(typeof clash.body.error, 'string');

  assert.equal((await patchWeek(week, [])).status, 400, 'an empty batch is a 400');
  assert.equal((await api(tokens.manager, 'GET', `/api/weeks/${locationId}/${addDays(week, 1)}`)).status, 400, 'not a Monday');
  assert.equal((await api(tokens.personA, 'PATCH', `/api/weeks/${locationId}/${week}`, { ops: [{ op: 'delete', shiftId }] })).status, 403);
  assert.equal((await api(tokens.personA, 'POST', `/api/weeks/${locationId}/${week}/publish-preview`)).status, 403);
  assert.equal((await api(null, 'GET', `/api/weeks/${locationId}/${week}`)).status, 401);

  // Draft: the manager sees it, staff do not, and staff are not told there is unpublished work.
  const staffDraft = await getWeek(tokens.personA, week);
  assert.equal(staffDraft.status, 200);
  assert.equal(staffDraft.body.shifts.length, 0, 'a draft never reaches staff');
  assert.equal(staffDraft.body.hasUnpublishedChanges, false);
  assert.equal((await getWeek(tokens.manager, week)).body.shifts.length, 1);

  await publish(week);
  const staffPublished = await getWeek(tokens.personB, week);
  assert.equal(staffPublished.body.shifts.length, 1, 'published: every staff member sees it');

  // An edit after publish: the manager sees the new times with the gold dot; staff keep seeing what they were told.
  const edited = await patchWeek(week, [{ op: 'update', shiftId, ranges: [{ start: '12:00', end: '20:00' }] }]);
  assert.equal(edited.status, 200);
  const managerView = (await getWeek(tokens.manager, week)).body.shifts.find((s) => s.id === shiftId)!;
  assert.deepEqual(managerView.ranges, [{ start: '12:00', end: '20:00' }]);
  assert.equal(managerView.editedSincePublish, true);
  const staffView = (await getWeek(tokens.personA, week)).body.shifts.find((s) => s.id === shiftId)!;
  assert.deepEqual(staffView.ranges, [{ start: '09:00', end: '17:00' }], 'staff see the published times until the next publish');
  assert.equal(staffView.editedSincePublish, false);

  // A removal after publish: still there for staff (they have not been told), gone after the next publish.
  assert.equal((await patchWeek(week, [{ op: 'delete', shiftId }])).status, 200);
  assert.equal((await getWeek(tokens.manager, week)).body.shifts.length, 0);
  assert.equal((await getWeek(tokens.personA, week)).body.shifts.length, 1);
  await publish(week);
  assert.equal((await getWeek(tokens.personA, week)).body.shifts.length, 0);
});

test('a staff viewer never sees another person\'s pending request, nor a draft leave', async () => {
  const week = nextWeek();
  const thu = addDays(week, 3);
  const created = await patchWeek(week, [
    { op: 'create', userId: personB, date: thu, ranges: [{ start: '16:00', end: '23:00' }] },
    { op: 'setLeave', userId: personA, date: addDays(week, 4), type: 'DAY_OFF' },
  ]);
  assert.equal(created.status, 200);
  await publish(week);
  await prisma.timeOffRequest.create({ data: { userId: personB, startDate: day(thu), endDate: day(thu), status: 'PENDING', expiresAt: day(addDays(thu, 1)) } });
  await patchWeek(week, [{ op: 'setLeave', userId: personA, date: addDays(week, 5), type: 'SICK_LEAVE' }]);

  const asA = (await getWeek(tokens.personA, week)).body;
  assert.equal(asA.shifts[0]!.pendingRequestId, null, "another person's request id is not shown");
  assert.equal(asA.requests.length, 0);
  assert.deepEqual(asA.leaves.map((l) => l.type), ['DAY_OFF'], 'the draft sick day is not shown');
  const asB = (await getWeek(tokens.personB, week)).body;
  assert.ok(asB.shifts[0]!.pendingRequestId, 'the requester sees their own request on their shift');
  assert.equal(asB.requests.length, 1);
  const asManager = (await getWeek(tokens.manager, week)).body;
  assert.equal(asManager.leaves.length, 2);
});

test('shift types: create, name taken 409, bad input 400, edits never rewrite shifts, archive, bulk skips existing names', async () => {
  const base = `/api/shift-types/${locationId}`;
  const evening = await api<{ shiftType: { id: string; endsNextDay: boolean; tint: string } }>(tokens.manager, 'POST', base, {
    name: 'Evening',
    ranges: [{ start: '16:00', end: '01:00' }],
    tint: 'clay',
  });
  assert.equal(evening.status, 201, JSON.stringify(evening.body));
  assert.equal(evening.body.shiftType.endsNextDay, true);
  const typeId = evening.body.shiftType.id;
  assert.equal((await api(tokens.manager, 'POST', base, { name: ' evening ', ranges: [{ start: '17:00', end: '23:00' }], tint: 'gold' })).status, 409);
  assert.equal((await api(tokens.manager, 'POST', base, { name: 'Late', ranges: [{ start: '17:00', end: '23:00' }], tint: 'red' })).status, 400);
  assert.equal((await api(tokens.manager, 'POST', base, { name: 'Late', ranges: [{ start: '23:00', end: '02:00' }, { start: '03:00', end: '05:00' }], tint: 'gold' })).status, 400);
  assert.equal((await api(tokens.personA, 'POST', base, { name: 'Late', ranges: [{ start: '17:00', end: '23:00' }], tint: 'gold' })).status, 403);
  assert.equal((await api(tokens.personA, 'GET', base)).status, 200, 'staff may read the venue\'s types');

  const week = nextWeek();
  const made = await patchWeek(week, [{ op: 'create', userId: personA, date: addDays(week, 1), shiftTypeId: typeId }]);
  assert.equal(made.status, 200);
  const shiftId = made.body.results[0]!.shiftId!;
  const edited = await api<{ shiftType: { endsNextDay: boolean } }>(tokens.manager, 'PATCH', `${base}/${typeId}`, { ranges: [{ start: '17:00', end: '22:00' }] });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.shiftType.endsNextDay, false);
  const chip = (await getWeek(tokens.manager, week)).body.shifts.find((s) => s.id === shiftId)!;
  assert.deepEqual(chip.ranges, [{ start: '16:00', end: '01:00' }], 'the shift kept the times it was made with');
  assert.equal(chip.shiftTypeId, typeId);

  const archived = await api<{ shiftType: { archivedAt: string | null } }>(tokens.manager, 'POST', `${base}/${typeId}/archive`);
  assert.equal(archived.status, 200);
  assert.ok(archived.body.shiftType.archivedAt);
  const refused = await patchWeek(week, [{ op: 'create', userId: personB, date: addDays(week, 2), shiftTypeId: typeId }]);
  assert.equal(refused.status, 422);
  assert.equal(refused.body.refusal, 'unknown_shift_type');
  // A shift made from it keeps its label when only its times change.
  assert.equal((await patchWeek(week, [{ op: 'update', shiftId, ranges: [{ start: '15:00', end: '23:00' }] }])).status, 200);

  const bulk = await api<{ shiftTypes: { name: string; sortOrder: number }[]; skipped: string[] }>(tokens.manager, 'POST', `${base}/bulk`, {
    shiftTypes: [
      { name: 'Evening', ranges: [{ start: '16:00', end: '01:00' }], tint: 'clay' },
      { name: 'Brunch', ranges: [{ start: '10:00', end: '16:00' }], tint: 'sand' },
    ],
  });
  assert.equal(bulk.status, 200);
  assert.deepEqual(bulk.body.skipped, ['Evening']);
  assert.ok(bulk.body.shiftTypes.some((t) => t.name === 'Brunch'));
  assert.equal(bulk.body.shiftTypes.filter((t) => t.name === 'Evening').length, 1);
  const audits = await prisma.auditLog.findMany({ where: { locationId, entityType: 'ShiftType' }, select: { action: true } });
  for (const action of ['SHIFT_TYPE_CREATED', 'SHIFT_TYPE_UPDATED', 'SHIFT_TYPE_ARCHIVED'] as const) assert.ok(audits.some((a) => a.action === action), action);
  assert.equal((await api(tokens.manager, 'PATCH', `/api/shift-types/${otherLocationId}/${typeId}`, { tint: 'gold' })).status, 403);
});

test('departments: roles of the venue only, roleIds replaces the set, minimums feed the coverage row', async () => {
  const base = `/api/departments/${locationId}`;
  const bar = await api<{ department: { id: string; roleIds: string[] } }>(tokens.manager, 'POST', base, { name: 'Bar', tint: 'gold', roleIds: [barRoleId] });
  assert.equal(bar.status, 201, JSON.stringify(bar.body));
  assert.deepEqual(bar.body.department.roleIds, [barRoleId]);
  const barId = bar.body.department.id;
  assert.equal((await api(tokens.manager, 'POST', base, { name: 'bar', tint: 'gold' })).status, 409);
  assert.equal((await api(tokens.manager, 'POST', base, { name: 'Floor', tint: 'gold', roleIds: [otherVenueRoleId] })).status, 404, "another venue's role");
  assert.equal((await api(tokens.personA, 'POST', base, { name: 'Floor', tint: 'gold' })).status, 403);

  const moved = await api<{ department: { roleIds: string[] } }>(tokens.manager, 'PATCH', `${base}/${barId}`, { roleIds: [floorRoleId] });
  assert.equal(moved.status, 200);
  assert.deepEqual(moved.body.department.roleIds, [floorRoleId], 'the listed set replaces the old one');
  assert.equal((await prisma.role.findUniqueOrThrow({ where: { id: barRoleId } })).departmentId, null);
  assert.equal((await api(tokens.manager, 'PATCH', `${base}/${barId}`, { roleIds: [otherVenueRoleId] })).status, 404);
  await api(tokens.manager, 'PATCH', `${base}/${barId}`, { roleIds: [barRoleId] });

  assert.equal((await api(tokens.manager, 'PUT', `${base}/${barId}/minimums`, { minimums: [{ weekday: 9, minHeadcount: 1 }] })).status, 400);
  const mins = await api<{ minimums: { weekday: number; minHeadcount: number }[] }>(tokens.manager, 'PUT', `${base}/${barId}/minimums`, { minimums: [{ weekday: 6, minHeadcount: 2 }] });
  assert.equal(mins.status, 200);
  assert.deepEqual(mins.body.minimums.map((m) => [m.weekday, m.minHeadcount]), [[6, 2]]);
  const listed = await api<{ departments: { id: string }[]; minimums: unknown[] }>(tokens.personA, 'GET', base);
  assert.equal(listed.status, 200);
  assert.ok(listed.body.departments.some((d) => d.id === barId));

  const week = nextWeek();
  const saturday = addDays(week, 5);
  await patchWeek(week, [{ op: 'create', userId: personB, date: saturday, ranges: [{ start: '18:00', end: '23:00' }] }]);
  const coverage = (await getWeek(tokens.manager, week)).body.coverage.find((c) => c.date === saturday)!;
  assert.deepEqual(coverage.uncovered, [{ departmentId: barId, short: 1 }], 'Saturday Bar needs two, has one');
});

test('time off: staff file for themselves, duplicates and past days are refused, a decision is final', async () => {
  const week = nextWeek();
  const from = addDays(week, 1);
  const to = addDays(week, 2);
  const filed = await api<{ request: { id: string; status: string; fullName: string } }>(tokens.personA, 'POST', '/api/time-off', { startDate: from, endDate: to, reason: 'Family visit' });
  assert.equal(filed.status, 201, JSON.stringify(filed.body));
  assert.equal(filed.body.request.status, 'pending');
  assert.equal(filed.body.request.fullName, 'Person A');
  const id = filed.body.request.id;
  assert.equal((await api(tokens.personA, 'POST', '/api/time-off', { startDate: to, endDate: to })).status, 409, 'overlaps a pending request');
  assert.equal((await api(tokens.personA, 'POST', '/api/time-off', { userId: personB, startDate: from, endDate: from })).status, 403);
  assert.equal((await api(tokens.personA, 'POST', '/api/time-off', { startDate: '2020-01-06', endDate: '2020-01-07' })).status, 400, 'a past day');
  assert.equal((await api(tokens.personA, 'POST', '/api/time-off', { startDate: to, endDate: from })).status, 400, 'reversed');
  assert.ok(await prisma.auditLog.findFirst({ where: { locationId, action: 'TIME_OFF_REQUESTED', entityId: id } }));

  const mine = await api<{ requests: { id: string }[] }>(tokens.personB, 'GET', `/api/time-off/${locationId}?status=all`);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.requests.some((r) => r.id === id), false, "staff never see another person's requests");
  const pending = await api<{ requests: { id: string }[] }>(tokens.manager, 'GET', `/api/time-off/${locationId}`);
  assert.ok(pending.body.requests.some((r) => r.id === id));

  assert.equal((await api(tokens.personA, 'PATCH', `/api/time-off/${id}`, { decision: 'approve' })).status, 403);
  assert.equal((await api(tokens.manager, 'PATCH', `/api/time-off/${id}`, { decision: 'maybe' })).status, 400);
  const declined = await api<{ result: string; request: { status: string } }>(tokens.manager, 'PATCH', `/api/time-off/${id}`, { decision: 'decline', note: 'Short-staffed' });
  assert.equal(declined.status, 200);
  assert.equal(declined.body.request.status, 'declined');
  const again = await api<{ result: string }>(tokens.manager, 'PATCH', `/api/time-off/${id}`, { decision: 'approve' });
  assert.equal(again.status, 409);
  assert.equal(again.body.result, 'not_pending');
  assert.ok(await prisma.auditLog.findFirst({ where: { locationId, action: 'TIME_OFF_DECLINED', entityId: id } }));
  const notice = await prisma.notification.findFirst({ where: { userId: personA, title: 'Time off declined' }, orderBy: { createdAt: 'desc' } });
  assert.ok(notice?.body.startsWith('Time off declined: '), notice?.body);
  assert.equal((await getWeek(tokens.manager, week)).body.leaves.length, 0, 'a decline leaves the grid as it was');
});

test('approving time off: the shift becomes an open shift, the days lock, past days are skipped, a second decision loses', async () => {
  const week = nextWeek();
  const tue = addDays(week, 1);
  const wed = addDays(week, 2);
  const made = await patchWeek(week, [{ op: 'create', userId: personB, date: tue, ranges: [{ start: '16:00', end: '23:00' }] }]);
  const shiftId = made.body.results[0]!.shiftId!;
  const filed = await api<{ request: { id: string } }>(tokens.personB, 'POST', '/api/time-off', { startDate: tue, endDate: wed });
  const id = filed.body.request.id;

  // Two managers approve at once: exactly one decision lands, the other is told it was already decided.
  const both = await Promise.all([
    api<{ result: string; versions: Record<string, number> }>(tokens.manager, 'PATCH', `/api/time-off/${id}`, { decision: 'approve', leaveType: 'SICK_LEAVE' }),
    api<{ result: string; versions: Record<string, number> }>(tokens.manager, 'PATCH', `/api/time-off/${id}`, { decision: 'approve', leaveType: 'SICK_LEAVE' }),
  ]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409], both.map((r) => r.status).join(' '));
  const first = both.find((r) => r.status === 200)!;
  assert.equal(both.find((r) => r.status === 409)!.body.result, 'not_pending');

  assert.ok(first.body.versions[week], 'the week version that the approval bumped');
  const shift = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } });
  assert.equal(shift.userId, null, 'the shift is now an open shift');
  const doc = (await getWeek(tokens.manager, week)).body;
  assert.equal(doc.version, first.body.versions[week]);
  const leaves = doc.leaves.filter((l) => l.userId === personB);
  assert.deepEqual(leaves.map((l) => [l.date, l.type, l.fromRequest]), [[tue, 'SICK_LEAVE', true], [wed, 'SICK_LEAVE', true]]);
  assert.ok(doc.coverage.find((c) => c.date === tue)!.uncovered.length > 0, 'the open shift is flagged');
  const locked = await patchWeek(week, [{ op: 'update', shiftId, userId: personB }]);
  assert.equal(locked.status, 422);
  assert.equal(locked.body.refusal, 'person_on_leave');
  assert.ok(await prisma.auditLog.findFirst({ where: { locationId, action: 'TIME_OFF_APPROVED', entityId: id } }));
  const notice = await prisma.notification.findFirst({ where: { userId: personB, title: 'Time off approved' } });
  assert.ok(notice?.body.startsWith('Time off approved: '), notice?.body);

  // A request that started two days ago: only today and later become leave.
  const today = venueToday(TZ);
  const old = await prisma.timeOffRequest.create({
    data: { userId: personA, startDate: day(addDays(today, -2)), endDate: day(addDays(today, 1)), status: 'PENDING', expiresAt: day(addDays(today, 2)) },
  });
  const approved = await api(tokens.manager, 'PATCH', `/api/time-off/${old.id}`, { decision: 'approve' });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const marked = await prisma.rotaLeave.findMany({ where: { userId: personA, timeOffRequestId: old.id }, orderBy: { date: 'asc' } });
  assert.deepEqual(marked.map((l) => l.date.toISOString().slice(0, 10)), [today, addDays(today, 1)]);
  assert.ok(marked.every((l) => l.type === 'ANNUAL_LEAVE'), 'annual leave by default');
});

test('my-shifts: published only, with the v2 fields, as the person was last told', async () => {
  // A person of their own, so nothing earlier in this file (leave, other shifts) touches their week.
  const personE = (await prisma.user.create({ data: { locationId, fullName: 'Person E', systemRole: 'STAFF', roleId: floorRoleId } })).id;
  const tokenE = (await issueSession(personE)).plainToken;
  const split = await api<{ shiftType: { id: string } }>(tokens.manager, 'POST', `/api/shift-types/${locationId}`, {
    name: 'Split',
    ranges: [{ start: '11:00', end: '15:00' }, { start: '18:00', end: '23:00' }],
    tint: 'ochre',
  });
  assert.equal(split.status, 201);
    const week = mondayAhead(1);
  const days = [0, 1, 2, 3, 4, 5, 6].map((n) => addDays(week, n)).filter((d) => d > venueToday(TZ));
  const [first, second] = days;
  assert.ok(first && second, 'two future days this week');
  const made = await patchWeek(week, [
    { op: 'create', userId: personE, date: first, shiftTypeId: split.body.shiftType.id, note: 'Dress code black' },
    { op: 'create', userId: personE, date: second, ranges: [{ start: '16:00', end: '01:00' }] },
  ]);
  assert.equal(made.status, 200, JSON.stringify(made.body));
  type Item = { id: string; date: string; status: string; shiftTypeName: string | null; ranges: { start: string; end: string }[]; endsNextDay: boolean; note: string | null; startLabel: string; endLabel: string };
  const before = await api<{ shifts: Item[] }>(tokenE, 'GET', '/api/my-shifts');
  assert.equal(before.status, 200);
  assert.equal(before.body.shifts.filter((s) => s.date >= first && s.date <= addDays(week, 6)).length, 0, 'drafts never show');

  await publish(week);
  const after = (await api<{ shifts: Item[] }>(tokenE, 'GET', '/api/my-shifts')).body.shifts;
  const splitItem = after.find((s) => s.date === first)!;
  assert.equal(splitItem.shiftTypeName, 'Split');
  assert.deepEqual(splitItem.ranges, [{ start: '11:00', end: '15:00' }, { start: '18:00', end: '23:00' }]);
  assert.equal(splitItem.endsNextDay, false);
  assert.equal(splitItem.note, 'Dress code black');
  assert.equal(splitItem.status, 'PUBLISHED');
  assert.equal(splitItem.startLabel, '11:00');
  assert.equal(splitItem.endLabel, '23:00');
  const late = after.find((s) => s.date === second)!;
  assert.equal(late.endsNextDay, true);
  assert.equal(late.shiftTypeName, null);

  // Reassigned after publish: Person E still has it (told), Person B does not yet.
  const shiftId = made.body.results[1]!.shiftId!;
  assert.equal((await patchWeek(week, [{ op: 'update', shiftId, userId: personB }])).status, 200);
  assert.ok((await api<{ shifts: Item[] }>(tokenE, 'GET', '/api/my-shifts')).body.shifts.some((s) => s.id === shiftId));
  assert.ok(!(await api<{ shifts: Item[] }>(tokens.personB, 'GET', '/api/my-shifts')).body.shifts.some((s) => s.id === shiftId));
  await publish(week);
  assert.ok(!(await api<{ shifts: Item[] }>(tokenE, 'GET', '/api/my-shifts')).body.shifts.some((s) => s.id === shiftId));
  assert.ok((await api<{ shifts: Item[] }>(tokens.personB, 'GET', '/api/my-shifts')).body.shifts.some((s) => s.id === shiftId));
});

test('clock-in with no shiftId is tied to the person\'s published shift that venue day; none → no shift, as before', async () => {
  const clockPerson = (await prisma.user.create({ data: { locationId, fullName: 'Person C', systemRole: 'STAFF', roleId: floorRoleId } })).id;
  const token = (await issueSession(clockPerson)).plainToken;
  const today = venueToday(TZ);
  const draft = await prisma.shift.create({
    data: { locationId, roleId: floorRoleId, userId: clockPerson, date: day(today), startTime: new Date(), endTime: new Date(Date.now() + 3_600_000), status: 'DRAFT' },
  });
  const unmatched = await api<{ shiftId: string | null }>(token, 'POST', '/api/attendance/clock-in', {});
  assert.equal(unmatched.status, 201);
  assert.equal(unmatched.body.shiftId, null, 'a draft is not a shift anyone was told about');
  assert.equal((await api(token, 'POST', '/api/attendance/clock-out', {})).status, 200);

  await prisma.shift.update({ where: { id: draft.id }, data: { status: 'PUBLISHED' } });
  const matched = await api<{ id: string; shiftId: string | null }>(token, 'POST', '/api/attendance/clock-in', {});
  assert.equal(matched.status, 201);
  assert.equal(matched.body.shiftId, draft.id);
  assert.equal((await prisma.attendanceLog.findUniqueOrThrow({ where: { id: matched.body.id } })).shiftId, draft.id);
  assert.equal((await api(token, 'POST', '/api/attendance/clock-out', {})).status, 200);
});

test('templates v2: entries carry a shift type, ranges and a staff note; a departed person\'s slot becomes open', async () => {
  const typeRes = await api<{ shiftType: { id: string } }>(tokens.manager, 'POST', `/api/shift-types/${locationId}`, { name: 'Morning', ranges: [{ start: '07:00', end: '16:00' }], tint: 'gold' });
  assert.equal(typeRes.status, 201);
  const typeId = typeRes.body.shiftType.id;
  const leaver = (await prisma.user.create({ data: { locationId, fullName: 'Person D', systemRole: 'STAFF', roleId: floorRoleId } })).id;

  const bad = await api(tokens.manager, 'POST', '/api/rota-templates', {
    name: `${TAG} bad`,
    entries: [{ dayOffset: 0, roleId: floorRoleId, userId: null, ranges: [{ start: '23:00', end: '01:00' }, { start: '02:00', end: '04:00' }] }],
  });
  assert.equal(bad.status, 400);
  const created = await api<{ template: { id: string; entryCount: number } }>(tokens.manager, 'POST', '/api/rota-templates', {
    name: `${TAG} standard week`,
    entries: [
      { dayOffset: 0, roleId: floorRoleId, userId: personA, shiftTypeId: typeId, shiftNote: 'Brief at 06:45', note: 'Check the terrace heaters' },
      { dayOffset: 1, roleId: floorRoleId, userId: null, ranges: [{ start: '11:00', end: '15:00' }, { start: '18:00', end: '23:00' }] },
      { dayOffset: 2, roleId: floorRoleId, userId: leaver, start: '09:00', end: '17:00' },
    ],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.template.entryCount, 3);
  await prisma.user.update({ where: { id: leaver }, data: { isActive: false } });

  const week = nextWeek();
  const applied = await api<{ createdCount: number }>(tokens.manager, 'POST', `/api/rota-templates/${created.body.template.id}/apply`, { weekStart: week });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  assert.equal(applied.body.createdCount, 3);
  const shifts = (await getWeek(tokens.manager, week)).body.shifts;
  const mon = shifts.find((s) => s.date === week)!;
  assert.equal(mon.shiftTypeId, typeId);
  assert.deepEqual(mon.ranges, [{ start: '07:00', end: '16:00' }]);
  assert.equal(mon.note, 'Brief at 06:45', 'the staff-visible note');
  assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: mon.id } })).managerNotes, 'Check the terrace heaters', 'note stays manager-only');
  assert.equal(shifts.find((s) => s.date === addDays(week, 1))!.ranges.length, 2);
  assert.equal(shifts.find((s) => s.date === addDays(week, 2))!.userId, null, 'a departed person\'s slot is an open shift');

  // A pre-v2 template (start/end only) still applies.
  const legacy = await prisma.rotaTemplate.create({
    data: { locationId, name: `${TAG} legacy`, entries: [{ dayOffset: 3, roleId: barRoleId, userId: personB, start: '17:00', end: '01:00' }] },
  });
  const legacyWeek = nextWeek();
  assert.equal((await api(tokens.manager, 'POST', `/api/rota-templates/${legacy.id}/apply`, { weekStart: legacyWeek })).status, 201);
  const legacyShift = (await getWeek(tokens.manager, legacyWeek)).body.shifts[0]!;
  assert.deepEqual(legacyShift.ranges, [{ start: '17:00', end: '01:00' }]);
  assert.equal(legacyShift.endsNextDay, true);
});
