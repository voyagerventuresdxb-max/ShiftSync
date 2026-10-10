import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Prisma } from '@prisma/client';
import { createApp } from '../../../src/app.js';
import { prisma } from '../../../src/lib/prisma.js';
import { issueSession } from '../../../src/lib/identity.js';
import { voiceExecuteRateLimiter } from '../../../src/middleware/rateLimit.js';
import { shiftInstantsOf } from '../../../src/lib/actions/weekActions.js';
import { refinePublishRotaResponse } from '../../../src/voice/parseIntent.js';
import { VOICE_PENDING_REQUEST } from '../../../src/voice/weekWrites.js';
import type { TimeRange } from '../../../../shared/rotaWeek.js';

/**
 * Voice roster writes go through the week model (lib/actions/weekActions.ts), exactly like the
 * grid: CREATE/EDIT/CANCEL_SHIFT are week patches (source 'voice'), PUBLISH_ROTA publishes the
 * previewed diff by version and fingerprint, REQUEST_TIME_OFF files a real time-off request, and
 * the week patch's refusals come back as the voice sheet's own 409/422 answers. No model is
 * called here: /execute takes the confirmed intent as the app sends it. Made-up names only.
 */
const TZ = 'Asia/Dubai';
const WEEK = '2031-04-07';
const TUE = '2031-04-08';
const WED = '2031-04-09';
const THU = '2031-04-10';
const FRI = '2031-04-11';
const SAT = '2031-04-12';
const NEXT_MON = '2031-04-14';
const EVENING: TimeRange[] = [{ start: '16:00', end: '01:00' }];
const SPLIT: TimeRange[] = [
  { start: '11:00', end: '15:00' },
  { start: '18:00', end: '23:00' },
];

let server: Server;
let base = '';
let orgId = '';
let locationId = '';
let roleId = '';
let eveningId = '';
let splitId = '';
const people = {} as Record<'manager' | 'ava' | 'ben' | 'cara' | 'dev', string>;

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const json = (v: unknown) => v as Prisma.InputJsonValue;

async function token(who: keyof typeof people): Promise<string> {
  voiceExecuteRateLimiter.resetKey(people[who]);
  return (await issueSession(people[who])).plainToken;
}

async function execute(who: keyof typeof people, intent: Record<string, unknown>, transcript = 'voice') {
  const res = await fetch(`${base}/api/voice/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token(who)}` },
    body: JSON.stringify({ transcript, intent }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { error?: string; errorCode?: string; result?: Record<string, unknown> } };
}

const weekVersion = async (weekStart = WEEK) => (await prisma.rotaWeek.findUnique({ where: { locationId_weekStart: { locationId, weekStart: day(weekStart) } } }))?.version ?? 1;

before(async () => {
  const org = await prisma.organization.create({ data: { name: `__voice-week-diag__ ${Date.now()}` } });
  orgId = org.id;
  locationId = (await prisma.location.create({ data: { organizationId: org.id, name: org.name, timezone: TZ } })).id;
  roleId = (await prisma.role.create({ data: { locationId, name: 'Bartender' } })).id;
  eveningId = (await prisma.shiftType.create({ data: { locationId, name: 'Evening', ranges: json(EVENING), endsNextDay: true } })).id;
  splitId = (await prisma.shiftType.create({ data: { locationId, name: 'Split', ranges: json(SPLIT), sortOrder: 1 } })).id;
  people.manager = (await prisma.user.create({ data: { locationId, fullName: 'Week Manager', systemRole: 'MANAGER', roleId } })).id;
  for (const [key, name] of [['ava', 'Ava Example'], ['ben', 'Ben Sample'], ['cara', 'Cara Test'], ['dev', 'Dev Demo']] as const) {
    people[key] = (await prisma.user.create({ data: { locationId, fullName: name, systemRole: 'STAFF', roleId } })).id;
  }
  const app = createApp();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  // Shifts first: a shift's role is ON DELETE RESTRICT, so the venue cascade can't remove them in any order.
  await prisma.shift.deleteMany({ where: { locationId } }).catch(() => {});
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
});

