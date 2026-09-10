import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
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

test('POST /api/voice/execute: a STAFF session cannot APPROVE_SWAP even with a hand-crafted intent — 403, and nothing in the DB moves', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  const role = await prisma.role.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && role, 'seed data (location + role) must exist to run this test');

  const requester = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task6-test__ requester', systemRole: 'STAFF' },
  });
  const target = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task6-test__ target', systemRole: 'STAFF' },
  });
  const staffCaller = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task6-test__ staff caller', systemRole: 'STAFF' },
  });

  const shift = await prisma.shift.create({
    data: {
      locationId: location!.id,
      roleId: role!.id,
      userId: requester.id,
      date: new Date('2026-09-01T00:00:00.000Z'),
      startTime: new Date('2026-09-01T09:00:00.000Z'),
      endTime: new Date('2026-09-01T17:00:00.000Z'),
      status: 'PUBLISHED',
    },
  });
  const swapRequest = await prisma.shiftSwapRequest.create({
    data: {
      shiftId: shift.id,
      requestedById: requester.id,
      targetUserId: target.id,
      type: 'COVER',
      status: 'PENDING',
      expiresAt: new Date('2026-12-31T00:00:00.000Z'),
    },
  });

  try {
    const token = await sessionFor(staffCaller.id);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          transcript: 'approve the swap request',
          intent: { intent: 'APPROVE_SWAP', swapRequestId: swapRequest.id, summary: 'Approve the pending swap.' },
        }),
      });
      assert.equal(res.status, 403, 'STAFF must not be able to execute a manager-only intent');
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /does not permit/i);
    });

    // The 403 must be a real gate, not just a response code with the
    // mutation happening underneath: confirm via a fresh DB query.
    const unchangedRequest = await prisma.shiftSwapRequest.findUnique({ where: { id: swapRequest.id } });
    assert.equal(unchangedRequest!.status, 'PENDING', 'the swap request must not have been decided');
    assert.equal(unchangedRequest!.reviewedById, null);

    const unchangedShift = await prisma.shift.findUnique({ where: { id: shift.id } });
    assert.equal(unchangedShift!.userId, requester.id, 'the shift must not have been reassigned');

    const auditRows = await prisma.auditLog.findMany({ where: { entityType: 'ShiftSwapRequest', entityId: swapRequest.id } });
    assert.equal(auditRows.length, 0, 'no AuditLog row may exist for a request that was never actually decided');
  } finally {
    await prisma.auditLog.deleteMany({ where: { entityType: 'ShiftSwapRequest', entityId: swapRequest.id } });
    await prisma.shiftSwapRequest.delete({ where: { id: swapRequest.id } }).catch(() => {});
    await prisma.shift.delete({ where: { id: shift.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: staffCaller.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: target.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: requester.id } }).catch(() => {});
  }
});

test('POST /api/voice/execute: a MANAGER session executing APPROVE_SWAP reassigns the shift and writes a real [voice] AuditLog row', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  const role = await prisma.role.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && role, 'seed data (location + role) must exist to run this test');

  const requester = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task6-test__ requester2', systemRole: 'STAFF' },
  });
  const target = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task6-test__ target2', systemRole: 'STAFF' },
  });
  const manager = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task6-test__ manager', systemRole: 'MANAGER' },
  });

  const shift = await prisma.shift.create({
    data: {
      locationId: location!.id,
      roleId: role!.id,
      userId: requester.id,
      date: new Date('2026-09-02T00:00:00.000Z'),
      startTime: new Date('2026-09-02T09:00:00.000Z'),
      endTime: new Date('2026-09-02T17:00:00.000Z'),
      status: 'PUBLISHED',
    },
  });
  const swapRequest = await prisma.shiftSwapRequest.create({
    data: {
      shiftId: shift.id,
      requestedById: requester.id,
      targetUserId: target.id,
      type: 'COVER',
      status: 'PENDING',
      expiresAt: new Date('2026-12-31T00:00:00.000Z'),
    },
  });

  const transcript = 'approve the cover swap for __task6-test__';

  try {
    const token = await sessionFor(manager.id);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          transcript,
          intent: { intent: 'APPROVE_SWAP', swapRequestId: swapRequest.id, summary: 'Approve the pending swap.' },
        }),
      });
      assert.equal(res.status, 200, 'MANAGER must be able to execute APPROVE_SWAP');
      const body = (await res.json()) as { executed: boolean };
      assert.equal(body.executed, true);
    });

    const reassignedShift = await prisma.shift.findUnique({ where: { id: shift.id } });
    assert.equal(reassignedShift!.userId, target.id, 'the shift must actually be reassigned to the target user');

    const decidedRequest = await prisma.shiftSwapRequest.findUnique({ where: { id: swapRequest.id } });
    assert.equal(decidedRequest!.status, 'APPROVED');

    const voiceAuditRow = await prisma.auditLog.findFirst({
      where: { entityType: 'ShiftSwapRequest', entityId: swapRequest.id, action: 'SWAP_APPROVED', note: { contains: '[voice]' } },
    });
    assert.ok(voiceAuditRow, 'a real AuditLog row with action SWAP_APPROVED and a [voice] note must exist');
    assert.match(voiceAuditRow!.note ?? '', /\[voice\]/);
    assert.ok(voiceAuditRow!.note!.includes(transcript), 'the AuditLog note must contain the transcript text');
    assert.equal(voiceAuditRow!.actorId, manager.id);
    // Fix #4: the voice audit row must carry the entity's own shiftId and
    // locationId, not null / the caller's locationId.
    assert.equal(voiceAuditRow!.shiftId, shift.id, "the voice audit row must carry the entity's own shiftId, not null");
    assert.equal(voiceAuditRow!.locationId, location!.id, "the voice audit row must carry the entity's own locationId");
  } finally {
    await prisma.auditLog.deleteMany({ where: { entityType: 'ShiftSwapRequest', entityId: swapRequest.id } });
    await prisma.shiftSwapRequest.delete({ where: { id: swapRequest.id } }).catch(() => {});
    await prisma.shift.delete({ where: { id: shift.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: target.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: requester.id } }).catch(() => {});
  }
});

