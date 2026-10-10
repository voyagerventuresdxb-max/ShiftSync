import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { applyWeekPatch, getWeekDoc, previewWeekPublish, publishWeek } from './weekActions.js';
import type { WeekPatchInput, WeekPatchOp, WeekPatchResult } from '../../../../shared/rotaWeek.js';

/**
 * Rota builder v2 week actions against the real database: the version
 * counter, the person-day rules, split and cross-midnight instants, the
 * publish diff and its fingerprint. One venue ("Demo Venue") in its own
 * organization, so cleanup is one cascade delete. Dates are far enough ahead
 * that no "past day" rule fires, except where that rule is the point.
 */
const prisma = new PrismaClient();
const TAG = '__week-actions__';

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

let orgId = '';
let locationId = '';
let roleId = '';
let barRoleId = '';
let personA = '';
let personB = '';
let manager = '';
let eveningTypeId = '';
let weekCounter = 10; // each test takes its own future week so they never share a version counter

const nextWeek = () => mondayAhead(weekCounter++);

function patch(weekStart: string, ops: WeekPatchOp[], extra: Partial<WeekPatchInput> = {}) {
  return applyWeekPatch({ locationId, weekStart, actorId: manager, source: 'grid', patch: { ops, ...extra } });
}
function ok(result: WeekPatchResult, label = 'patch') {
  assert.equal(result.result, 'ok', `${label}: ${JSON.stringify(result.result === 'refused' ? result : result.result)}`);
  return result as Extract<WeekPatchResult, { result: 'ok' }>;
}
function refused(result: WeekPatchResult, refusal: string, label = 'patch') {
  assert.equal(result.result, 'refused', `${label}: expected refusal ${refusal}, got ${result.result}`);
  assert.equal((result as Extract<WeekPatchResult, { result: 'refused' }>).refusal, refusal, label);
}

before(async () => {
  const org = await prisma.organization.create({ data: { name: `${TAG} org` } });
  orgId = org.id;
  const location = await prisma.location.create({ data: { organizationId: orgId, name: `${TAG} Demo Venue`, timezone: 'Asia/Dubai' } });
  locationId = location.id;
  const floor = await prisma.department.create({ data: { locationId, name: 'Floor', tint: 'gold', sortOrder: 0 } });
  const bar = await prisma.department.create({ data: { locationId, name: 'Bar', tint: 'sage', sortOrder: 1 } });
  roleId = (await prisma.role.create({ data: { locationId, name: 'Waiter', departmentId: floor.id } })).id;
  barRoleId = (await prisma.role.create({ data: { locationId, name: 'Bartender', departmentId: bar.id } })).id;
  personA = (await prisma.user.create({ data: { locationId, fullName: 'Person A', systemRole: 'STAFF', roleId } })).id;
  personB = (await prisma.user.create({ data: { locationId, fullName: 'Person B', systemRole: 'STAFF', roleId: barRoleId } })).id;
  manager = (await prisma.user.create({ data: { locationId, fullName: 'Demo Manager', systemRole: 'MANAGER' } })).id;
  eveningTypeId = (
    await prisma.shiftType.create({ data: { locationId, name: 'Evening', ranges: [{ start: '16:00', end: '01:00' }], endsNextDay: true, tint: 'clay', sortOrder: 2 } })
  ).id;
  // Person A has a device (push subscription); Person B has none.
  await prisma.pushSubscription.create({ data: { userId: personA, endpoint: `https://push.invalid/${TAG}/${Date.now()}`, p256dh: 'k', auth: 'a' } });
});

