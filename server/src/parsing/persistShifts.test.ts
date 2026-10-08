import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { persistRosterImport, type RosterImportInput } from './persistShifts.js';
import { resolveRowsAgainstDatabase, TEAM_MEMBER_ROLE_NAME } from './resolveRows.js';
import type { ParsedShiftRow } from './types.js';

const prisma = new PrismaClient();

function parsed(overrides: Partial<ParsedShiftRow>): ParsedShiftRow {
  return {
    rowNumber: 1,
    employeeName: '__persist-test__ Ava Thornton',
    roleName: '',
    date: '2031-05-05',
    startTime: '09:00',
    endTime: '17:00',
    overnight: false,
    breakMinutes: 0,
    managerNotes: null,
    ...overrides,
  };
}

async function importRows(locationId: string, actorId: string, rows: ParsedShiftRow[], extra: Partial<RosterImportInput> = {}) {
  const { previewRows, people } = await resolveRowsAgainstDatabase(prisma, locationId, rows);
  return prisma.$transaction(
    (tx) =>
      persistRosterImport(tx, {
        locationId,
        actorId,
        createdById: actorId,
        rows: previewRows,
        people,
        decisions: new Map(),
        addedPeople: [],
        weekDeltaDays: 0,
        rememberRoleMappings: false,
        ...extra,
      }),
    { timeout: 30_000 },
  );
}

test('persistRosterImport: rows correlate by rowNumber, every person gets a staff record, role-unresolved shifts land under "Team member"', async () => {
  const seed = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seed, 'seed data (a location) must exist to run this test — run npm run db:seed first');
  const location = await prisma.location.create({ data: { organizationId: seed!.organizationId, name: '__persist-test__ venue', timezone: 'Asia/Dubai' } });
  const manager = await prisma.user.create({ data: { locationId: location.id, fullName: '__persist-test__ manager', systemRole: 'MANAGER' } });
  await prisma.role.create({ data: { locationId: location.id, name: 'Waiter' } });

  try {
    const rows = [
      parsed({ rowNumber: 5, sourceRowIndex: 1, employeeName: '__persist-test__ Ava Thornton', roleName: 'Waiter' }),
      parsed({ rowNumber: 2, sourceRowIndex: 2, employeeName: '__persist-test__ Ben Okafor', roleName: 'Wine Steward' }),
      parsed({ rowNumber: 9, sourceRowIndex: 2, employeeName: '__persist-test__ Ben Okafor', roleName: 'Wine Steward', date: '2031-05-06' }),
    ];
    const first = await importRows(location.id, manager.id, rows);

    assert.equal(first.createdPeople, 2);
    assert.equal(first.createdShifts, 3);
    assert.equal(first.skippedRowCount, 0);
    const byRow = new Map(first.rows.map((r) => [r.rowNumber, r]));
    assert.deepEqual([...byRow.keys()].sort((a, b) => a - b), [2, 5, 9]);
    assert.match(byRow.get(5)!.shiftId, /^c/, 'a real cuid');

    const ben = await prisma.user.findFirst({ where: { locationId: location.id, fullName: '__persist-test__ Ben Okafor' }, include: { role: true } });
    assert.equal(ben?.role?.name, TEAM_MEMBER_ROLE_NAME);
    assert.equal(ben?.systemRole, 'STAFF');
    const benShifts = await prisma.shift.findMany({ where: { userId: ben!.id }, include: { role: true } });
    assert.equal(benShifts.length, 2);
    assert.ok(benShifts.every((s) => s.role.name === TEAM_MEMBER_ROLE_NAME));

    const staffAudits = await prisma.auditLog.count({ where: { locationId: location.id, action: 'STAFF_CREATED' } });
    assert.equal(staffAudits, 2, 'one STAFF_CREATED entry per new staff member');

    // Same roster again: nothing new.
    const second = await importRows(location.id, manager.id, rows);
    assert.equal(second.createdPeople, 0);
    assert.equal(second.linkedPeople, 2);
    assert.equal(second.createdShifts, 0);
    assert.equal(second.skippedDuplicates, 3);
    assert.equal(await prisma.user.count({ where: { locationId: location.id } }), 3);
    assert.equal(await prisma.shift.count({ where: { locationId: location.id } }), 3);
  } finally {
    await prisma.auditLog.deleteMany({ where: { locationId: location.id } });
    await prisma.shift.deleteMany({ where: { locationId: location.id } });
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});