test('POST /api/voice/execute: MARK_AVAILABILITY from a STAFF session creates a real AvailabilityMark scoped to that session and a real AuditLog row', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');

  const staffCaller = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task6-test__ availability staff', systemRole: 'STAFF' },
  });

  const markDate = '2026-09-15';
  const transcript = "I can't work on September 15th";

  try {
    const token = await sessionFor(staffCaller.id);

    let markId = '';
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          transcript,
          intent: { intent: 'MARK_AVAILABILITY', date: markDate, type: 'UNAVAILABLE', summary: 'Mark unavailable on Sept 15.' },
        }),
      });
      assert.equal(res.status, 200, 'STAFF must be able to execute their own MARK_AVAILABILITY');
      const body = (await res.json()) as { executed: boolean; result: { id: string } };
      assert.equal(body.executed, true);
      markId = body.result.id;
    });

    assert.ok(markId, 'the response must carry the created mark id');
    const mark = await prisma.availabilityMark.findUnique({ where: { id: markId } });
    assert.ok(mark, 'a real AvailabilityMark row must exist');
    assert.equal(mark!.userId, staffCaller.id, 'the mark must be scoped to the calling session, not an arbitrary user');
    assert.equal(mark!.type, 'UNAVAILABLE');
    assert.equal(mark!.date.toISOString().slice(0, 10), markDate);

    const auditRow = await prisma.auditLog.findFirst({
      where: { entityType: 'AvailabilityMark', entityId: markId, action: 'AVAILABILITY_MARKED' },
    });
    assert.ok(auditRow, 'a real AuditLog row with action AVAILABILITY_MARKED must exist');
    assert.equal(auditRow!.actorId, staffCaller.id);
    assert.match(auditRow!.note ?? '', /\[voice\]/);
    assert.ok(auditRow!.note!.includes(transcript));
  } finally {
    await prisma.auditLog.deleteMany({ where: { entityType: 'AvailabilityMark', actorId: staffCaller.id } });
    await prisma.availabilityMark.deleteMany({ where: { userId: staffCaller.id } });
    await prisma.user.delete({ where: { id: staffCaller.id } }).catch(() => {});
  }
});

test('POST /api/voice/execute: a STAFF session gets 400 (not 403) for an UNRECOGNIZED intent', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');

  const staffCaller = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task6-test__ unrecognized staff', systemRole: 'STAFF' },
  });

  try {
    const token = await sessionFor(staffCaller.id);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          transcript: 'do something weird',
          intent: { intent: 'UNRECOGNIZED', reason: 'not sure what this means', summary: 'Could not determine what to do.' },
        }),
      });
      // Must be the dedicated 400 branch, not the 403 permission-check branch —
      // this is the exact bug the task-6 brief's correction #1 fixes:
      // allowedIntentsFor() never includes 'UNRECOGNIZED' in either role's
      // array, so without the exemption this would incorrectly 403 instead.
      assert.equal(res.status, 400, 'UNRECOGNIZED must reach its own 400 branch, not the role-permission 403');
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /not recognized/i);
      assert.doesNotMatch(body.error, /does not permit/i);
    });
  } finally {
    await prisma.user.delete({ where: { id: staffCaller.id } }).catch(() => {});
  }
});

test('POST /api/voice/execute: REQUEST_SWAP from a STAFF session creates a real ShiftSwapRequest for their own shift, with a [voice] AuditLog row', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  const role = await prisma.role.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && role, 'seed data (location + role) must exist to run this test');

  const requester = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task6-test__ request-swap requester', systemRole: 'STAFF' },
  });
  const target = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task6-test__ request-swap target', systemRole: 'STAFF' },
  });
  const shift = await prisma.shift.create({
    data: {
      locationId: location!.id,
      roleId: role!.id,
      userId: requester.id,
      date: new Date('2026-09-03T00:00:00.000Z'),
      startTime: new Date('2026-09-03T09:00:00.000Z'),
      endTime: new Date('2026-09-03T17:00:00.000Z'),
      status: 'PUBLISHED',
    },
  });

  const transcript = 'ask __task6-test__ target to cover my Thursday shift';
  let createdId = '';

  try {
    const token = await sessionFor(requester.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          transcript,
          intent: {
            intent: 'REQUEST_SWAP',
            shiftId: shift.id,
            targetUserId: target.id,
            targetUserName: target.fullName,
            reason: null,
            summary: 'Request a cover swap.',
          },
        }),
      });
      assert.equal(res.status, 201, 'STAFF must be able to request a swap for their own shift');
      const body = (await res.json()) as { executed: boolean; result: { id: string } };
      assert.equal(body.executed, true);
      createdId = body.result.id;
    });

    const created = await prisma.shiftSwapRequest.findUnique({ where: { id: createdId } });
    assert.ok(created, 'a real ShiftSwapRequest row must exist');
    assert.equal(created!.status, 'PENDING');
    assert.equal(created!.requestedById, requester.id);
    assert.equal(created!.targetUserId, target.id);

    const auditRow = await prisma.auditLog.findFirst({
      where: { entityType: 'ShiftSwapRequest', entityId: createdId, action: 'SWAP_REQUESTED' },
    });
    assert.ok(auditRow, 'a real AuditLog row with action SWAP_REQUESTED must exist');
    assert.match(auditRow!.note ?? '', /\[voice\]/);
  } finally {
    await prisma.auditLog.deleteMany({ where: { entityType: 'ShiftSwapRequest', entityId: createdId } });
    await prisma.shiftSwapRequest.delete({ where: { id: createdId } }).catch(() => {});
    await prisma.shift.delete({ where: { id: shift.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: target.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: requester.id } }).catch(() => {});
  }
});

test('POST /api/voice/execute: DECLINE_SWAP from a MANAGER session declines a real pending request without reassigning the shift', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  const role = await prisma.role.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && role, 'seed data (location + role) must exist to run this test');

  const requester = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task6-test__ decline-swap requester', systemRole: 'STAFF' },
  });
  const target = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task6-test__ decline-swap target', systemRole: 'STAFF' },
  });
  const manager = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task6-test__ decline-swap manager', systemRole: 'MANAGER' },
  });
  const shift = await prisma.shift.create({
    data: {
      locationId: location!.id,
      roleId: role!.id,
      userId: requester.id,
      date: new Date('2026-09-04T00:00:00.000Z'),
      startTime: new Date('2026-09-04T09:00:00.000Z'),
      endTime: new Date('2026-09-04T17:00:00.000Z'),
      status: 'PUBLISHED',
    },
  });
  const swapRequest = await prisma.shiftSwapRequest.create({
    data: {
      shiftId: shift.id,
      requestedById: requester.id,
      targetUserId: target.id,
      type: 'COVER',
      status: 'PENDING',
      expiresAt: new Date('2026-12-31T00:00:00.000Z'),
    },
  });

  try {
    const token = await sessionFor(manager.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          transcript: 'decline that swap request',
          intent: { intent: 'DECLINE_SWAP', swapRequestId: swapRequest.id, summary: 'Decline the pending swap.' },
        }),
      });
      assert.equal(res.status, 200);
    });

    const decidedRequest = await prisma.shiftSwapRequest.findUnique({ where: { id: swapRequest.id } });
    assert.equal(decidedRequest!.status, 'DECLINED');

    const unchangedShift = await prisma.shift.findUnique({ where: { id: shift.id } });
    assert.equal(unchangedShift!.userId, requester.id, 'a declined swap must never reassign the shift');

    const auditRow = await prisma.auditLog.findFirst({
      where: { entityType: 'ShiftSwapRequest', entityId: swapRequest.id, action: 'SWAP_DECLINED', note: { contains: '[voice]' } },
    });
    assert.ok(auditRow, 'a real AuditLog row with action SWAP_DECLINED and a [voice] note must exist');
    // Fix #4: shiftId/locationId must come from the entity, not be null/the caller's.
    assert.equal(auditRow!.shiftId, shift.id);
    assert.equal(auditRow!.locationId, location!.id);
  } finally {
    await prisma.auditLog.deleteMany({ where: { entityType: 'ShiftSwapRequest', entityId: swapRequest.id } });
    await prisma.shiftSwapRequest.delete({ where: { id: swapRequest.id } }).catch(() => {});
    await prisma.shift.delete({ where: { id: shift.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: target.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: requester.id } }).catch(() => {});
  }
});