const create = (extra: Record<string, unknown>) => ({ intent: 'CREATE_SHIFT', roleId, confidence: 0.9, summary: 'x', ...extra });

test('CREATE_SHIFT with a shift type: one week patch — the type and its ranges, the version bumped, the [voice] audit, the week to refresh', async () => {
  const before = await weekVersion();
  const res = await execute('manager', create({ date: TUE, start: '16:00', end: '01:00', shiftTypeId: eveningId, userId: people.ava }), 'put Ava on evening Tuesday');
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const id = res.body.result!.id as string;
  const shift = await prisma.shift.findUniqueOrThrow({ where: { id } });
  assert.deepEqual([shift.shiftTypeId, shift.ranges, shift.endsNextDay, shift.status, shift.userId], [eveningId, EVENING, true, 'DRAFT', people.ava]);
  assert.equal(await weekVersion(), before + 1);
  assert.deepEqual(res.body.roster, { locationId, weekStart: WEEK, version: before + 1 });
  const audit = await prisma.auditLog.findFirstOrThrow({ where: { locationId, action: 'SHIFT_CREATED', entityId: id } });
  assert.equal(audit.note, '[voice] Created a shift on 2031-04-08 — "put Ava on evening Tuesday"');
});

test('a split is ONE shift with two ranges; parts that overlap are refused before anything is written', async () => {
  const res = await execute('manager', create({ date: WED, start: '11:00', end: '15:00', second: { start: '18:00', end: '23:00' }, userId: people.ben }));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const rows = await prisma.shift.findMany({ where: { locationId, userId: people.ben, date: day(WED) } });
  assert.deepEqual(rows.map((r) => r.ranges), [SPLIT]);
  const bad = await execute('manager', create({ date: THU, start: '11:00', end: '15:00', second: { start: '14:00', end: '23:00' }, userId: people.ben }));
  assert.equal(bad.status, 400);
  assert.equal(await prisma.shift.count({ where: { locationId, userId: people.ben, date: day(THU) } }), 0);
});

test('the week patch\'s person-day rules come back as the sheet\'s 409s: a second shift that day, approved leave, a pending request (declined only when confirmed)', async () => {
  // Ava already works Tuesday (first test): one live shift per person per day.
  const twice = await execute('manager', create({ date: TUE, start: '09:00', end: '12:00', userId: people.ava }));
  assert.deepEqual([twice.status, twice.body.errorCode], [409, 'already_has_shift']);
  // Cara is on annual leave Thursday.
  await prisma.rotaLeave.create({ data: { locationId, userId: people.cara, date: day(THU), type: 'ANNUAL_LEAVE', status: 'PUBLISHED' } });
  const leave = await execute('manager', create({ date: THU, start: '09:00', end: '17:00', userId: people.cara }));
  assert.deepEqual([leave.status, leave.body.errorCode], [409, 'person_on_leave']);
  assert.match(leave.body.error!, /annual leave .* Pick another day or person\.$/);
  // Dev has asked for Friday off; nothing is written until the confirmed intent says to decline it.
  const request = await prisma.timeOffRequest.create({ data: { userId: people.dev, startDate: day(FRI), endDate: day(FRI), status: 'PENDING', expiresAt: day(SAT) } });
  const pending = await execute('manager', create({ date: FRI, start: '09:00', end: '17:00', userId: people.dev }));
  assert.deepEqual([pending.status, pending.body.error], [409, VOICE_PENDING_REQUEST]);
  assert.equal(await prisma.shift.count({ where: { locationId, userId: people.dev, date: day(FRI) } }), 0);
  const confirmed = await execute('manager', create({ date: FRI, start: '09:00', end: '17:00', userId: people.dev, overridePendingRequest: true }));
  assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body));
  assert.deepEqual(confirmed.body.result!.declinedRequestIds, [request.id]);
  assert.equal((await prisma.timeOffRequest.findUniqueOrThrow({ where: { id: request.id } })).status, 'DECLINED');
  // Staff can never write the week by voice.
  assert.equal((await execute('ava', create({ date: SAT, start: '09:00', end: '17:00', userId: people.ava }))).status, 403);
});