after(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

test('create / update / delete round trip bumps the version once per patch and the document follows', async () => {
  const week = nextWeek();
  const monday = week;
  const empty = await getWeekDoc({ locationId, weekStart: week, viewer: { role: 'MANAGER' } });
  assert.equal(empty.version, 1, 'a week nobody has written is at version 1');
  assert.equal(empty.state, 'draft');
  assert.deepEqual(empty.departments.map((d) => d.name), ['Floor', 'Bar']);

  const created = ok(await patch(week, [{ op: 'create', tempId: 't1', userId: personA, date: monday, ranges: [{ start: '09:00', end: '17:00' }], note: 'Opening' }], { expectedVersion: 1 }), 'create');
  assert.equal(created.version, 2);
  assert.equal(created.results[0]!.tempId, 't1');
  const shiftId = created.results[0]!.shiftId!;
  const chip = created.week.shifts.find((s) => s.id === shiftId)!;
  assert.deepEqual(chip.ranges, [{ start: '09:00', end: '17:00' }]);
  assert.equal(chip.status, 'draft');
  assert.equal(chip.departmentId, created.week.departments.find((d) => d.name === 'Floor')!.id, 'department defaults to the role\'s');
  assert.equal(chip.note, 'Opening');
  assert.equal(created.week.hasUnpublishedChanges, true);
  assert.equal(created.week.coverage[0]!.on, 1);
  assert.equal(created.week.coverage[0]!.off, 2, 'Person B and the manager are off');

  const row = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } });
  // 09:00 Asia/Dubai (UTC+4) is 05:00Z; legacy readers keep working from these instants.
  assert.equal(row.startTime.toISOString(), `${monday}T05:00:00.000Z`);
  assert.equal(row.endTime.toISOString(), `${monday}T13:00:00.000Z`);
  assert.equal(row.status, 'DRAFT');

  const updated = ok(await patch(week, [{ op: 'update', shiftId, ranges: [{ start: '10:00', end: '18:00' }], note: null }], { expectedVersion: 2 }), 'update');
  assert.equal(updated.version, 3);
  assert.deepEqual(updated.week.shifts.find((s) => s.id === shiftId)!.ranges, [{ start: '10:00', end: '18:00' }]);
  assert.equal(updated.week.shifts.find((s) => s.id === shiftId)!.note, null);

  const deleted = ok(await patch(week, [{ op: 'delete', shiftId }], { expectedVersion: 3 }), 'delete');
  assert.equal(deleted.version, 4);
  assert.equal(deleted.week.shifts.length, 0);
  assert.equal(await prisma.shift.count({ where: { id: shiftId } }), 0, 'a draft is hard-deleted');

  const audits = await prisma.auditLog.findMany({ where: { locationId, entityType: 'RotaWeek', action: 'WEEK_PATCHED' } });
  assert.ok(audits.length >= 3, 'one WEEK_PATCHED row per patch');
  assert.ok(audits.every((a) => a.note?.startsWith('[grid]')));
});

test('a stale expectedVersion is a version_conflict carrying the current week; omitting it is allowed', async () => {
  const week = nextWeek();
  ok(await patch(week, [{ op: 'create', userId: personA, date: week, ranges: [{ start: '09:00', end: '12:00' }] }], { expectedVersion: 1 }));
  const stale = await patch(week, [{ op: 'create', userId: personB, date: week, ranges: [{ start: '09:00', end: '12:00' }] }], { expectedVersion: 1 });
  assert.equal(stale.result, 'version_conflict');
  if (stale.result === 'version_conflict') {
    assert.equal(stale.currentVersion, 2);
    assert.equal(stale.week.shifts.length, 1, 'nothing of the stale patch landed');
  }
  const legacy = ok(await patch(week, [{ op: 'create', userId: personB, date: week, ranges: [{ start: '09:00', end: '12:00' }] }]), 'no expectedVersion');
  assert.equal(legacy.version, 3);
});

test('two concurrent patches on the same version: exactly one lands', async () => {
  const week = nextWeek();
  const [a, b] = await Promise.all([
    patch(week, [{ op: 'create', userId: personA, date: addDays(week, 1), ranges: [{ start: '09:00', end: '12:00' }] }], { expectedVersion: 1 }),
    patch(week, [{ op: 'create', userId: personB, date: addDays(week, 1), ranges: [{ start: '09:00', end: '12:00' }] }], { expectedVersion: 1 }),
  ]);
  assert.deepEqual([a.result, b.result].sort(), ['ok', 'version_conflict']);
  const doc = await getWeekDoc({ locationId, weekStart: week, viewer: { role: 'MANAGER' } });
  assert.equal(doc.version, 2);
  assert.equal(doc.shifts.length, 1);
});