test('POST /api/voice/execute: APPROVE_SWAP on an already-DECLINED swap request gets a real 409 and changes nothing', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  const role = await prisma.role.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && role, 'seed data (location + role) must exist to run this test');

  const requester = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task6-test__ already-decided requester', systemRole: 'STAFF' },
  });
  const target = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task6-test__ already-decided target', systemRole: 'STAFF' },
  });
  const manager = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task6-test__ already-decided manager', systemRole: 'MANAGER' },
  });
  const shift = await prisma.shift.create({
    data: {
      locationId: location!.id,
      roleId: role!.id,
      userId: requester.id,
      date: new Date('2026-09-08T00:00:00.000Z'),
      startTime: new Date('2026-09-08T09:00:00.000Z'),
      endTime: new Date('2026-09-08T17:00:00.000Z'),
      status: 'PUBLISHED',
    },
  });
  // Already decided — DECLINED, and (as a declined request must) the shift was
  // never reassigned. decideSwapRequest's own 'conflict' result does NOT cover
  // this case (isRequestLocked returns false for any non-PENDING request), so
  // without the route's explicit status guard voice could flip this to
  // APPROVED and reassign the shift out from under the earlier decision.
  const swapRequest = await prisma.shiftSwapRequest.create({
    data: {
      shiftId: shift.id,
      requestedById: requester.id,
      targetUserId: target.id,
      type: 'COVER',
      status: 'DECLINED',
      reviewedById: manager.id,
      expiresAt: new Date('2026-12-31T00:00:00.000Z'),
    },
  });

  try {
    const token = await sessionFor(manager.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          transcript: 'actually approve that swap after all',
          intent: { intent: 'APPROVE_SWAP', swapRequestId: swapRequest.id, summary: 'Approve the swap.' },
        }),
      });
      assert.equal(res.status, 409, 'an already-decided swap request must not be re-decided by voice');
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /already declined/i, 'the 409 copy must name the real, accurate reason');
    });

    const unchanged = await prisma.shiftSwapRequest.findUnique({ where: { id: swapRequest.id } });
    assert.equal(unchanged!.status, 'DECLINED', 'the request must still be DECLINED — voice must not flip an existing decision');
    const unchangedShift = await prisma.shift.findUnique({ where: { id: shift.id } });
    assert.equal(unchangedShift!.userId, requester.id, 'the shift must not have been reassigned');
    const auditRows = await prisma.auditLog.findMany({ where: { entityType: 'ShiftSwapRequest', entityId: swapRequest.id } });
    assert.equal(auditRows.length, 0, 'no AuditLog row may exist for a re-decision that was rejected');
  } finally {
    await prisma.auditLog.deleteMany({ where: { entityType: 'ShiftSwapRequest', entityId: swapRequest.id } });
    await prisma.shiftSwapRequest.delete({ where: { id: swapRequest.id } }).catch(() => {});
    await prisma.shift.delete({ where: { id: shift.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: target.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: requester.id } }).catch(() => {});
  }
});

test('POST /api/voice/execute: APPROVE_JOIN from a MANAGER session creates a real User from the join request', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');

  const manager = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task6-test__ approve-join manager', systemRole: 'MANAGER' },
  });
  const joinRequest = await prisma.joinRequest.create({
    data: { locationId: location!.id, phone: '0501112222', fullName: '__task6-test__ new hire', status: 'PENDING' },
  });

  let createdUserId: string | null = null;

  try {
    const token = await sessionFor(manager.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          transcript: 'approve the join request for the new hire',
          intent: { intent: 'APPROVE_JOIN', joinRequestId: joinRequest.id, summary: 'Approve the join request.' },
        }),
      });
      assert.equal(res.status, 200);
      // Fix #6: response shape must be flat — { executed, result: { status, userId } }
      // — matching every sibling branch (result.mark, result.request, created),
      // not a nested action-function envelope like {"result":{"result":"ok",...}}.
      const body = (await res.json()) as { executed: boolean; result: { status: string; userId: string; result?: unknown } };
      assert.equal(body.result.status, 'APPROVED');
      assert.ok(body.result.userId, 'response must carry the created userId directly on result');
      assert.equal(body.result.result, undefined, 'response must not double-nest the action-function envelope');
    });

    const decided = await prisma.joinRequest.findUnique({ where: { id: joinRequest.id } });
    assert.equal(decided!.status, 'APPROVED');
    assert.ok(decided!.createdUserId, 'approving must create and link a real User');
    createdUserId = decided!.createdUserId;

    const newUser = await prisma.user.findUnique({ where: { id: createdUserId! } });
    assert.ok(newUser, 'the linked User must actually exist');
    assert.equal(newUser!.fullName, '__task6-test__ new hire');

    const auditRow = await prisma.auditLog.findFirst({
      where: { entityType: 'JoinRequest', entityId: joinRequest.id, action: 'JOIN_APPROVED', note: { contains: '[voice]' } },
    });
    assert.ok(auditRow, 'a real AuditLog row with action JOIN_APPROVED and a [voice] note must exist');
  } finally {
    await prisma.auditLog.deleteMany({ where: { entityType: 'JoinRequest', entityId: joinRequest.id } });
    await prisma.joinRequest.delete({ where: { id: joinRequest.id } }).catch(() => {});
    if (createdUserId) await prisma.user.delete({ where: { id: createdUserId } }).catch(() => {});
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
  }
});

