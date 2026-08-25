import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { persistShifts } from './persistShifts.js';
import type { PreviewRow } from './types.js';

const prisma = new PrismaClient();

function baseRow(overrides: Partial<PreviewRow>): PreviewRow {
  return {
    rowNumber: 1,
    employeeName: 'Test Employee',
    roleName: '',
    date: '2026-08-24',
    startTime: '09:00',
    endTime: '17:00',
    overnight: false,
    breakMinutes: 0,
    managerNotes: null,
    status: 'matched',
    issues: [],
    resolvedRoleId: null,
    resolvedUserId: null,
    ...overrides,
  };
}

test('persistShifts returns rows correlated by rowNumber, not array position', async () => {
  const location = await prisma.location.findFirst();
  const role = await prisma.role.findFirst({ where: { locationId: location!.id } });
  const user = await prisma.user.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && role, 'seed data (location + role) must exist to run this test — run server/scripts/seed-test-data.ts first');

  const rows: PreviewRow[] = [
    baseRow({ rowNumber: 5, resolvedRoleId: role!.id, resolvedUserId: user?.id ?? null }),
    baseRow({ rowNumber: 2, resolvedRoleId: role!.id, resolvedUserId: null }), // unassigned (new_employee case)
    baseRow({ rowNumber: 9, resolvedRoleId: null }), // unresolved role — must be skipped, not persisted
  ];

  const result = await persistShifts(prisma, location!.id, null, rows);

  assert.equal(result.createdCount, 2);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.rows.length, 2);

  const byRowNumber = new Map(result.rows.map((r) => [r.rowNumber, r]));
  assert.ok(byRowNumber.has(5), 'row 5 (resolved) must be in the result');
  assert.ok(byRowNumber.has(2), 'row 2 (unassigned but role-resolved) must be in the result');
  assert.ok(!byRowNumber.has(9), 'row 9 (unresolved role) must NOT be in the result');
  assert.equal(byRowNumber.get(2)!.userId, null, 'an unassigned row reports userId: null, not a fabricated id');
  assert.match(byRowNumber.get(5)!.shiftId, /^c/, 'shiftId looks like a real cuid, not a synthetic string');

  // Clean up the shifts this test created.
  await prisma.shift.deleteMany({ where: { id: { in: result.rows.map((r) => r.shiftId) } } });
});
