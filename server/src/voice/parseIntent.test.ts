import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { buildContext } from './parseIntent.js';

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