test('POST /api/voice/execute: DECLINE_JOIN from a MANAGER session declines without creating a User', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');

  const manager = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task6-test__ decline-join manager', systemRole: 'MANAGER' },
  });
  const joinRequest = await prisma.joinRequest.create({
    data: { locationId: location!.id, phone: '0503334444', fullName: '__task6-test__ rejected hire', status: 'PENDING' },
  });

  try {
    const token = await sessionFor(manager.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          transcript: 'decline that join request',
          intent: { intent: 'DECLINE_JOIN', joinRequestId: joinRequest.id, summary: 'Decline the join request.' },
        }),
      });
      assert.equal(res.status, 200);
    });

    const decided = await prisma.joinRequest.findUnique({ where: { id: joinRequest.id } });
    assert.equal(decided!.status, 'DECLINED');
    assert.equal(decided!.createdUserId, null, 'declining must never create a User');

    const auditRow = await prisma.auditLog.findFirst({
      where: { entityType: 'JoinRequest', entityId: joinRequest.id, action: 'JOIN_DECLINED', note: { contains: '[voice]' } },
    });
    assert.ok(auditRow, 'a real AuditLog row with action JOIN_DECLINED and a [voice] note must exist');
  } finally {
    await prisma.auditLog.deleteMany({ where: { entityType: 'JoinRequest', entityId: joinRequest.id } });
    await prisma.joinRequest.delete({ where: { id: joinRequest.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
  }
});

test('POST /api/voice/execute: APPROVE_SWAP rejects a swap request that belongs to a different location — 404, nothing changes', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  const role = await prisma.role.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && role, 'seed data (location + role) must exist to run this test');

  const otherLocation = await prisma.location.create({
    data: { organizationId: location!.organizationId, name: '__task6-test__ other venue (cross-loc swap)', timezone: 'Asia/Dubai' },
  });
  const otherRole = await prisma.role.create({ data: { locationId: otherLocation.id, name: '__task6-test__ cross-loc role' } });

  const manager = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task6-test__ cross-loc manager (own location)', systemRole: 'MANAGER' },
  });
  const requester = await prisma.user.create({
    data: { locationId: otherLocation.id, fullName: '__task6-test__ cross-loc requester (other location)', systemRole: 'STAFF' },
  });
  const target = await prisma.user.create({
    data: { locationId: otherLocation.id, fullName: '__task6-test__ cross-loc target (other location)', systemRole: 'STAFF' },
  });
  const shift = await prisma.shift.create({
    data: {
      locationId: otherLocation.id,
      roleId: otherRole.id,
      userId: requester.id,
      date: new Date('2026-09-05T00:00:00.000Z'),
      startTime: new Date('2026-09-05T09:00:00.000Z'),
      endTime: new Date('2026-09-05T17:00:00.000Z'),
      status: 'PUBLISHED',
    },
  });
  const swapRequest = await prisma.shiftSwapRequest.create({
    data: {
      shiftId: shift.id,
      requestedById: requester.id,
      targetUserId: target.id,
      type: 'COVER',
      status: 'PENDING',
      expiresAt: new Date('2026-12-31T00:00:00.000Z'),
    },
  });

  try {
    const token = await sessionFor(manager.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          transcript: 'approve that swap',
          intent: { intent: 'APPROVE_SWAP', swapRequestId: swapRequest.id, summary: 'Approve.' },
        }),
      });
      assert.equal(res.status, 404, 'a manager must not be able to decide a swap request from a different location');
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /could not be found/i);
    });

    const unchanged = await prisma.shiftSwapRequest.findUnique({ where: { id: swapRequest.id } });
    assert.equal(unchanged!.status, 'PENDING', 'cross-location swap request must not have been decided');
    const unchangedShift = await prisma.shift.findUnique({ where: { id: shift.id } });
    assert.equal(unchangedShift!.userId, requester.id, 'cross-location shift must not have been reassigned');
    const auditRows = await prisma.auditLog.findMany({ where: { entityType: 'ShiftSwapRequest', entityId: swapRequest.id } });
    assert.equal(auditRows.length, 0, 'no AuditLog row may exist for a cross-location request that was rejected');
  } finally {
    await prisma.auditLog.deleteMany({ where: { entityType: 'ShiftSwapRequest', entityId: swapRequest.id } });
    await prisma.shiftSwapRequest.delete({ where: { id: swapRequest.id } }).catch(() => {});
    await prisma.shift.delete({ where: { id: shift.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: target.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: requester.id } }).catch(() => {});
    await prisma.role.delete({ where: { id: otherRole.id } }).catch(() => {});
    await prisma.location.delete({ where: { id: otherLocation.id } }).catch(() => {});
  }
});

test('POST /api/voice/execute: APPROVE_JOIN rejects a join request that belongs to a different location — 404, nothing changes', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');

  const otherLocation = await prisma.location.create({
    data: { organizationId: location!.organizationId, name: '__task6-test__ other venue (cross-loc join)', timezone: 'Asia/Dubai' },
  });

  const manager = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task6-test__ cross-loc join manager (own location)', systemRole: 'MANAGER' },
  });
  const joinRequest = await prisma.joinRequest.create({
    data: { locationId: otherLocation.id, phone: '0509998888', fullName: '__task6-test__ cross-loc new hire', status: 'PENDING' },
  });

  try {
    const token = await sessionFor(manager.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          transcript: 'approve that join request',
          intent: { intent: 'APPROVE_JOIN', joinRequestId: joinRequest.id, summary: 'Approve.' },
        }),
      });
      assert.equal(res.status, 404, 'a manager must not be able to decide a join request from a different location');
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /could not be found/i);
    });

    const unchanged = await prisma.joinRequest.findUnique({ where: { id: joinRequest.id } });
    assert.equal(unchanged!.status, 'PENDING', 'cross-location join request must not have been decided');
    assert.equal(unchanged!.createdUserId, null, 'no User must be created from a rejected cross-location join request');
    const auditRows = await prisma.auditLog.findMany({ where: { entityType: 'JoinRequest', entityId: joinRequest.id } });
    assert.equal(auditRows.length, 0, 'no AuditLog row may exist for a cross-location join request that was rejected');
  } finally {
    await prisma.auditLog.deleteMany({ where: { entityType: 'JoinRequest', entityId: joinRequest.id } });
    await prisma.joinRequest.delete({ where: { id: joinRequest.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
    await prisma.location.delete({ where: { id: otherLocation.id } }).catch(() => {});
  }
});

test('POST /api/voice/execute: REQUEST_SWAP rejects a targetUserId from a different location — 404, no request created', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  const role = await prisma.role.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && role, 'seed data (location + role) must exist to run this test');

  const otherLocation = await prisma.location.create({
    data: { organizationId: location!.organizationId, name: '__task6-test__ other venue (cross-loc target)', timezone: 'Asia/Dubai' },
  });

  const requester = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task6-test__ cross-loc-target requester', systemRole: 'STAFF' },
  });
  const outOfLocationTarget = await prisma.user.create({
    data: { locationId: otherLocation.id, fullName: '__task6-test__ cross-loc-target target (other location)', systemRole: 'STAFF' },
  });
  const shift = await prisma.shift.create({
    data: {
      locationId: location!.id,
      roleId: role!.id,
      userId: requester.id,
      date: new Date('2026-09-06T00:00:00.000Z'),
      startTime: new Date('2026-09-06T09:00:00.000Z'),
      endTime: new Date('2026-09-06T17:00:00.000Z'),
      status: 'PUBLISHED',
    },
  });

  try {
    const token = await sessionFor(requester.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          transcript: 'ask someone from another venue to cover',
          intent: {
            intent: 'REQUEST_SWAP',
            shiftId: shift.id,
            targetUserId: outOfLocationTarget.id,
            targetUserName: outOfLocationTarget.fullName,
            reason: null,
            summary: 'Request a cover swap.',
          },
        }),
      });
      assert.equal(res.status, 404, 'a targetUserId from a different location must be rejected');
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /could not be found/i);
    });

    const leaked = await prisma.shiftSwapRequest.findMany({ where: { shiftId: shift.id } });
    assert.equal(leaked.length, 0, 'no ShiftSwapRequest may be created against a cross-location targetUserId');
  } finally {
    await prisma.shiftSwapRequest.deleteMany({ where: { shiftId: shift.id } });
    await prisma.shift.delete({ where: { id: shift.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: requester.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: outOfLocationTarget.id } }).catch(() => {});
    await prisma.location.delete({ where: { id: otherLocation.id } }).catch(() => {});
  }
});