test('refusals: outside_week, past_day, already_has_shift, person_on_leave, leave_over_shift — and nothing lands', async () => {
  const week = nextWeek();
  refused(await patch(week, [{ op: 'create', userId: personA, date: addDays(week, 7), ranges: [{ start: '09:00', end: '12:00' }] }]), 'outside_week');
  refused(await patch(week, [{ op: 'create', userId: personA, date: addDays(week, -1), ranges: [{ start: '09:00', end: '12:00' }] }]), 'outside_week');
  const notMonday = await applyWeekPatch({ locationId, weekStart: addDays(week, 1), actorId: manager, source: 'grid', patch: { ops: [] } });
  refused(notMonday, 'not_monday');

  const pastWeek = mondayAhead(-3);
  refused(await patch(pastWeek, [{ op: 'create', userId: personA, date: pastWeek, ranges: [{ start: '09:00', end: '12:00' }] }]), 'past_day');
  // An import may backfill the past.
  const imported = await applyWeekPatch({
    locationId,
    weekStart: pastWeek,
    actorId: manager,
    source: 'import',
    patch: { ops: [{ op: 'create', userId: personA, date: pastWeek, ranges: [{ start: '09:00', end: '12:00' }] }] },
  });
  ok(imported, 'import into the past');

  const tue = addDays(week, 1);
  ok(await patch(week, [{ op: 'create', userId: personA, date: tue, ranges: [{ start: '09:00', end: '12:00' }] }]));
  // A second shift for the same person-day is refused, in one batch too (op 1 sees op 0).
  refused(await patch(week, [{ op: 'create', userId: personA, date: tue, ranges: [{ start: '14:00', end: '18:00' }] }]), 'already_has_shift');
  const wed = addDays(week, 2);
  const twoOnOneDay = await patch(week, [
    { op: 'create', userId: personB, date: wed, ranges: [{ start: '09:00', end: '12:00' }] },
    { op: 'create', userId: personB, date: wed, ranges: [{ start: '14:00', end: '18:00' }] },
  ]);
  refused(twoOnOneDay, 'already_has_shift', 'same batch');
  assert.equal((twoOnOneDay as Extract<WeekPatchResult, { result: 'refused' }>).op, 1);
  assert.equal(await prisma.shift.count({ where: { locationId, userId: personB, date: new Date(`${wed}T00:00:00.000Z`) } }), 0, 'op 0 rolled back with op 1');

  // Leave rules.
  refused(await patch(week, [{ op: 'setLeave', userId: personA, date: tue, type: 'DAY_OFF' }]), 'leave_over_shift');
  const thu = addDays(week, 3);
  ok(await patch(week, [{ op: 'setLeave', userId: personA, date: thu, type: 'ANNUAL_LEAVE' }]));
  refused(await patch(week, [{ op: 'create', userId: personA, date: thu, ranges: [{ start: '09:00', end: '12:00' }] }]), 'person_on_leave');
  // A day off gives way to a shift (and is removed), a blocking leave does not.
  const fri = addDays(week, 4);
  ok(await patch(week, [{ op: 'setLeave', userId: personA, date: fri, type: 'DAY_OFF' }]));
  const overDayOff = ok(await patch(week, [{ op: 'create', userId: personA, date: fri, ranges: [{ start: '09:00', end: '12:00' }] }]), 'shift over a day off');
  assert.equal(overDayOff.week.leaves.filter((l) => l.date === fri).length, 0);
  // Bad leave type.
  refused(await patch(week, [{ op: 'setLeave', userId: personA, date: addDays(week, 5), type: 'HOLIDAY' as unknown as 'DAY_OFF' }]), 'bad_leave_type');
  refused(await patch(week, [{ op: 'create', userId: personA, date: addDays(week, 5), ranges: [{ start: '09:00', end: '12:00' }], note: 'x'.repeat(81) }]), 'note_too_long');
  refused(await patch(week, [{ op: 'create', userId: personA, date: addDays(week, 5), ranges: [{ start: '9:00', end: '12:00' }] }]), 'bad_ranges');
  refused(await patch(week, [{ op: 'create', userId: personA, date: addDays(week, 5) }]), 'bad_ranges');
  refused(await patch(week, [{ op: 'create', userId: 'nobody', date: addDays(week, 5), ranges: [{ start: '09:00', end: '12:00' }] }]), 'unknown_person');
  refused(await patch(week, [{ op: 'update', shiftId: 'nothing', ranges: [{ start: '09:00', end: '12:00' }] }]), 'unknown_shift');
});