test('EDIT_SHIFT: a shift type reshapes it (split), custom times keep a split\'s break, and a move into another week is all or nothing', async () => {
  const shift = await prisma.shift.findFirstOrThrow({ where: { locationId, userId: people.ava, date: day(TUE) } });
  const toSplit = await execute('manager', { intent: 'EDIT_SHIFT', shiftId: shift.id, start: '11:00', end: '15:00', second: { start: '18:00', end: '23:00' }, shiftTypeId: splitId, confidence: 0.9, summary: 'x' });
  assert.equal(toSplit.status, 200, JSON.stringify(toSplit.body));
  let row = await prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
  assert.deepEqual([row.shiftTypeId, row.ranges, row.endsNextDay], [splitId, SPLIT, false]);
  // "Finish at 22": the second range ends earlier, the break stays, and the type name goes (custom times).
  const later = await execute('manager', { intent: 'EDIT_SHIFT', shiftId: shift.id, end: '22:00', confidence: 0.9, summary: 'x' });
  assert.equal(later.status, 200, JSON.stringify(later.body));
  row = await prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
  assert.deepEqual([row.shiftTypeId, row.ranges], [null, [SPLIT[0], { start: '18:00', end: '22:00' }]]);
  // Into next Monday: created there, removed here (a draft simply goes), each week's version bumped once.
  const [here, there] = [await weekVersion(), await weekVersion(NEXT_MON)];
  const moved = await execute('manager', { intent: 'EDIT_SHIFT', shiftId: shift.id, date: NEXT_MON, confidence: 0.9, summary: 'x' });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(await prisma.shift.count({ where: { id: shift.id } }), 0);
  const landed = await prisma.shift.findFirstOrThrow({ where: { locationId, userId: people.ava, date: day(NEXT_MON) } });
  assert.deepEqual(landed.ranges, [SPLIT[0], { start: '18:00', end: '22:00' }]);
  assert.deepEqual([await weekVersion(), await weekVersion(NEXT_MON)], [here + 1, there + 1]);
  // Onto a day the person already works: refused, and nothing moved in either week.
  const clash = await execute('manager', { intent: 'EDIT_SHIFT', shiftId: landed.id, date: WED, userId: people.ben, confidence: 0.9, summary: 'x' });
  assert.deepEqual([clash.status, clash.body.errorCode], [409, 'already_has_shift']);
  assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: landed.id } })).date.toISOString().slice(0, 10), NEXT_MON);
});

test('CANCEL_SHIFT: a published shift waits for the next publish (CANCELLED, told then); a cancelled shift is not found again', async () => {
  const published = await prisma.shift.create({
    data: { locationId, roleId, userId: people.ava, date: day(SAT), ...shiftInstantsOf(SAT, EVENING, TZ), ranges: json(EVENING), endsNextDay: true, status: 'PUBLISHED' },
  });
  const before = await weekVersion();
  const res = await execute('manager', { intent: 'CANCEL_SHIFT', shiftId: published.id, confidence: 0.9, summary: 'x' }, 'cancel Ava Saturday');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: published.id } })).status, 'CANCELLED');
  assert.equal(await weekVersion(), before + 1);
  assert.equal((await execute('manager', { intent: 'CANCEL_SHIFT', shiftId: published.id, confidence: 0.9, summary: 'x' })).status, 404);
});