test('POST /api/voice/execute: REQUEST_SWAP rejects a nonexistent targetUserId — 404, no request created (and no bare 500)', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  const role = await prisma.role.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && role, 'seed data (location + role) must exist to run this test');

  const requester = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task6-test__ nonexistent-target requester', systemRole: 'STAFF' },
  });
  const shift = await prisma.shift.create({
    data: {
      locationId: location!.id,
      roleId: role!.id,
      userId: requester.id,
      date: new Date('2026-09-07T00:00:00.000Z'),
      startTime: new Date('2026-09-07T09:00:00.000Z'),
      endTime: new Date('2026-09-07T17:00:00.000Z'),
      status: 'PUBLISHED',
    },
  });

  try {
    const token = await sessionFor(requester.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          transcript: 'ask a made-up person to cover',
          intent: {
            intent: 'REQUEST_SWAP',
            shiftId: shift.id,
            targetUserId: 'not-a-real-user-id',
            targetUserName: 'Nobody',
            reason: null,
            summary: 'Request a cover swap.',
          },
        }),
      });
      assert.equal(res.status, 404, 'a nonexistent targetUserId must be a clean 404, not a bare FK-violation 500');
    });

    const leaked = await prisma.shiftSwapRequest.findMany({ where: { shiftId: shift.id } });
    assert.equal(leaked.length, 0, 'no ShiftSwapRequest may be created against a nonexistent targetUserId');
  } finally {
    await prisma.shiftSwapRequest.deleteMany({ where: { shiftId: shift.id } });
    await prisma.shift.delete({ where: { id: shift.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: requester.id } }).catch(() => {});
  }
});

test('POST /api/voice/execute: MARK_AVAILABILITY with a malformed date gets a real 400, no row created', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');

  const staffCaller = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task6-test__ malformed-date staff', systemRole: 'STAFF' },
  });

  try {
    const token = await sessionFor(staffCaller.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          transcript: 'mark me unavailable sometime',
          intent: { intent: 'MARK_AVAILABILITY', date: 'not-a-real-date', type: 'UNAVAILABLE', summary: 'x' },
        }),
      });
      assert.equal(res.status, 400, 'a malformed date must be rejected before any Prisma call, not raw-500 or silently coerced');
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /date/i);
    });

    const marks = await prisma.availabilityMark.findMany({ where: { userId: staffCaller.id } });
    assert.equal(marks.length, 0, 'no AvailabilityMark may be created from a malformed date');
  } finally {
    await prisma.availabilityMark.deleteMany({ where: { userId: staffCaller.id } });
    await prisma.user.delete({ where: { id: staffCaller.id } }).catch(() => {});
  }
});

test('POST /api/voice/execute: MARK_AVAILABILITY rejects a calendar-invalid date that silently rolls over (2026-02-30) — 400, no row created for either day', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');

  const staffCaller = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task6-test__ rollover-date staff', systemRole: 'STAFF' },
  });

  try {
    const token = await sessionFor(staffCaller.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          transcript: "mark me unavailable Feb 30th",
          // 2026-02-30 does not exist. JS's `new Date(...)` silently rolls
          // this over to 2026-03-02 instead of rejecting it — without the
          // round-trip check, this would 200 and create a mark on the WRONG
          // day with zero error, a real correctness/compliance defect.
          intent: { intent: 'MARK_AVAILABILITY', date: '2026-02-30', type: 'UNAVAILABLE', summary: 'x' },
        }),
      });
      assert.equal(res.status, 400, 'a calendar-invalid date that silently rolls over must be rejected, not accepted for the wrong day');
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /calendar date/i);
    });

    const marksOnRolledOverDay = await prisma.availabilityMark.findMany({
      where: { userId: staffCaller.id, date: new Date('2026-03-02T00:00:00.000Z') },
    });
    assert.equal(marksOnRolledOverDay.length, 0, 'no mark may be silently created on the rolled-over day (March 2nd) either');
    const allMarks = await prisma.availabilityMark.findMany({ where: { userId: staffCaller.id } });
    assert.equal(allMarks.length, 0, 'no AvailabilityMark of any date may exist for this user');
  } finally {
    await prisma.availabilityMark.deleteMany({ where: { userId: staffCaller.id } });
    await prisma.user.delete({ where: { id: staffCaller.id } }).catch(() => {});
  }
});

test('POST /api/voice/execute: MARK_AVAILABILITY rejects shape-valid-but-out-of-range dates (9999-99-99, 0000-00-00) — 400, not a bare 500', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');

  const staffCaller = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task6-test__ garbage-calendar-date staff', systemRole: 'STAFF' },
  });

  try {
    const token = await sessionFor(staffCaller.id);

    for (const badDate of ['9999-99-99', '0000-00-00']) {
      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/voice/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            transcript: 'mark me unavailable',
            intent: { intent: 'MARK_AVAILABILITY', date: badDate, type: 'UNAVAILABLE', summary: 'x' },
          }),
        });
        assert.equal(res.status, 400, `"${badDate}" matches the YYYY-MM-DD shape regex but is not a real calendar date — must 400, not crash`);
        const body = (await res.json()) as { error: string };
        assert.match(body.error, /calendar date/i);
      });
    }

    const marks = await prisma.availabilityMark.findMany({ where: { userId: staffCaller.id } });
    assert.equal(marks.length, 0, 'no AvailabilityMark may be created from either out-of-range date');
  } finally {
    await prisma.availabilityMark.deleteMany({ where: { userId: staffCaller.id } });
    await prisma.user.delete({ where: { id: staffCaller.id } }).catch(() => {});
  }
});

test('POST /api/voice/execute: APPROVE_SWAP with a missing swapRequestId gets a real 400', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');

  const manager = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task6-test__ malformed-shape manager', systemRole: 'MANAGER' },
  });

  try {
    const token = await sessionFor(manager.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        // swapRequestId deliberately omitted — a malformed client body, not a real parsed intent.
        body: JSON.stringify({ transcript: 'approve it', intent: { intent: 'APPROVE_SWAP', summary: 'x' } }),
      });
      assert.equal(res.status, 400, 'a missing swapRequestId must 400 before any Prisma call');
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /swapRequestId/i);
    });
  } finally {
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
  }
});

test('POST /api/voice/execute: an unknown/garbage intent string gets a real 400, not a misleading 403', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');

  const manager = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task6-test__ garbage-intent manager', systemRole: 'MANAGER' },
  });

  try {
    // Even a MANAGER session (which would pass an allowedIntentsFor() check
    // for any REAL manager intent) must still get 400 for a string that
    // isn't a real intent at all — proves the ordering fix, not just that
    // the role check happens to also reject it.
    const token = await sessionFor(manager.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ transcript: 'x', intent: { intent: 'DELETE_EVERYTHING', summary: 'x' } }),
      });
      assert.equal(res.status, 400, 'a garbage intent string must 400, not fall through to the role-permission 403');
      const body = (await res.json()) as { error: string };
      assert.doesNotMatch(body.error, /does not permit/i, 'must not be misreported as a permission error');
    });
  } finally {
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
  }
});

