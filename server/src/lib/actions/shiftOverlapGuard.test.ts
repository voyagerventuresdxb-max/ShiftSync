import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../app.js';
import { issueSession } from '../identity.js';
import { createShift, ShiftOverlapError, SHIFT_OVERLAP_CONSTRAINT } from './shiftActions.js';
import { persistShifts } from '../../parsing/persistShifts.js';

const prisma = new PrismaClient();
const TAG = '__shift-overlap-guard-test__';

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

async function venue() {
  const seed = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seed, 'seed data (a location) must exist to run this test');
  const location = await prisma.location.create({ data: { organizationId: seed!.organizationId, name: `${TAG} venue`, timezone: 'Asia/Dubai' } });
  const role = await prisma.role.create({ data: { locationId: location.id, name: `${TAG} role` } });
  const manager = await prisma.user.create({ data: { locationId: location.id, fullName: `${TAG} Manager`, systemRole: 'MANAGER' } });
  const staff = await prisma.user.create({ data: { locationId: location.id, fullName: `${TAG} Staff`, systemRole: 'STAFF', roleId: role.id } });
  return { location, role, manager, staff };
}

const DAY = '2026-11-03';
const at = (hhmm: string, day = DAY) => new Date(`${day}T${hhmm}:00.000Z`);

test('six simultaneous creates of overlapping shifts for one person: exactly one 201, the rest 409, one row', async () => {
  const { location, role, manager, staff } = await venue();
  try {
    const { plainToken } = await issueSession(manager.id);
    await withServer(async (baseUrl) => {
      const responses = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          fetch(`${baseUrl}/api/shifts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${plainToken}` },
            body: JSON.stringify({ locationId: location.id, roleId: role.id, userId: staff.id, date: DAY, start: `${String(9 + (i % 3)).padStart(2, '0')}:00`, end: '17:00' }),
          }),
        ),
      );
      const statuses = responses.map((r) => r.status).sort();
      assert.deepEqual(statuses, [201, 409, 409, 409, 409, 409], `statuses: ${statuses.join(',')}`);
      for (const r of responses) {
        if (r.status === 409) assert.match(((await r.json()) as { error: string }).error, /can't overlap/);
      }
      assert.equal(await prisma.shift.count({ where: { userId: staff.id } }), 1);
    });
  } finally {
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});