test('a pending time-off request refuses the shift until overridden, which declines the request in the same patch', async () => {
  const week = nextWeek();
  const sat = addDays(week, 5);
  const request = await prisma.timeOffRequest.create({
    data: { userId: personA, startDate: new Date(`${sat}T00:00:00.000Z`), endDate: new Date(`${sat}T00:00:00.000Z`), expiresAt: new Date(`${week}T00:00:00.000Z`) },
  });
  const doc = await getWeekDoc({ locationId, weekStart: week, viewer: { role: 'MANAGER' } });
  assert.deepEqual(doc.requests.map((r) => [r.kind, r.userId, r.dates]), [['timeOff', personA, [sat]]]);

  refused(await patch(week, [{ op: 'create', userId: personA, date: sat, ranges: [{ start: '09:00', end: '12:00' }] }]), 'pending_request');
  const forced = ok(await patch(week, [{ op: 'create', userId: personA, date: sat, ranges: [{ start: '09:00', end: '12:00' }] }], { overridePendingRequests: true }), 'override');
  assert.deepEqual(forced.declinedRequestIds, [request.id]);
  const after = await prisma.timeOffRequest.findUniqueOrThrow({ where: { id: request.id } });
  assert.equal(after.status, 'DECLINED');
  assert.equal(after.reviewedById, manager);
  assert.equal(after.managerNote, 'Declined by scheduling');
  assert.equal(forced.week.requests.length, 0);
  assert.equal(forced.week.shifts[0]!.pendingRequestId, null);
});

test('a split shift is one row with two ranges whose instants span both; a cross-midnight type ends the next venue day', async () => {
  const week = nextWeek();
  const mon = week;
  const split = ok(await patch(week, [{ op: 'create', userId: personA, date: mon, ranges: [{ start: '07:00', end: '11:00' }, { start: '17:00', end: '23:00' }] }]), 'split');
  const splitRow = await prisma.shift.findUniqueOrThrow({ where: { id: split.results[0]!.shiftId! } });
  assert.deepEqual(splitRow.ranges, [{ start: '07:00', end: '11:00' }, { start: '17:00', end: '23:00' }]);
  assert.equal(splitRow.endsNextDay, false);
  assert.equal(splitRow.startTime.toISOString(), `${mon}T03:00:00.000Z`, '07:00 Dubai');
  assert.equal(splitRow.endTime.toISOString(), `${mon}T19:00:00.000Z`, '23:00 Dubai');
  assert.equal(await prisma.shift.count({ where: { locationId, userId: personA, date: new Date(`${mon}T00:00:00.000Z`) } }), 1);

  const evening = ok(await patch(week, [{ op: 'create', userId: personB, date: mon, shiftTypeId: eveningTypeId }]), 'evening');
  const eveningRow = await prisma.shift.findUniqueOrThrow({ where: { id: evening.results[0]!.shiftId! } });
  assert.equal(eveningRow.shiftTypeId, eveningTypeId);
  assert.equal(eveningRow.endsNextDay, true);
  assert.deepEqual(eveningRow.ranges, [{ start: '16:00', end: '01:00' }]);
  assert.equal(eveningRow.startTime.toISOString(), `${mon}T12:00:00.000Z`, '16:00 Dubai');
  assert.equal(eveningRow.endTime.toISOString(), `${mon}T21:00:00.000Z`, '01:00 Dubai the next day = 21:00Z the same UTC day');
  // Person B's Tuesday shift at 00:30 would overlap the tail of the evening shift.
  refused(await patch(week, [{ op: 'create', userId: personB, date: addDays(mon, 1), ranges: [{ start: '00:30', end: '08:00' }] }]), 'overlap');

  // A staff viewer sees nothing until publish; the manager sees both drafts.
  const staffView = await getWeekDoc({ locationId, weekStart: week, viewer: { role: 'STAFF', userId: personA } });
  assert.equal(staffView.shifts.length, 0);
  const managerView = await getWeekDoc({ locationId, weekStart: week, viewer: { role: 'MANAGER' } });
  assert.equal(managerView.shifts.length, 2);
});

