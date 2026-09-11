import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { createShift, updateShift } from './shiftActions.js';

const prisma = new PrismaClient();

test('createShift creates a real Shift row with the shared SHIFT_INCLUDE shape', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  const role = await prisma.role.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && role, 'seed data must exist to run this test');

  const shift = await createShift({
    location: { connect: { id: location!.id } },
    role: { connect: { id: role!.id } },
    date: new Date('2026-09-20T00:00:00.000Z'),
    startTime: new Date('2026-09-20T09:00:00.000Z'),
    endTime: new Date('2026-09-20T17:00:00.000Z'),
    breakMinutes: 30,
    sidework: [],
    status: 'DRAFT',
  });

  try {
    assert.ok(shift.id);
    assert.equal(shift.role.id, role!.id, 'the shared SHIFT_INCLUDE must eager-load role');
    assert.equal(shift.assignee, null);

    const updated = await updateShift(shift.id, { breakMinutes: 45 });
    assert.equal(updated.breakMinutes, 45);
  } finally {
    await prisma.shift.delete({ where: { id: shift.id } }).catch(() => {});
  }
});
