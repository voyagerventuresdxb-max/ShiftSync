import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { decideJoinRequest } from './joinActions.js';

const prisma = new PrismaClient();

/**
 * Builds a throwaway location and a PENDING JoinRequest against it.
 * Everything cascades off the location row, so `prisma.location.delete` is
 * the only cleanup each test needs.
 */
async function createFixture(nameSuffix: string) {
  const seedLocation = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seedLocation, 'seed data (a location) must exist to run this test');

  const location = await prisma.location.create({
    data: {
      organizationId: seedLocation!.organizationId,
      name: `__joinactions-test__ ${nameSuffix}`,
      timezone: 'Asia/Dubai',
    },
  });
  const manager = await prisma.user.create({
    data: { locationId: location.id, fullName: '__joinactions-test__ Manager', systemRole: 'MANAGER' },
  });
  const joinRequest = await prisma.joinRequest.create({
    data: {
      locationId: location.id,
      phone: '+971500000099',
      fullName: '__joinactions-test__ Applicant',
      status: 'PENDING',
    },
  });

  return { location, manager, joinRequest };
}

test('decideJoinRequest(approve) guards against a second decision on an already-approved request — no double User created', async () => {
  const { location, manager, joinRequest } = await createFixture('double approve');

  try {
    // 1. Decide it once, for real — this moves the state the guard defends.
    const first = await decideJoinRequest({ requestId: joinRequest.id, decision: 'approve', reviewedById: manager.id });
    assert.equal(first.result, 'ok');
    assert.equal((first as { status: string }).status, 'APPROVED');
    const createdUserId = (first as { userId?: string }).userId;
    assert.ok(createdUserId, 'approval must report the created user id');

    // 2. Decide it again with the ORIGINAL stale expectation (the request
    //    was PENDING when this caller last looked at it). The atomic
    //    `updateMany` guard inside the transaction must find status is no
    //    longer PENDING and report a conflict — not create a second User.
    const second = await decideJoinRequest({ requestId: joinRequest.id, decision: 'approve', reviewedById: manager.id });
    assert.equal(second.result, 'already_reviewed', 'a second decision on an already-reviewed request must be rejected as a conflict');

    const usersCreatedFromThisRequest = await prisma.user.findMany({
      where: { locationId: location.id, fullName: '__joinactions-test__ Applicant' },
    });
    assert.equal(usersCreatedFromThisRequest.length, 1, 'the losing race must not have created a second User row');

    const persisted = await prisma.joinRequest.findUnique({ where: { id: joinRequest.id } });
    assert.equal(persisted!.status, 'APPROVED');
    assert.equal(persisted!.createdUserId, createdUserId, 'the request must still point at the FIRST approval\'s user, unmodified by the losing second call');
  } finally {
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});

test('decideJoinRequest(decline) guards against a second decision after the request was already approved', async () => {
  const { location, manager, joinRequest } = await createFixture('approve then decline');

  try {
    const first = await decideJoinRequest({ requestId: joinRequest.id, decision: 'approve', reviewedById: manager.id });
    assert.equal(first.result, 'ok');

    // A second, different reviewer's decline call — racing on the same
    // PENDING snapshot the approver started from — must also be rejected,
    // not silently flip an already-approved request to DECLINED.
    const second = await decideJoinRequest({ requestId: joinRequest.id, decision: 'decline', reviewedById: manager.id });
    assert.equal(second.result, 'already_reviewed');

    const persisted = await prisma.joinRequest.findUnique({ where: { id: joinRequest.id } });
    assert.equal(persisted!.status, 'APPROVED', 'the losing decline must not have overwritten the real APPROVED status');
  } finally {
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});
