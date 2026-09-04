import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { PrismaClient, Prisma } from '@prisma/client';
import { createApp } from '../app.js';
import { issueSession } from '../lib/identity.js';

const prisma = new PrismaClient();

/** Starts the real Express app on an ephemeral port and hands the caller its base URL. */
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

/** Issues a real bearer session token for a real User, exactly like a login would. */
async function sessionFor(userId: string): Promise<string> {
  const { plainToken } = await issueSession(userId);
  return plainToken;
}

/** Builds a throwaway Location + one STAFF User for a test. Everything cascades off the location row, so `prisma.location.delete` is the only cleanup a caller needs. */
async function createTestStaff(label: string) {
  const seedLocation = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seedLocation, 'seed data (a location) must exist to run this test');
  const location = await prisma.location.create({
    data: { organizationId: seedLocation!.organizationId, name: `__attendance-test__ ${label}`, timezone: 'Asia/Dubai' },
  });
  const staff = await prisma.user.create({
    data: { locationId: location.id, fullName: `__attendance-test__ ${label} Staff`, systemRole: 'STAFF' },
  });
  return { location, staff };
}

test('POST /api/attendance/clock-in rejects a second clock-in while one is already open — no double open AttendanceLog', async () => {
  const { location, staff } = await createTestStaff('double clock-in');

  try {
    const token = await sessionFor(staff.id);
    await withServer(async (baseUrl) => {
      const clockIn = () =>
        fetch(`${baseUrl}/api/attendance/clock-in`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({}),
        });

      // 1. Clock in once, for real — this moves the state the guard defends
      //    (an open AttendanceLog for this user now exists).
      const first = await clockIn();
      assert.equal(first.status, 201);
      const firstBody = (await first.json()) as { id: string; clockOutAt: string | null };
      assert.equal(firstBody.clockOutAt, null);

      // 2. Clock in again with the ORIGINAL stale expectation (no open log)
      //    a naive caller might have started from. The guard re-checked
      //    inside the transaction must find the open log and reject this
      //    as a conflict, not create a second open AttendanceLog.
      const second = await clockIn();
      assert.equal(second.status, 409, 'a second clock-in while one is already open must be rejected');

      const openLogs = await prisma.attendanceLog.findMany({ where: { userId: staff.id, clockOutAt: null } });
      assert.equal(openLogs.length, 1, 'the losing call must not have created a second open AttendanceLog');
      assert.equal(openLogs[0]!.id, firstBody.id, 'the one open log must still be the FIRST call\'s row');
    });
  } finally {
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});

// 2026-09-04 — proving the DB-level partial unique index
// (`attendance_logs_one_open_per_user`) actually closes the TOCTOU race the
// sequential test above cannot exercise (it only replays a stale
// expectation, never a genuine simultaneous request).
test('POST /api/attendance/clock-in — genuinely concurrent double clock-in leaves exactly one open AttendanceLog', async () => {
  const { location, staff } = await createTestStaff('concurrent double clock-in');

  try {
    const token = await sessionFor(staff.id);
    await withServer(async (baseUrl) => {
      const clockIn = () =>
        fetch(`${baseUrl}/api/attendance/clock-in`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({}),
        });

      // Fire two requests genuinely concurrently. NOTE (honesty, confirmed
      // by direct instrumentation during development of this test, matching
      // the prior finding on staffDirectory.ts's PATCH): this shared
      // Postgres pool consistently serializes interactive transactions on
      // this route too — a `Promise.all` of two `fetch`es did NOT reliably
      // race in 5/5 manual runs; the second request's own `findFirst`
      // fast-path guard always ran after the first had already committed,
      // so this test alone does NOT prove the P2002 backstop fires under
      // real HTTP concurrency in this environment. Kept anyway because it's
      // a legitimate, valid outcome and confirms the ordinary path still
      // behaves correctly end-to-end. The actual proof that the DB-level
      // constraint itself works is the next test below (direct-mechanism,
      // not HTTP-level).
      //
      // Exactly [201, 409] is the ONLY correct outcome, not one option among
      // several — with the migration actually working, the DB can commit at
      // most one open-log insert per user, so two genuine concurrent
      // clock-ins can never both return 201 (an earlier draft of this
      // assertion allowed `[201, 201]` as a hypothetical alternative, which
      // a review pass correctly called out as dead/self-defeating: if that
      // branch ever fired, the `openLogs.length === 1` assertion below would
      // independently fail anyway, so allowing it here just weakened what
      // this test actually proves).
      const [a, b] = await Promise.all([clockIn(), clockIn()]);
      const statuses = [a.status, b.status].sort();
      assert.deepEqual(statuses, [201, 409], `expected exactly one success and one clean conflict — got ${JSON.stringify(statuses)}`);

      const openLogs = await prisma.attendanceLog.findMany({ where: { userId: staff.id, clockOutAt: null } });
      assert.equal(openLogs.length, 1, 'exactly one open AttendanceLog must exist after the race, never two, never zero');
    });
  } finally {
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});

// Direct-mechanism proof, independent of whether HTTP-level concurrency
// actually materializes in this environment: two `tx.attendanceLog.create`
// calls issued back-to-back under the SAME "no open log" precondition (i.e.
// simulating what two concurrent transactions would each see after passing
// the app-level `findFirst` guard) — the DB's partial unique index must
// reject the second with Prisma's P2002 unique-violation code.
test('DB-level partial unique index rejects a second open AttendanceLog for the same user with P2002', async () => {
  const { location, staff } = await createTestStaff('P2002 mechanism proof');

  try {
    // First open log — the "no open log" precondition was true when both
    // hypothetical concurrent transactions checked it; this is the one that
    // wins.
    const first = await prisma.attendanceLog.create({
      data: { userId: staff.id, shiftId: null, clockInAt: new Date(), source: 'manual' },
    });
    assert.ok(first.id);

    // Second create — simulates the losing concurrent transaction, which
    // also saw "no open log" before either committed. Must be rejected by
    // the unique index itself, not by application logic.
    await assert.rejects(
      () => prisma.attendanceLog.create({ data: { userId: staff.id, shiftId: null, clockInAt: new Date(), source: 'manual' } }),
      (err: unknown) => {
        assert.ok(err instanceof Prisma.PrismaClientKnownRequestError, 'expected a Prisma known-request error');
        assert.equal((err as Prisma.PrismaClientKnownRequestError).code, 'P2002', 'expected the unique-violation code');
        // The route's own catch pins down `meta.target` to exactly ["user_id"]
        // before treating a P2002 as "already clocked in" (so an unrelated
        // future unique-constraint violation doesn't get silently
        // misreported as this one) — verified here against the real error
        // Postgres/Prisma actually produces for this specific raw index.
        assert.deepEqual((err as Prisma.PrismaClientKnownRequestError).meta?.target, ['user_id'], 'expected meta.target to name exactly the userId column, matching what the route\'s own catch checks for');
        return true;
      },
    );

    const openLogs = await prisma.attendanceLog.findMany({ where: { userId: staff.id, clockOutAt: null } });
    assert.equal(openLogs.length, 1, 'the rejected create must not have persisted a second open row');
    assert.equal(openLogs[0]!.id, first.id);
  } finally {
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});