test('POST /api/voice/execute: requires a real session (401 without a bearer token)', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/voice/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: 'x', intent: { intent: 'MARK_AVAILABILITY', date: '2026-09-15', type: 'UNAVAILABLE', summary: 'x' } }),
    });
    assert.equal(res.status, 401);
  });
});

test('POST /api/voice/execute: CREATE_SHIFT from a MANAGER session creates a real Shift with a [voice] AuditLog row', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  const role = await prisma.role.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && role, 'seed data (location + role) must exist to run this test');

  const manager = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task13-test__ create-shift manager', systemRole: 'MANAGER' },
  });

  let createdShiftId = '';
  try {
    const token = await sessionFor(manager.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          transcript: 'create a shift tomorrow 9 to 5',
          intent: { intent: 'CREATE_SHIFT', roleId: role!.id, date: '2026-09-22', start: '09:00', end: '17:00', userId: null, confidence: 0.9, summary: 'Create an open shift, Sept 22nd, 9am-5pm.' },
        }),
      });
      assert.equal(res.status, 201, 'MANAGER must be able to execute CREATE_SHIFT');
      const body = (await res.json()) as { executed: boolean; result: { id: string } };
      assert.equal(body.executed, true);
      createdShiftId = body.result.id;
    });

    const shift = await prisma.shift.findUnique({ where: { id: createdShiftId } });
    assert.ok(shift, 'a real Shift row must exist');
    assert.equal(shift!.roleId, role!.id);
    assert.equal(shift!.userId, null);

    const auditRow = await prisma.auditLog.findFirst({
      where: { entityType: 'Shift', entityId: createdShiftId, action: 'SHIFT_CREATED', note: { contains: '[voice]' } },
    });
    assert.ok(auditRow, 'a real AuditLog row with action SHIFT_CREATED and a [voice] note must exist');
  } finally {
    await prisma.auditLog.deleteMany({ where: { entityType: 'Shift', entityId: createdShiftId } });
    await prisma.shift.delete({ where: { id: createdShiftId } }).catch(() => {});
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
  }
});

test('POST /api/voice/execute: EDIT_SHIFT from a MANAGER session updates only the field the intent supplied, leaving everything else untouched', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  const role = await prisma.role.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && role, 'seed data (location + role) must exist to run this test');

  const manager = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task-final-fix-test__ edit-shift manager', systemRole: 'MANAGER' },
  });
  const originalAssignee = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task-final-fix-test__ edit-shift original assignee', systemRole: 'STAFF' },
  });
  const newAssignee = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task-final-fix-test__ edit-shift new assignee', systemRole: 'STAFF' },
  });

  const originalDate = new Date('2026-09-24T00:00:00.000Z');
  const originalStart = new Date('2026-09-24T09:00:00.000Z');
  const originalEnd = new Date('2026-09-24T17:00:00.000Z');
  const shift = await prisma.shift.create({
    data: {
      locationId: location!.id,
      roleId: role!.id,
      userId: originalAssignee.id,
      date: originalDate,
      startTime: originalStart,
      endTime: originalEnd,
      status: 'PUBLISHED',
    },
  });

  try {
    const token = await sessionFor(manager.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          transcript: 'reassign that shift to the new assignee',
          intent: { intent: 'EDIT_SHIFT', shiftId: shift.id, userId: newAssignee.id, confidence: 0.9, summary: 'Reassign the shift.' },
        }),
      });
      assert.equal(res.status, 200, 'MANAGER must be able to execute EDIT_SHIFT');
      const body = (await res.json()) as { executed: boolean; result: { id: string } };
      assert.equal(body.executed, true);
    });

    const updated = await prisma.shift.findUnique({ where: { id: shift.id } });
    assert.ok(updated, 'the Shift row must still exist');
    assert.equal(updated!.userId, newAssignee.id, 'the field the intent supplied (userId) must have changed');
    // Critical assertion: fields NOT included in the intent must be
    // untouched by the partial-update fallback logic — this is exactly
    // what would break if EDIT_SHIFT's "fall back to the existing shift's
    // value" logic had a bug.
    assert.equal(updated!.date.toISOString(), originalDate.toISOString(), 'date must be unchanged — it was not part of the intent');
    assert.equal(updated!.startTime.toISOString(), originalStart.toISOString(), 'startTime must be unchanged — it was not part of the intent');
    assert.equal(updated!.endTime.toISOString(), originalEnd.toISOString(), 'endTime must be unchanged — it was not part of the intent');
    assert.equal(updated!.roleId, role!.id, 'roleId must be unchanged — it was not part of the intent');

    const auditRow = await prisma.auditLog.findFirst({
      where: { entityType: 'Shift', entityId: shift.id, action: 'SHIFT_UPDATED', note: { contains: '[voice]' } },
    });
    assert.ok(auditRow, 'a real AuditLog row with action SHIFT_UPDATED and a [voice] note must exist');
  } finally {
    await prisma.auditLog.deleteMany({ where: { entityType: 'Shift', entityId: shift.id } });
    await prisma.shift.delete({ where: { id: shift.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: originalAssignee.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: newAssignee.id } }).catch(() => {});
  }
});

test('POST /api/voice/execute: a STAFF session cannot CREATE_SHIFT even with a hand-crafted intent — 403, nothing created', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  const role = await prisma.role.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && role, 'seed data (location + role) must exist to run this test');

  const staffCaller = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task13-test__ create-shift staff', systemRole: 'STAFF' },
  });

  try {
    const token = await sessionFor(staffCaller.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          transcript: 'create a shift for myself',
          intent: { intent: 'CREATE_SHIFT', roleId: role!.id, date: '2026-09-22', start: '09:00', end: '17:00', userId: null, confidence: 0.9, summary: 'x' },
        }),
      });
      assert.equal(res.status, 403);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /does not permit/i);
    });

    const leaked = await prisma.shift.findMany({ where: { locationId: location!.id, date: new Date('2026-09-22T00:00:00.000Z'), roleId: role!.id, userId: null } });
    assert.equal(leaked.length, 0, 'no Shift may be created from a STAFF-session CREATE_SHIFT attempt');
  } finally {
    await prisma.user.delete({ where: { id: staffCaller.id } }).catch(() => {});
  }
});