test('PUBLISH_ROTA: the parse preview carries version and fingerprint; /execute publishes exactly that, and refuses a stale or missing preview', async () => {
  const preview = await refinePublishRotaResponse({ intent: 'PUBLISH_ROTA', weekStart: WEEK, confidence: 0.9, summary: 'x' }, locationId);
  assert.equal(preview.intent, 'PUBLISH_ROTA');
  if (preview.intent !== 'PUBLISH_ROTA') return;
  assert.ok(preview.counts && preview.counts.shiftsChanging > 0);
  assert.equal(preview.version, await weekVersion());
  const intent = { ...preview } as Record<string, unknown>;
  assert.equal((await execute('ava', intent)).status, 403, 'staff never publish');
  assert.equal((await execute('manager', { ...intent, fingerprint: undefined })).status, 400);
  // The week moves after the preview (another change): the old preview no longer publishes.
  await prisma.rotaWeek.update({ where: { locationId_weekStart: { locationId, weekStart: day(WEEK) } }, data: { version: { increment: 1 } } });
  const stale = await execute('manager', intent);
  assert.deepEqual([stale.status, stale.body.errorCode], [409, 'week_changed']);
  assert.equal(await prisma.shift.count({ where: { locationId, date: { gte: day(WEEK), lt: day(NEXT_MON) }, status: 'PUBLISHED' } }), 0);
  const fresh = await refinePublishRotaResponse({ intent: 'PUBLISH_ROTA', weekStart: WEEK, confidence: 0.9, summary: 'x' }, locationId);
  const done = await execute('manager', fresh as unknown as Record<string, unknown>);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(await prisma.shift.count({ where: { locationId, date: { gte: day(WEEK), lt: day(NEXT_MON) }, status: 'DRAFT' } }), 0);
  const again = await refinePublishRotaResponse({ intent: 'PUBLISH_ROTA', weekStart: WEEK, confidence: 0.9, summary: 'x' }, locationId);
  assert.equal(again.intent, 'UNRECOGNIZED');
  assert.match(again.summary, /already published, with no changes since/);
});

test('REQUEST_TIME_OFF files one pending time-off request (not availability marks), audited; an overlapping one is refused', async () => {
  const res = await execute('ben', { intent: 'REQUEST_TIME_OFF', startDate: THU, endDate: FRI, reason: 'a wedding', confidence: 0.9, summary: 'x' }, 'Thursday and Friday off');
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const rows = await prisma.timeOffRequest.findMany({ where: { userId: people.ben } });
  assert.deepEqual(
    rows.map((r) => [r.startDate.toISOString().slice(0, 10), r.endDate.toISOString().slice(0, 10), r.status, r.reason]),
    [[THU, FRI, 'PENDING', 'a wedding']],
  );
  assert.equal(await prisma.availabilityMark.count({ where: { userId: people.ben } }), 0);
  assert.ok(await prisma.auditLog.findFirst({ where: { locationId, action: 'TIME_OFF_REQUESTED', entityId: rows[0]!.id } }));
  const again = await execute('ben', { intent: 'REQUEST_TIME_OFF', startDate: FRI, endDate: FRI, reason: null, confidence: 0.9, summary: 'x' });
  assert.deepEqual([again.status, again.body.errorCode], [409, 'time_off_duplicate']);
});

test('APPLY_ROTA_TEMPLATE: a refused entry applies nothing and says which entry and why', async () => {
  // Cara is on annual leave Thursday (dayOffset 3 of the week).
  const template = await prisma.rotaTemplate.create({
    data: { locationId, name: 'Thursday Bar', entries: [{ dayOffset: 3, roleId, userId: people.cara, start: '18:00', end: '23:00' }] },
  });
  const before = await weekVersion();
  const res = await execute('manager', { intent: 'APPLY_ROTA_TEMPLATE', templateId: template.id, templateName: 'Thursday Bar', weekStart: WEEK, confidence: 0.9, summary: 'x' });
  assert.deepEqual([res.status, res.body.errorCode], [409, 'template_person_on_leave']);
  assert.equal(res.body.error, 'Nothing was applied. Entry 1: That person is on annual leave that day.');
  assert.equal(await weekVersion(), before);
});