test('publish: the first publish lists everyone, the next lists only who changed, a removal is a change, a stale fingerprint is refused', async () => {
  const week = nextWeek();
  const mon = week;
  const tue = addDays(week, 1);
  const first = ok(
    await patch(week, [
      { op: 'create', userId: personA, date: mon, ranges: [{ start: '09:00', end: '17:00' }] },
      { op: 'create', userId: personB, date: mon, shiftTypeId: eveningTypeId },
      { op: 'setLeave', userId: personB, date: tue, type: 'DAY_OFF' },
    ]),
  );
  const aShift = first.results[0]!.shiftId!;
  const bShift = first.results[1]!.shiftId!;

  const preview1 = await previewWeekPublish({ locationId, weekStart: week });
  assert.equal(preview1.firstPublish, true);
  assert.equal(preview1.version, first.version);
  assert.equal(preview1.changeCount, 3);
  assert.deepEqual(preview1.rows.map((r) => r.fullName), ['Person A', 'Person B']);
  assert.deepEqual(preview1.rows.find((r) => r.userId === personB)!.changes.map((c) => c.after), ['Evening 16:00–01:00', 'Day off']);
  assert.equal(preview1.notifiedCount, 1, 'Person A has a device');
  assert.deepEqual(preview1.noDeviceUserIds, [personB]);
  assert.match(preview1.fingerprint, /^[0-9a-f]{64}$/);

  const published = await publishWeek({ locationId, weekStart: week, actorId: manager, expectedVersion: preview1.version, fingerprint: preview1.fingerprint });
  assert.equal(published.result, 'ok');
  if (published.result !== 'ok') return;
  assert.equal(published.notifiedCount, 1);
  const doc = await getWeekDoc({ locationId, weekStart: week, viewer: { role: 'STAFF', userId: personA } });
  assert.equal(doc.state, 'published');
  assert.equal(doc.publishedVersion, published.version);
  assert.equal(doc.version, published.version);
  assert.equal(doc.hasUnpublishedChanges, false);
  assert.equal(doc.shifts.length, 2, 'staff now see the published shifts');
  assert.equal(doc.leaves.length, 1);
  assert.ok(doc.shifts.every((s) => s.status === 'published' && !s.editedSincePublish));
  const notice = await prisma.notification.findFirst({ where: { userId: personA, title: 'Your week is ready' }, orderBy: { createdAt: 'desc' } });
  assert.ok(notice, 'Person A was told their week is ready');
  assert.equal(await prisma.rotaPublish.count({ where: { locationId, weekStart: new Date(`${week}T00:00:00.000Z`) } }), 1, 'the legacy publish row is kept in step');

  // Nothing changed: an empty diff, not a first publish.
  const unchanged = await previewWeekPublish({ locationId, weekStart: week });
  assert.equal(unchanged.firstPublish, false);
  assert.equal(unchanged.changeCount, 0);

  // One edit: only Person A is listed, with before and after; the chip carries the gold dot.
  const edited = ok(await patch(week, [{ op: 'update', shiftId: aShift, ranges: [{ start: '10:00', end: '18:00' }] }], { expectedVersion: doc.version }));
  assert.equal(edited.week.shifts.find((s) => s.id === aShift)!.editedSincePublish, true);
  assert.equal(edited.week.hasUnpublishedChanges, true);
  const preview2 = await previewWeekPublish({ locationId, weekStart: week });
  assert.equal(preview2.changeCount, 1);
  assert.deepEqual(preview2.rows.map((r) => r.userId), [personA]);
  assert.deepEqual(preview2.rows[0]!.changes, [{ date: mon, before: '09:00–17:00', after: '10:00–18:00', urgent: false }]);

  // A further edit after the preview: the fingerprint no longer matches and the fresh preview comes back.
  ok(await patch(week, [{ op: 'delete', shiftId: bShift }], { expectedVersion: edited.version }));
  const cancelled = await prisma.shift.findUniqueOrThrow({ where: { id: bShift } });
  assert.equal(cancelled.status, 'CANCELLED', 'a published shift is soft-cancelled until the next publish');
  const stale = await publishWeek({ locationId, weekStart: week, actorId: manager, expectedVersion: preview2.version, fingerprint: preview2.fingerprint });
  assert.equal(stale.result, 'version_conflict');
  const preview3 = await previewWeekPublish({ locationId, weekStart: week });
  const mismatch = await publishWeek({ locationId, weekStart: week, actorId: manager, expectedVersion: preview3.version, fingerprint: preview2.fingerprint });
  assert.equal(mismatch.result, 'fingerprint_mismatch');
  if (mismatch.result === 'fingerprint_mismatch') assert.equal(mismatch.preview.fingerprint, preview3.fingerprint);

  // The removal shows for Person B as before → null.
  assert.equal(preview3.changeCount, 2);
  const bRow = preview3.rows.find((r) => r.userId === personB)!;
  assert.deepEqual(bRow.changes, [{ date: mon, before: 'Evening 16:00–01:00', after: null, urgent: false }]);

  const second = await publishWeek({ locationId, weekStart: week, actorId: manager, expectedVersion: preview3.version, fingerprint: preview3.fingerprint });
  assert.equal(second.result, 'ok');
  assert.equal(await prisma.shift.count({ where: { id: bShift } }), 0, 'publishing hard-deletes the cancelled shift');
  assert.equal(await prisma.notification.count({ where: { userId: personA, title: 'Your week changed' } }), 1);
  assert.equal(await prisma.notification.count({ where: { userId: personB } }), 0, 'no device, no notice (listed in noDeviceUserIds instead)');

  // An empty week has nothing to publish.
  const emptyWeek = nextWeek();
  const emptyPreview = await previewWeekPublish({ locationId, weekStart: emptyWeek });
  const empty = await publishWeek({ locationId, weekStart: emptyWeek, actorId: manager, expectedVersion: 1, fingerprint: emptyPreview.fingerprint });
  assert.equal(empty.result, 'empty');
});