test('POST /api/voice/execute: ASSIGN_SECTION from a MANAGER session creates a real SectionAssignment', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  const floorPlanImage = await prisma.floorPlanImage.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && floorPlanImage, 'seed data (location + a floor plan image) must exist to run this test');

  const manager = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task13-test__ assign-section manager', systemRole: 'MANAGER' },
  });
  const staff = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task13-test__ assign-section staff', systemRole: 'STAFF' },
  });
  const section = await prisma.floorSection.create({
    data: { locationId: location!.id, floorPlanImageId: floorPlanImage!.id, label: '__task13-test__ Bar', polygon: [], paxCapacity: 6 },
  });

  let assignmentId = '';
  try {
    const token = await sessionFor(manager.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          transcript: 'move the staff member to the bar section tomorrow afternoon',
          intent: { intent: 'ASSIGN_SECTION', sectionId: section.id, staffId: staff.id, shiftDate: '2026-09-23', period: 'PM', dutyLabel: null, confidence: 0.9, summary: 'x' },
        }),
      });
      assert.equal(res.status, 201);
      const body = (await res.json()) as { executed: boolean; result: { id: string; staffId: string } };
      assert.equal(body.executed, true);
      assert.equal(body.result.staffId, staff.id);
    });

    const assignment = await prisma.sectionAssignment.findFirst({ where: { sectionId: section.id, staffId: staff.id } });
    assert.ok(assignment, 'a real SectionAssignment row must exist');
    assignmentId = assignment!.id;

    const auditRow = await prisma.auditLog.findFirst({
      where: { entityType: 'SectionAssignment', entityId: assignment!.id, action: 'SHIFT_ASSIGNED', note: { contains: '[voice]' } },
    });
    assert.ok(auditRow, 'a real AuditLog row with a [voice] note must exist');
  } finally {
    if (assignmentId) await prisma.auditLog.deleteMany({ where: { entityType: 'SectionAssignment', entityId: assignmentId } });
    await prisma.sectionAssignment.deleteMany({ where: { sectionId: section.id } });
    await prisma.floorSection.delete({ where: { id: section.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: staff.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
  }
});

test('POST /api/voice/execute: a real voiceLogId gets its outcome updated to EXECUTED on success', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');

  const staffCaller = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task13-test__ log-outcome staff', systemRole: 'STAFF' },
  });

  const logRow = await prisma.voiceInteractionLog.create({
    data: {
      locationId: location!.id,
      actorId: staffCaller.id,
      transcript: "I can't work next Monday",
      resolvedIntent: 'MARK_AVAILABILITY',
      confidence: 0.95,
      outcome: 'PENDING_CONFIRMATION',
    },
  });

  try {
    const token = await sessionFor(staffCaller.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          transcript: "I can't work next Monday",
          intent: { intent: 'MARK_AVAILABILITY', date: '2026-09-28', type: 'UNAVAILABLE', confidence: 0.95, summary: 'x' },
          voiceLogId: logRow.id,
        }),
      });
      assert.equal(res.status, 200);
    });

    const updated = await prisma.voiceInteractionLog.findUnique({ where: { id: logRow.id } });
    assert.equal(updated!.outcome, 'EXECUTED');
  } finally {
    await prisma.availabilityMark.deleteMany({ where: { userId: staffCaller.id } });
    await prisma.auditLog.deleteMany({ where: { actorId: staffCaller.id } });
    await prisma.voiceInteractionLog.delete({ where: { id: logRow.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: staffCaller.id } }).catch(() => {});
  }
});

test('POST /api/voice/parse-intent returns voiceLogId and writes a real VoiceInteractionLog row', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');
  if (!process.env.GEMINI_API_KEY) {
    // This test needs a real Gemini call; skip cleanly in environments with no key configured, same policy as the rest of this file's implicit dependency on GEMINI_API_KEY for /parse-intent coverage.
    return;
  }

  const staffCaller = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task13-test__ parse-log staff', systemRole: 'STAFF' },
  });

  let voiceLogId = '';
  try {
    const token = await sessionFor(staffCaller.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/parse-intent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ transcript: 'complete gibberish asdkjfh laksjdhf' }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { voiceLogId: string };
      assert.ok(body.voiceLogId);
      voiceLogId = body.voiceLogId;
    });

    const row = await prisma.voiceInteractionLog.findUnique({ where: { id: voiceLogId } });
    assert.ok(row, 'a real VoiceInteractionLog row must exist');
    assert.equal(row!.actorId, staffCaller.id);
  } finally {
    if (voiceLogId) await prisma.voiceInteractionLog.delete({ where: { id: voiceLogId } }).catch(() => {});
    await prisma.user.delete({ where: { id: staffCaller.id } }).catch(() => {});
  }
});

test('POST /api/voice/parse-intent: QUERY_MY_SCHEDULE from a STAFF session resolves and logs ANSWERED', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  const role = await prisma.role.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && role, 'seed data (location + role) must exist to run this test');
  if (!process.env.GEMINI_API_KEY) {
    // This test needs a real Gemini call; skip cleanly in environments with no key configured, same policy as the rest of this file's implicit dependency on GEMINI_API_KEY for /parse-intent coverage.
    return;
  }

  const staffCaller = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task7-test__ query-schedule staff', systemRole: 'STAFF' },
  });
  const shift = await prisma.shift.create({
    data: {
      locationId: location!.id, roleId: role!.id, userId: staffCaller.id,
      date: new Date('2026-09-18T00:00:00.000Z'), startTime: new Date('2026-09-18T18:00:00.000Z'), endTime: new Date('2026-09-19T02:00:00.000Z'), status: 'PUBLISHED',
    },
  });

  let voiceLogId = '';
  try {
    const token = await sessionFor(staffCaller.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/parse-intent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ transcript: "what's my next shift" }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { intent: { intent: string; summary: string }; voiceLogId: string };
      assert.equal(body.intent.intent, 'QUERY_MY_SCHEDULE', `expected QUERY_MY_SCHEDULE, got ${body.intent.intent}`);
      assert.ok(body.intent.summary.trim().length > 0, 'summary must be a non-empty answer');
      assert.ok(body.voiceLogId);
      voiceLogId = body.voiceLogId;
    });

    const row = await prisma.voiceInteractionLog.findUnique({ where: { id: voiceLogId } });
    assert.ok(row, 'a real VoiceInteractionLog row must exist');
    assert.equal(row!.outcome, 'ANSWERED', 'a resolved QUERY_MY_SCHEDULE must log ANSWERED, not PENDING_CONFIRMATION');
  } finally {
    if (voiceLogId) await prisma.voiceInteractionLog.delete({ where: { id: voiceLogId } }).catch(() => {});
    await prisma.shift.delete({ where: { id: shift.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: staffCaller.id } }).catch(() => {});
  }
});

test('POST /api/voice/parse-intent: QUERY_MY_SCHEDULE from a MANAGER session also resolves (STAFF_INTENTS inheritance)', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  const role = await prisma.role.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && role, 'seed data (location + role) must exist to run this test');
  if (!process.env.GEMINI_API_KEY) {
    return;
  }

  const manager = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task7-test__ query-schedule manager', systemRole: 'MANAGER' },
  });
  const shift = await prisma.shift.create({
    data: {
      locationId: location!.id, roleId: role!.id, userId: manager.id,
      date: new Date('2026-09-19T00:00:00.000Z'), startTime: new Date('2026-09-19T09:00:00.000Z'), endTime: new Date('2026-09-19T17:00:00.000Z'), status: 'PUBLISHED',
    },
  });

  let voiceLogId = '';
  try {
    const token = await sessionFor(manager.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/parse-intent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ transcript: "what's my schedule this week" }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { intent: { intent: string }; voiceLogId: string };
      assert.equal(body.intent.intent, 'QUERY_MY_SCHEDULE', 'a MANAGER session must also be able to resolve this staff-tier intent');
      voiceLogId = body.voiceLogId;
    });
  } finally {
    if (voiceLogId) await prisma.voiceInteractionLog.delete({ where: { id: voiceLogId } }).catch(() => {});
    await prisma.shift.delete({ where: { id: shift.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
  }
});

test('POST /api/voice/execute: QUERY_MY_SCHEDULE gets a real 400 (fail-closed — this intent never has an execute path)', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');

  const staffCaller = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task7-test__ query-schedule execute-reject staff', systemRole: 'STAFF' },
  });

  try {
    const token = await sessionFor(staffCaller.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          transcript: "what's my next shift",
          intent: { intent: 'QUERY_MY_SCHEDULE', confidence: 0.95, summary: 'You are working Friday.' },
        }),
      });
      // QUERY_MY_SCHEDULE passes ALL_INTENTS/allowedIntentsFor (it's a real,
      // permitted STAFF intent) but has no case in /execute's switch, so it
      // falls to that switch's own `default: 400 'Unknown intent.'` branch —
      // not a 403 (proves this isn't a permission rejection) and not a 500.
      assert.equal(res.status, 400, 'QUERY_MY_SCHEDULE must never execute — it has no mutator to call');
      const body = (await res.json()) as { error: string };
      assert.doesNotMatch(body.error, /does not permit/i, 'must not be misreported as a permission error');
    });
  } finally {
    await prisma.user.delete({ where: { id: staffCaller.id } }).catch(() => {});
  }
});

