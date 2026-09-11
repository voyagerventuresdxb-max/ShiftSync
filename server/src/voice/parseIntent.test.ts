import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { buildContext, normalizeHasAdditionalRequest } from './parseIntent.js';

const prisma = new PrismaClient();

test("buildContext never includes another caller's shifts in callerShifts", async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  const role = await prisma.role.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && role, 'seed data (location + role) must exist to run this test');

  const callerA = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task7-test__ query-schedule caller A', systemRole: 'STAFF' },
  });
  const callerB = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task7-test__ query-schedule caller B', systemRole: 'STAFF' },
  });

  const shiftDate = new Date('2026-09-25T00:00:00.000Z');
  const shiftA = await prisma.shift.create({
    data: {
      locationId: location!.id, roleId: role!.id, userId: callerA.id,
      date: shiftDate, startTime: new Date('2026-09-25T09:00:00.000Z'), endTime: new Date('2026-09-25T17:00:00.000Z'), status: 'PUBLISHED',
    },
  });
  const shiftB = await prisma.shift.create({
    data: {
      locationId: location!.id, roleId: role!.id, userId: callerB.id,
      date: shiftDate, startTime: new Date('2026-09-25T10:00:00.000Z'), endTime: new Date('2026-09-25T18:00:00.000Z'), status: 'PUBLISHED',
    },
  });

  try {
    const contextForA = await buildContext({ id: callerA.id, systemRole: 'STAFF', fullName: callerA.fullName, locationId: location!.id });
    const idsForA = contextForA.callerShifts.map((s) => s.id);
    assert.ok(idsForA.includes(shiftA.id), "caller A's context must include their own shift");
    assert.ok(!idsForA.includes(shiftB.id), "caller A's context must NOT include caller B's shift");

    const contextForB = await buildContext({ id: callerB.id, systemRole: 'STAFF', fullName: callerB.fullName, locationId: location!.id });
    const idsForB = contextForB.callerShifts.map((s) => s.id);
    assert.ok(idsForB.includes(shiftB.id), "caller B's context must include their own shift");
    assert.ok(!idsForB.includes(shiftA.id), "caller B's context must NOT include caller A's shift");
  } finally {
    await prisma.shift.delete({ where: { id: shiftA.id } }).catch(() => {});
    await prisma.shift.delete({ where: { id: shiftB.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: callerA.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: callerB.id } }).catch(() => {});
  }
});

test("buildContext populates a MANAGER-tier caller's own shift in callerShifts correctly, alongside the venue-wide weekShifts it also gets", async () => {
  // MANAGER/OWNER-tier callers additionally get ctx.weekShifts (the whole
  // venue's shifts, every assignee's name included) for EDIT_SHIFT/
  // ASSIGN_SECTION. QUERY_MY_SCHEDULE must still only ever be answered from
  // callerShifts — this test proves buildContext itself still populates the
  // manager's OWN shift into callerShifts correctly when both lists are
  // present. It cannot prove the model actually honors the prompt
  // instruction not to use weekShifts for this intent — that needs a live
  // Gemini call — but it does prove the context-building data the
  // instruction relies on is correct.
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  const role = await prisma.role.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && role, 'seed data (location + role) must exist to run this test');

  const manager = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task7-test__ query-schedule manager', systemRole: 'MANAGER' },
  });
  const staffer = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task7-test__ query-schedule other staffer', systemRole: 'STAFF' },
  });

  // weekShifts is bounded to [today, today+7) — unlike callerShifts, which
  // has no upper bound — so this must land within the next few days of the
  // REAL current date rather than a fixed future literal, or it would fall
  // outside buildContext's weekShifts window and the assertion below it
  // depends on would never see it.
  const shiftDateStr = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const shiftDate = new Date(`${shiftDateStr}T00:00:00.000Z`);
  const managerShift = await prisma.shift.create({
    data: {
      locationId: location!.id, roleId: role!.id, userId: manager.id,
      date: shiftDate, startTime: new Date(`${shiftDateStr}T09:00:00.000Z`), endTime: new Date(`${shiftDateStr}T17:00:00.000Z`), status: 'PUBLISHED',
    },
  });
  const stafferShift = await prisma.shift.create({
    data: {
      locationId: location!.id, roleId: role!.id, userId: staffer.id,
      date: shiftDate, startTime: new Date(`${shiftDateStr}T11:00:00.000Z`), endTime: new Date(`${shiftDateStr}T19:00:00.000Z`), status: 'PUBLISHED',
    },
  });

  try {
    const context = await buildContext({ id: manager.id, systemRole: 'MANAGER', fullName: manager.fullName, locationId: location!.id });

    const callerShiftIds = context.callerShifts.map((s) => s.id);
    assert.ok(callerShiftIds.includes(managerShift.id), "manager's callerShifts must include their own shift");
    assert.ok(!callerShiftIds.includes(stafferShift.id), "manager's callerShifts must NOT include the other staffer's shift");

    // Sanity-check the coupling this fix is about: weekShifts (the
    // venue-wide list this tier also gets) is populated and DOES include the
    // other staffer's shift — proving the two lists really do coexist in a
    // manager's context, which is exactly why the prompt instruction has to
    // steer the model away from weekShifts for this intent.
    assert.ok(context.weekShifts?.some((s) => s.id === stafferShift.id), "manager's weekShifts must include the other staffer's shift (venue-wide, for other intents)");
  } finally {
    await prisma.shift.delete({ where: { id: managerShift.id } }).catch(() => {});
    await prisma.shift.delete({ where: { id: stafferShift.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: staffer.id } }).catch(() => {});
  }
});

test('normalizeHasAdditionalRequest: true stays true', () => {
  assert.equal(normalizeHasAdditionalRequest({ hasAdditionalRequest: true }), true);
});

test('normalizeHasAdditionalRequest: false stays false', () => {
  assert.equal(normalizeHasAdditionalRequest({ hasAdditionalRequest: false }), false);
});

test('normalizeHasAdditionalRequest: missing fails closed to false', () => {
  assert.equal(normalizeHasAdditionalRequest({}), false);
});

test('normalizeHasAdditionalRequest: non-boolean fails closed to false', () => {
  assert.equal(normalizeHasAdditionalRequest({ hasAdditionalRequest: 'true' }), false);
  assert.equal(normalizeHasAdditionalRequest({ hasAdditionalRequest: 1 }), false);
  assert.equal(normalizeHasAdditionalRequest({ hasAdditionalRequest: null }), false);
});