test('two concurrent direct createShift calls: one row; the loser is a ShiftOverlapError from the constraint, not a raw database error', async () => {
  const { location, role, staff } = await venue();
  try {
    for (let round = 0; round < 3; round++) {
      await prisma.shift.deleteMany({ where: { locationId: location.id } });
      const outcomes = await Promise.allSettled([
        createShift({ location: { connect: { id: location.id } }, role: { connect: { id: role.id } }, assignee: { connect: { id: staff.id } }, date: at('00:00'), startTime: at('05:00'), endTime: at('13:00') }),
        createShift({ location: { connect: { id: location.id } }, role: { connect: { id: role.id } }, assignee: { connect: { id: staff.id } }, date: at('00:00'), startTime: at('08:00'), endTime: at('16:00') }),
      ]);
      const ok = outcomes.filter((o) => o.status === 'fulfilled').length;
      assert.equal(ok, 1, `round ${round}: exactly one create may win`);
      const lost = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
      assert.ok(lost.reason instanceof ShiftOverlapError, `round ${round}: ${String(lost.reason)}`);
      assert.equal(await prisma.shift.count({ where: { userId: staff.id } }), 1);
    }
  } finally {
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});

test('the constraint holds even for a raw INSERT that bypasses every app check; touching, open and CANCELLED shifts are allowed', async () => {
  const { location, role, staff } = await venue();
  try {
    await prisma.shift.create({ data: { locationId: location.id, roleId: role.id, userId: staff.id, date: at('00:00'), startTime: at('05:00'), endTime: at('11:00') } });
    const rawInsert = (start: string, end: string, userId: string | null, status = 'DRAFT') =>
      prisma.$executeRawUnsafe(
        `INSERT INTO shifts (id, location_id, role_id, user_id, date, start_time, end_time, status, break_minutes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::"ShiftStatus", 0, now(), now())`,
        `${TAG}-${start}-${status}-${userId ? 'u' : 'open'}`,
        location.id,
        role.id,
        userId,
        at('00:00'),
        at(start),
        at(end),
        status,
      );
    await assert.rejects(rawInsert('10:00', '14:00', staff.id), (err: unknown) => err instanceof Error && JSON.stringify(err).includes(SHIFT_OVERLAP_CONSTRAINT));
    await rawInsert('11:00', '15:00', staff.id); // touches at 11:00: allowed
    await rawInsert('06:00', '10:00', null); // open shift: outside the rule
    await rawInsert('06:00', '10:00', staff.id, 'CANCELLED'); // cancelled: outside the rule
    assert.equal(await prisma.shift.count({ where: { locationId: location.id } }), 4);
  } finally {
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});

test('a roster import whose rows overlap a stored shift (or each other) is refused as a whole: 409 message, nothing imported', async () => {
  const { location, role, staff } = await venue();
  try {
    await prisma.shift.create({ data: { locationId: location.id, roleId: role.id, userId: staff.id, date: at('00:00'), startTime: at('05:00'), endTime: at('13:00') } });
    const row = (rowNumber: number, startTime: string, endTime: string) => ({
      rowNumber,
      employeeName: staff.fullName,
      roleName: role.name,
      date: DAY,
      startTime,
      endTime,
      overnight: false,
      breakMinutes: 0,
      managerNotes: null,
      resolvedUserId: staff.id,
      resolvedRoleId: role.id,
      status: 'ok' as const,
    });
    // 11:00 Dubai = 07:00Z, inside the stored 05:00Z–13:00Z shift.
    await assert.rejects(
      prisma.$transaction((tx) => persistShifts(tx, location.id, null, [row(1, '11:00', '15:00') as never, row(2, '20:00', '23:00') as never])),
      (err: unknown) => err instanceof ShiftOverlapError && /can't overlap/.test(err.message),
    );
    assert.equal(await prisma.shift.count({ where: { locationId: location.id } }), 1, 'the whole import is refused, not half of it');
    // Two rows of the same file overlapping each other are refused too.
    await assert.rejects(
      prisma.$transaction((tx) => persistShifts(tx, location.id, null, [row(1, '18:00', '22:00') as never, row(2, '21:00', '23:00') as never])),
      ShiftOverlapError,
    );
    assert.equal(await prisma.shift.count({ where: { locationId: location.id } }), 1);
  } finally {
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});

test('the documented detection query lists an existing overlapping pair, and the migration pre-check refuses it (constraint dropped inside a rolled-back transaction)', async () => {
  const { location, role, staff } = await venue();
  const detection = `
    SELECT a.id AS shift_a, b.id AS shift_b
    FROM shifts a
    JOIN shifts b ON a.user_id = b.user_id AND a.id < b.id AND a.start_time < b.end_time AND b.start_time < a.end_time
    WHERE a.user_id IS NOT NULL AND a.status <> 'CANCELLED' AND b.status <> 'CANCELLED' AND a.location_id = $1`;
  const precheck = `
    DO $$
    DECLARE violating_pairs integer;
    BEGIN
      SELECT count(*) INTO violating_pairs FROM shifts a JOIN shifts b
        ON a.user_id = b.user_id AND a.id < b.id AND a.start_time < b.end_time AND b.start_time < a.end_time
       WHERE a.user_id IS NOT NULL AND a.status <> 'CANCELLED' AND b.status <> 'CANCELLED';
      IF violating_pairs > 0 THEN
        RAISE EXCEPTION USING MESSAGE = format('shift_no_overlap_per_user: %s pair(s) of overlapping shifts for one person already exist; resolve them before applying this migration', violating_pairs);
      END IF;
    END $$`;
  try {
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`ALTER TABLE shifts DROP CONSTRAINT "${SHIFT_OVERLAP_CONSTRAINT}"`);
        await tx.shift.create({ data: { locationId: location.id, roleId: role.id, userId: staff.id, date: at('00:00'), startTime: at('05:00'), endTime: at('13:00') } });
        await tx.shift.create({ data: { locationId: location.id, roleId: role.id, userId: staff.id, date: at('00:00'), startTime: at('09:00'), endTime: at('17:00') } });
        const pairs = await tx.$queryRawUnsafe<{ shift_a: string; shift_b: string }[]>(detection, location.id);
        assert.equal(pairs.length, 1, 'the detection query lists the pair');
        await tx.$executeRawUnsafe(precheck); // raises → the transaction (and the dropped constraint) rolls back
      }),
      (err: unknown) => err instanceof Error && JSON.stringify(err).includes('1 pair(s) of overlapping shifts'),
    );
    // Rolled back: the constraint is still there and still enforced.
    // Scoped to the current schema: the local dev database holds one schema per
    // branch, and every branch that has applied this migration carries a
    // constraint of the same name.
    const constraint = await prisma.$queryRawUnsafe<{ conname: string }[]>(
      `SELECT conname FROM pg_constraint WHERE conname = $1 AND connamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())`,
      SHIFT_OVERLAP_CONSTRAINT,
    );
    assert.equal(constraint.length, 1);
    assert.equal(await prisma.shift.count({ where: { locationId: location.id } }), 0);
  } finally {
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});