test('POST /api/voice/parse-intent: a mutating+mutating compound transcript resolves only the primary intent and flags hasAdditionalRequest', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  const role = await prisma.role.findFirst({ where: { locationId: location!.id } });
  // ASSIGN_SECTION needs a real FloorSection to resolve "the bar section" against, and
  // FloorSection.floorPlanImageId/polygon/paxCapacity are all required, non-nullable
  // columns (see the existing ASSIGN_SECTION fixture above at line ~1136) — so a valid
  // fixture here also needs a seeded FloorPlanImage for this location.
  const floorPlanImage = await prisma.floorPlanImage.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && role && floorPlanImage, 'seed data (location + role + a floor plan image) must exist to run this test');
  if (!process.env.GEMINI_API_KEY) {
    // This test needs a real Gemini call; skip cleanly in environments with no key configured, same policy as the rest of this file's implicit dependency on GEMINI_API_KEY for /parse-intent coverage.
    return;
  }

  const manager = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task9-test__ compound manager', systemRole: 'MANAGER' },
  });
  const ahmed = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task9-test__ Ahmed', systemRole: 'STAFF' },
  });
  const layla = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task9-test__ Layla', systemRole: 'STAFF' },
  });
  const section = await prisma.floorSection.create({
    data: { locationId: location!.id, floorPlanImageId: floorPlanImage!.id, label: '__task9-test__ Bar', polygon: [], paxCapacity: 6 },
  });

  let voiceLogId = '';
  try {
    const token = await sessionFor(manager.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/parse-intent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          transcript: 'Move Ahmed to the bar section this Friday afternoon, and also give Layla a Bartender shift Saturday at 6pm',
        }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { intent: { intent: string }; voiceLogId: string; hasAdditionalRequest: boolean };
      assert.ok(['ASSIGN_SECTION', 'CREATE_SHIFT'].includes(body.intent.intent), `expected one of the two spoken intents, got ${body.intent.intent}`);
      assert.equal(body.hasAdditionalRequest, true, 'a genuinely compound utterance must set hasAdditionalRequest');
      assert.ok(body.voiceLogId);
      voiceLogId = body.voiceLogId;
    });

    const row = await prisma.voiceInteractionLog.findUnique({ where: { id: voiceLogId } });
    assert.equal(row?.hasAdditionalRequest, true, 'the logged row must record the raw signal regardless of what was displayed');
  } finally {
    if (voiceLogId) await prisma.voiceInteractionLog.delete({ where: { id: voiceLogId } }).catch(() => {});
    await prisma.floorSection.delete({ where: { id: section.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: ahmed.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: layla.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
  }
});

test('POST /api/voice/parse-intent: a read-only+mutating compound transcript flags hasAdditionalRequest on the QUERY_MY_SCHEDULE answer-only path', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  const floorPlanImage = await prisma.floorPlanImage.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && floorPlanImage, 'seed data (location + a floor plan image) must exist to run this test');
  if (!process.env.GEMINI_API_KEY) {
    // This test needs a real Gemini call; skip cleanly in environments with no key configured, same policy as the rest of this file's implicit dependency on GEMINI_API_KEY for /parse-intent coverage.
    return;
  }

  const manager = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task9-test__ compound query manager', systemRole: 'MANAGER' },
  });
  const ahmed = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task9-test__ query Ahmed', systemRole: 'STAFF' },
  });
  const section = await prisma.floorSection.create({
    data: { locationId: location!.id, floorPlanImageId: floorPlanImage!.id, label: '__task9-test__ query Bar', polygon: [], paxCapacity: 6 },
  });

  let voiceLogId = '';
  try {
    const token = await sessionFor(manager.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/parse-intent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          transcript: "What's my schedule this week, and also move Ahmed to the bar Friday afternoon",
        }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { intent: { intent: string }; voiceLogId: string; hasAdditionalRequest: boolean };
      assert.ok(['QUERY_MY_SCHEDULE', 'ASSIGN_SECTION'].includes(body.intent.intent), `expected one of the two spoken intents, got ${body.intent.intent}`);
      assert.equal(body.hasAdditionalRequest, true, 'a genuinely compound utterance must set hasAdditionalRequest even on the answer-only path');
      voiceLogId = body.voiceLogId;
    });

    const row = await prisma.voiceInteractionLog.findUnique({ where: { id: voiceLogId } });
    assert.equal(row?.hasAdditionalRequest, true);
  } finally {
    if (voiceLogId) await prisma.voiceInteractionLog.delete({ where: { id: voiceLogId } }).catch(() => {});
    await prisma.floorSection.delete({ where: { id: section.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: ahmed.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
  }
});

test('POST /api/voice/parse-intent: a plain single-request transcript never flags hasAdditionalRequest', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');
  if (!process.env.GEMINI_API_KEY) {
    // This test needs a real Gemini call; skip cleanly in environments with no key configured, same policy as the rest of this file's implicit dependency on GEMINI_API_KEY for /parse-intent coverage.
    return;
  }

  const staffer = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task9-test__ single-request staffer', systemRole: 'STAFF' },
  });

  let voiceLogId = '';
  try {
    const token = await sessionFor(staffer.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/parse-intent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ transcript: 'Mark me unavailable this Friday' }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { hasAdditionalRequest: boolean; voiceLogId: string };
      assert.equal(body.hasAdditionalRequest, false, 'an ordinary single-request command must not flag hasAdditionalRequest');
      voiceLogId = body.voiceLogId;
    });

    const row = await prisma.voiceInteractionLog.findUnique({ where: { id: voiceLogId } });
    assert.equal(row?.hasAdditionalRequest, false);
  } finally {
    if (voiceLogId) await prisma.voiceInteractionLog.delete({ where: { id: voiceLogId } }).catch(() => {});
    await prisma.user.delete({ where: { id: staffer.id } }).catch(() => {});
  }
});
