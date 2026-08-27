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
  const location = await prisma.location.findFirst();
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
  const location = await prisma.location.findFirst();
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
  const location = await prisma.location.findFirst();
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
  const location = await prisma.location.findFirst();
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
  const location = await prisma.location.findFirst();
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
  const location = await prisma.location.findFirst();
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
  const location = await prisma.location.findFirst();
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
  const location = await prisma.location.findFirst();
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