test('a reassignment is a change for both people, and moving a shift clears its floor-section assignment', async () => {
  const week = nextWeek();
  const mon = week;
  const tue = addDays(week, 1);
  const created = ok(await patch(week, [{ op: 'create', userId: personA, date: mon, ranges: [{ start: '09:00', end: '17:00' }] }]));
  const shiftId = created.results[0]!.shiftId!;
  const preview = await previewWeekPublish({ locationId, weekStart: week });
  assert.equal((await publishWeek({ locationId, weekStart: week, actorId: manager, expectedVersion: preview.version, fingerprint: preview.fingerprint })).result, 'ok');

  const image = await prisma.floorPlanImage.create({ data: { locationId, fileUrl: `/uploads/floor-plans/${TAG}.png`, mimeType: 'image/png' } });
  const section = await prisma.floorSection.create({ data: { locationId, floorPlanImageId: image.id, label: 'Terrace', paxCapacity: 4 } });
  const assignment = await prisma.sectionAssignment.create({ data: { sectionId: section.id, staffId: personA, shiftDate: new Date(`${mon}T00:00:00.000Z`) } });

  // Hand the shift to Person B on Tuesday: Person A loses Monday, Person B gains Tuesday, the Monday section assignment goes.
  const doc = await getWeekDoc({ locationId, weekStart: week, viewer: { role: 'MANAGER' } });
  ok(await patch(week, [{ op: 'update', shiftId, userId: personB, date: tue }], { expectedVersion: doc.version }));
  assert.equal(await prisma.sectionAssignment.count({ where: { id: assignment.id } }), 0);
  const diff = await previewWeekPublish({ locationId, weekStart: week });
  assert.equal(diff.changeCount, 2);
  assert.deepEqual(
    diff.rows.map((r) => [r.userId, r.changes[0]!.date, r.changes[0]!.before, r.changes[0]!.after]),
    [
      [personA, mon, '09:00–17:00', null],
      [personB, tue, null, '09:00–17:00'],
    ],
  );
});
