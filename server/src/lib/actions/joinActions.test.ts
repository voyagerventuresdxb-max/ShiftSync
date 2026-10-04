import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { decideJoinRequest, fileJoinRequest, MAX_JOIN_ATTEMPTS } from './joinActions.js';

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

test('decideJoinRequest(approve) racing itself: one approval wins, the other is already_reviewed (not phone_taken), one User', async () => {
  const { location, manager, joinRequest } = await createFixture('concurrent approve');

  try {
    const results = await Promise.all([
      decideJoinRequest({ requestId: joinRequest.id, decision: 'approve', reviewedById: manager.id }),
      decideJoinRequest({ requestId: joinRequest.id, decision: 'approve', reviewedById: manager.id }),
    ]);
    assert.deepEqual(results.map((r) => r.result).sort(), ['already_reviewed', 'ok']);
    assert.equal(await prisma.user.count({ where: { locationId: location.id, fullName: '__joinactions-test__ Applicant' } }), 1);
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

test('fileJoinRequest: concurrent re-applies on separate connections file one request, and none get past the cap', async () => {
  assert.equal(MAX_JOIN_ATTEMPTS, 3);
  const { location } = await createFixture('concurrent re-apply');
  const phone = '+971500000098';
  const where = { locationId: location.id, phone };
  await prisma.joinRequest.createMany({
    data: [1, 2].map((i) => ({ ...where, fullName: `__joinactions-test__ Declined ${i}`, status: 'DECLINED' as const, createdAt: new Date(Date.now() - i * 60_000) })),
  });
  const other = new PrismaClient();
  try {
    const input = { ...where, fullName: '__joinactions-test__ Re-applicant', inviteLinkId: null };
    const filings = await Promise.all([fileJoinRequest(input, prisma), fileJoinRequest(input, other), fileJoinRequest(input, prisma), fileJoinRequest(input, other)]);
    assert.deepEqual(filings.map((f) => f.kind).sort(), ['created', 'open', 'open', 'open']);
    const created = filings.find((f) => f.kind === 'created') as { requestId: string };
    assert.ok(filings.every((f) => f.kind !== 'open' || f.requestId === created.requestId), 'the others see the one new request');
    assert.equal(await prisma.joinRequest.count({ where }), MAX_JOIN_ATTEMPTS);

    await prisma.joinRequest.update({ where: { id: created.requestId }, data: { status: 'DECLINED' } });
    const capped = await Promise.all([fileJoinRequest(input, prisma), fileJoinRequest(input, other)]);
    assert.deepEqual(capped, [{ kind: 'exhausted' }, { kind: 'exhausted' }]);
    assert.equal(await prisma.joinRequest.count({ where }), MAX_JOIN_ATTEMPTS);
  } finally {
    await other.$disconnect();
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});
