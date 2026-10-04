import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../app.js';
import { issueSession } from '../lib/identity.js';

/**
 * Split shifts (2026-10-02): one person, one day, two segments (e.g.
 * 11:00–15:00 and 18:00–23:00). No schema change — Shift already allowed
 * several rows per person per day. Segments must not overlap (input
 * validation in the shared shift mutators, so REST and voice refuse it the
 * same way); every path that writes, copies, publishes or shows shifts
 * carries both segments.
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

const TAG = '__split-shift-test__';
const WEEK = '2031-06-02';
const TUE = '2031-06-03';
const WED = '2031-06-04';
const NEXT_WEEK = '2031-06-09';

async function fixture() {
  const org = await prisma.organization.create({ data: { name: `${TAG} org ${Date.now()}` } });
  const location = await prisma.location.create({ data: { organizationId: org.id, name: `${TAG} venue`, timezone: 'Asia/Dubai' } });
  const role = await prisma.role.create({ data: { locationId: location.id, name: `${TAG} Bar` } });
  const manager = await prisma.user.create({ data: { locationId: location.id, fullName: `${TAG} manager`, systemRole: 'MANAGER' } });
  const sara = await prisma.user.create({ data: { locationId: location.id, fullName: 'Sara Split', systemRole: 'STAFF' } });
  const omar = await prisma.user.create({ data: { locationId: location.id, fullName: 'Omar Other', systemRole: 'STAFF' } });
  const [mgr, stf] = await Promise.all([issueSession(manager.id), issueSession(sara.id)]);
  return { org, location, role, manager, sara, omar, mgrToken: mgr.plainToken, saraToken: stf.plainToken };
}

type F = Awaited<ReturnType<typeof fixture>>;
type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;

function api(baseUrl: string, token: string | null): Call {
  return async (method, path, body) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
}

async function run(fn: (f: F, mgr: Call, staff: Call) => Promise<void>) {
  const f = await fixture();
  try {
    await withServer((baseUrl) => fn(f, api(baseUrl, f.mgrToken), api(baseUrl, f.saraToken)));
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

const OVERLAP = /Sara Split already works 11:00–15:00 on 2031-06-03 — two shifts for one person can't overlap\./;

async function addSplit(f: F, mgr: Call, date = TUE) {
  const lunch = await mgr('POST', '/api/shifts', { roleId: f.role.id, userId: f.sara.id, date, start: '11:00', end: '15:00' });
  const dinner = await mgr('POST', '/api/shifts', { roleId: f.role.id, userId: f.sara.id, date, start: '18:00', end: '23:00' });
  assert.equal(lunch.status, 201);
  assert.equal(dinner.status, 201, 'a second, non-overlapping segment on the same day is allowed');
  return { lunch: lunch.body.shift.id as string, dinner: dinner.body.shift.id as string };
}

test('REST: two non-overlapping segments for one person on one day are allowed; an overlapping one is refused (409) and writes nothing', () =>
  run(async (f, mgr) => {
    const { lunch } = await addSplit(f, mgr);
    // Touching the first segment's end is not an overlap.
    const touching = await mgr('POST', '/api/shifts', { roleId: f.role.id, userId: f.sara.id, date: TUE, start: '15:00', end: '16:00' });
    assert.equal(touching.status, 201);
    await mgr('DELETE', `/api/shifts/${touching.body.shift.id}`);

    const overlapping = await mgr('POST', '/api/shifts', { roleId: f.role.id, userId: f.sara.id, date: TUE, start: '14:00', end: '17:00' });
    assert.equal(overlapping.status, 409);
    assert.match(overlapping.body.error, OVERLAP);
    assert.equal(await prisma.shift.count({ where: { userId: f.sara.id } }), 2);
    assert.equal(await prisma.auditLog.count({ where: { locationId: f.location.id, action: 'SHIFT_CREATED' } }), 3, 'no audit row for the refused create');

    // Someone else may work those hours; an open (unassigned) slot is never an overlap.
    assert.equal((await mgr('POST', '/api/shifts', { roleId: f.role.id, userId: f.omar.id, date: TUE, start: '12:00', end: '14:00' })).status, 201);
    assert.equal((await mgr('POST', '/api/shifts', { roleId: f.role.id, date: TUE, start: '12:00', end: '14:00' })).status, 201);

    // PATCH: stretching the dinner segment back into lunch, or handing Omar's slot to Sara, is refused too.
    const dinner = await prisma.shift.findFirstOrThrow({ where: { userId: f.sara.id, id: { not: lunch } } });
    const stretched = await mgr('PATCH', `/api/shifts/${dinner.id}`, { start: '14:30' });
    assert.equal(stretched.status, 409);
    assert.match(stretched.body.error, OVERLAP);
    const omarShift = await prisma.shift.findFirstOrThrow({ where: { userId: f.omar.id } });
    assert.equal((await mgr('PATCH', `/api/shifts/${omarShift.id}`, { userId: f.sara.id })).status, 409);
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: omarShift.id } })).userId, f.omar.id);
    // Editing a segment within its own slot is fine (it never overlaps itself).
    assert.equal((await mgr('PATCH', `/api/shifts/${dinner.id}`, { start: '17:30' })).status, 200);
  }));

test('an overnight segment overlaps the next morning; voice CREATE_SHIFT and EDIT_SHIFT get the same 409 as REST', () =>
  run(async (f, mgr) => {
    await addSplit(f, mgr);
    const voice = (intent: Record<string, unknown>) => mgr('POST', '/api/voice/execute', { transcript: 'x', intent: { confidence: 0.9, summary: 'x', ...intent } });

    const created = await voice({ intent: 'CREATE_SHIFT', roleId: f.role.id, userId: f.sara.id, date: TUE, start: '13:00', end: '19:00' });
    assert.equal(created.status, 409);
    assert.match(created.body.error, OVERLAP);

    const wed = await voice({ intent: 'CREATE_SHIFT', roleId: f.role.id, userId: f.sara.id, date: WED, start: '09:00', end: '12:00' });
    assert.equal(wed.status, 201);
    const moved = await voice({ intent: 'EDIT_SHIFT', shiftId: wed.body.result.id, date: TUE });
    assert.equal(moved.status, 409, 'moving a Wednesday shift onto Tuesday 09:00–12:00 hits the lunch segment');
    assert.match(moved.body.error, OVERLAP);

    // Tue 22:00 → Wed 02:00 runs into a Wed 01:00 start.
    assert.equal((await mgr('POST', '/api/shifts', { roleId: f.role.id, userId: f.sara.id, date: WED, start: '22:00', end: '02:00' })).status, 201);
    const early = await mgr('POST', '/api/shifts', { roleId: f.role.id, userId: f.sara.id, date: '2031-06-05', start: '01:00', end: '05:00' });
    assert.equal(early.status, 409);
  }));

test('a blocking leave on the day still blocks adding a segment (409, leave message)', () =>
  run(async (f, mgr) => {
    await addSplit(f, mgr, TUE);
    await mgr('PUT', '/api/rota-leaves', { userId: f.sara.id, date: WED, type: 'DAY_OFF' });
    const blocked = await mgr('POST', '/api/shifts', { roleId: f.role.id, userId: f.sara.id, date: WED, start: '11:00', end: '15:00' });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /Day Off/);
    const shift = await prisma.shift.findFirstOrThrow({ where: { userId: f.sara.id, date: new Date(`${TUE}T00:00:00.000Z`) } });
    assert.equal((await mgr('PATCH', `/api/shifts/${shift.id}`, { date: WED })).status, 409, 'moving a segment onto the leave day is refused too');
  }));

test('copy last week (bulk): both segments copy; overlapping rows refuse the whole batch', () =>
  run(async (f, mgr) => {
    const rows = [
      { roleId: f.role.id, userId: f.sara.id, date: NEXT_WEEK, start: '11:00', end: '15:00' },
      { roleId: f.role.id, userId: f.sara.id, date: NEXT_WEEK, start: '18:00', end: '23:00' },
    ];
    const bulk = await mgr('POST', '/api/shifts/bulk', { shifts: rows });
    assert.equal(bulk.status, 201);
    assert.equal(bulk.body.createdCount, 2);
    assert.deepEqual(bulk.body.shifts.map((s: { start: string; end: string }) => `${s.start}–${s.end}`), ['11:00–15:00', '18:00–23:00']);

    const again = await mgr('POST', '/api/shifts/bulk', { shifts: [{ ...rows[0], date: TUE }, { ...rows[1], start: '12:00', end: '13:00' }] });
    assert.equal(again.status, 409, 'a row overlapping a stored shift rejects the whole batch');
    assert.equal(await prisma.shift.count({ where: { userId: f.sara.id } }), 2);

    const selfOverlap = await mgr('POST', '/api/shifts/bulk', { shifts: [{ ...rows[0], date: TUE }, { ...rows[0], date: TUE, start: '14:00', end: '16:00' }] });
    assert.equal(selfOverlap.status, 409, 'two rows of one batch overlapping each other are refused too');
    assert.match(selfOverlap.body.error, OVERLAP);
    assert.equal(await prisma.shift.count({ where: { userId: f.sara.id } }), 2);
  }));

test('templates: save + apply preserves both segments; an apply that would overlap is refused (409)', () =>
  run(async (f, mgr) => {
    const saved = await mgr('POST', '/api/rota-templates', {
      name: `${TAG} split`,
      entries: [
        { dayOffset: 1, roleId: f.role.id, userId: f.sara.id, start: '11:00', end: '15:00' },
        { dayOffset: 1, roleId: f.role.id, userId: f.sara.id, start: '18:00', end: '23:00' },
      ],
    });
    assert.equal(saved.status, 201);
    assert.equal(saved.body.template.entryCount, 2);

    const applied = await mgr('POST', `/api/rota-templates/${saved.body.template.id}/apply`, { weekStart: WEEK });
    assert.equal(applied.status, 201);
    assert.equal(applied.body.createdCount, 2);
    const list = await mgr('GET', `/api/shifts/${f.location.id}?weekStart=${WEEK}`);
    assert.deepEqual(list.body.shifts.map((s: { date: string; start: string; end: string; employeeId: string }) => [s.date, s.start, s.end, s.employeeId]), [
      [TUE, '11:00', '15:00', f.sara.id],
      [TUE, '18:00', '23:00', f.sara.id],
    ]);

    const twice = await mgr('POST', `/api/rota-templates/${saved.body.template.id}/apply`, { weekStart: WEEK });
    assert.equal(twice.status, 409, 'applying again on top would double-book Sara');
    assert.match(twice.body.error, OVERLAP);
    assert.equal(await prisma.shift.count({ where: { userId: f.sara.id } }), 2);

    const voice = await mgr('POST', '/api/voice/execute', {
      transcript: 'apply split',
      intent: { intent: 'APPLY_ROTA_TEMPLATE', templateId: saved.body.template.id, templateName: `${TAG} split`, weekStart: WEEK, confidence: 0.9, summary: 'x' },
    });
    assert.equal(voice.status, 409);
  }));

test('publish: each person is notified once, and the split day lists both segments; staff then see both (rota + my-shifts), never the draft', () =>
  run(async (f, mgr, staff) => {
    await addSplit(f, mgr);
    assert.equal((await mgr('POST', '/api/shifts', { roleId: f.role.id, userId: f.sara.id, date: WED, start: '17:00', end: '23:00' })).status, 201);
    assert.equal((await mgr('POST', '/api/shifts', { roleId: f.role.id, userId: f.omar.id, date: TUE, start: '12:00', end: '20:00' })).status, 201);

    // Drafts are invisible to staff.
    assert.deepEqual((await staff('GET', `/api/shifts/${f.location.id}?weekStart=${WEEK}`)).body.shifts, []);
    assert.deepEqual((await staff('GET', '/api/my-shifts')).body.shifts, []);

    const pub = await mgr('POST', `/api/shifts/${f.location.id}/publish`, { weekStart: WEEK });
    assert.equal(pub.status, 200);
    assert.equal(pub.body.notifiedCount, 2, 'two people, not four shifts');

    const saraNotes = await notificationsFor(f.sara.id, 1);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await notificationsFor(f.sara.id, 1)).length, 1, 'one digest for Sara, not one per segment');
    assert.equal(saraNotes[0]!.title, 'Schedule updated');
    assert.equal(saraNotes[0]!.body, `Your schedule for the week of ${WEEK} is up: Tue 3 Jun 11:00–15:00 + 18:00–23:00, Wed 4 Jun 17:00–23:00.`);
    const omarNotes = await notificationsFor(f.omar.id, 1);
    assert.equal(omarNotes.length, 1);
    assert.match(omarNotes[0]!.body, /Tue 3 Jun 12:00–20:00\.$/);

    const rota = await staff('GET', `/api/shifts/${f.location.id}?weekStart=${WEEK}`);
    assert.deepEqual(
      rota.body.shifts.filter((s: { employeeId: string }) => s.employeeId === f.sara.id).map((s: { date: string; start: string; end: string; status: string }) => [s.date, s.start, s.end, s.status]),
      [
        [TUE, '11:00', '15:00', 'published'],
        [TUE, '18:00', '23:00', 'published'],
        [WED, '17:00', '23:00', 'published'],
      ],
    );
    const mine = await staff('GET', '/api/my-shifts');
    assert.deepEqual(mine.body.shifts.map((s: { date: string; start: string; end: string }) => `${s.date} ${s.start}–${s.end}`), [
      `${TUE} 11:00–15:00`,
      `${TUE} 18:00–23:00`,
      `${WED} 17:00–23:00`,
    ]);
  }));

test('swap approval refuses to hand the cover a shift overlapping one of their segments (409)', () =>
  run(async (f, mgr) => {
    await addSplit(f, mgr);
    const omarShift = await prisma.shift.create({
      data: { locationId: f.location.id, roleId: f.role.id, userId: f.omar.id, date: new Date(`${TUE}T00:00:00.000Z`), startTime: new Date(`${TUE}T13:00:00.000Z`), endTime: new Date(`${TUE}T16:00:00.000Z`), status: 'PUBLISHED' },
    });
    const swap = await prisma.shiftSwapRequest.create({
      data: { shiftId: omarShift.id, requestedById: f.omar.id, targetUserId: f.sara.id, type: 'COVER', status: 'PENDING', expiresAt: new Date(Date.now() + 86_400_000) },
    });
    const decided = await mgr('PATCH', `/api/swap-requests/${swap.id}`, { decision: 'approved' });
    assert.equal(decided.status, 409, 'Omar 17:00–20:00 Dubai overlaps Sara’s 18:00 dinner segment');
    assert.match(decided.body.error, /Sara Split already works 18:00–23:00 on 2031-06-03/);
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: omarShift.id } })).userId, f.omar.id);
  }));
