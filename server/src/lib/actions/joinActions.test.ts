import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { decideJoinRequest, fileJoinRequest, joinLinkPlan, MAX_JOIN_ATTEMPTS } from './joinActions.js';

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

// 2026-10 roster review rework: a roster import adds everyone on the roster as staff with no
// phone. Joining through the venue link must claim that record (and its shifts), not create a
// second staff member with the same name.
test('decideJoinRequest(approve) claims the one unclaimed roster-imported record with the same name instead of creating a duplicate', async () => {
  const { location, manager, joinRequest } = await createFixture('claim imported');
  const imported = await prisma.user.create({ data: { locationId: location.id, fullName: '__joinactions-test__ applicant', systemRole: 'STAFF' } });
  try {
    const result = await decideJoinRequest({ requestId: joinRequest.id, decision: 'approve', reviewedById: manager.id });
    assert.equal(result.result, 'ok');
    assert.equal((result as { userId?: string }).userId, imported.id);
    const claimed = await prisma.user.findUnique({ where: { id: imported.id } });
    assert.equal(claimed!.phone, '+971500000099');
    assert.equal(await prisma.user.count({ where: { locationId: location.id, systemRole: 'STAFF' } }), 1);
  } finally {
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});

// 2026-10 run 14: linking is automatic only for one exact full-name match with nothing else
// close; anything that could be more than one person, or only partly matches, is the manager's
// choice — and approving without that choice is refused, with the candidates. Made-up names.

/** A venue with a manager, imported (phoneless) staff records and one PENDING request from `requestName`. */
async function linkFixture(suffix: string, requestName: string, imported: string[]) {
  const { location, manager, joinRequest } = await createFixture(suffix);
  await prisma.joinRequest.update({ where: { id: joinRequest.id }, data: { fullName: requestName } });
  const records = [];
  for (const fullName of imported) records.push(await prisma.user.create({ data: { locationId: location.id, fullName, systemRole: 'STAFF' } }));
  return { location, manager, joinRequest, records };
}

const approve = (requestId: string, reviewedById: string, linkTo?: string) => decideJoinRequest({ requestId, decision: 'approve', reviewedById, ...(linkTo ? { linkTo } : {}) });
const phoneOf = async (id: string) => (await prisma.user.findUniqueOrThrow({ where: { id } })).phone;
const statusOf = async (id: string) => (await prisma.joinRequest.findUniqueOrThrow({ where: { id } })).status;

test('two imported records with the requester\'s exact full name: no auto-link, the choice is required, and the chosen one is linked', async () => {
  const { location, manager, joinRequest, records } = await linkFixture('same full name', 'Odile Varnsworth', ['Odile Varnsworth', 'Odile Varnsworth']);
  try {
    const refused = await approve(joinRequest.id, manager.id);
    assert.equal(refused.result, 'link_choice_required');
    assert.deepEqual((refused as { candidates: { userId: string; match: string }[] }).candidates.map((c) => c.match), ['exact', 'exact']);
    assert.equal(await statusOf(joinRequest.id), 'PENDING', 'nothing is decided without the choice');
    assert.equal(await prisma.user.count({ where: { locationId: location.id, systemRole: 'STAFF' } }), 2, 'and nobody is created');

    const chosen = await approve(joinRequest.id, manager.id, records[1]!.id);
    assert.equal(chosen.result, 'ok');
    assert.equal((chosen as { userId?: string }).userId, records[1]!.id);
    assert.equal((chosen as { linked?: boolean }).linked, true);
    assert.equal(await phoneOf(records[1]!.id), '+971500000099');
    assert.equal(await phoneOf(records[0]!.id), null, 'the other record is untouched');
  } finally {
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});

test('two imported people share the requester\'s first name: no auto-link; choosing one links exactly that record, the other untouched', async () => {
  const { location, manager, joinRequest, records } = await linkFixture('shared first name', 'Tarek', ['Tarek Halloumi', 'Tarek Benali']);
  const [halloumi, benali] = [records[0]!, records[1]!];
  try {
    const refused = await approve(joinRequest.id, manager.id);
    assert.equal(refused.result, 'link_choice_required');
    const candidates = (refused as { candidates: { userId: string; fullName: string; match: string }[] }).candidates;
    assert.deepEqual(candidates.map((c) => [c.fullName, c.match]), [['Tarek Benali', 'close'], ['Tarek Halloumi', 'close']]);

    const chosen = await approve(joinRequest.id, manager.id, halloumi.id);
    assert.equal(chosen.result, 'ok');
    assert.equal((chosen as { userId?: string }).userId, halloumi.id);
    assert.equal(await phoneOf(halloumi.id), '+971500000099');
    assert.equal(await phoneOf(benali.id), null);
    assert.equal(await prisma.user.count({ where: { locationId: location.id, systemRole: 'STAFF' } }), 2, 'no new person');
    assert.equal(await statusOf(joinRequest.id), 'APPROVED');
  } finally {
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});

test('one exact full-name match with nothing else close links on its own; "new" still adds a new person when the manager says so', async () => {
  const { location, manager, joinRequest, records } = await linkFixture('single exact', 'Odile Varnsworth', ['odile  VARNSWORTH', 'Tarek Halloumi']);
  try {
    const linked = await approve(joinRequest.id, manager.id);
    assert.equal(linked.result, 'ok');
    assert.equal((linked as { userId?: string }).userId, records[0]!.id);
    assert.equal(await phoneOf(records[1]!.id), null);
  } finally {
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
  const second = await linkFixture('single exact, new', 'Odile Varnsworth', ['Odile Varnsworth']);
  try {
    const fresh = await approve(second.joinRequest.id, second.manager.id, 'new');
    assert.equal(fresh.result, 'ok');
    assert.equal((fresh as { linked?: boolean }).linked, false);
    assert.notEqual((fresh as { userId?: string }).userId, second.records[0]!.id);
    assert.equal(await phoneOf(second.records[0]!.id), null);
  } finally {
    await prisma.location.delete({ where: { id: second.location.id } }).catch(() => {});
  }
});

test('no imported record could be them: a new person is created and nothing imported is touched', async () => {
  const { location, manager, joinRequest, records } = await linkFixture('no match', 'Ines Calloway', ['Tarek Halloumi', 'Odile Varnsworth']);
  try {
    const result = await approve(joinRequest.id, manager.id);
    assert.equal(result.result, 'ok');
    assert.equal((result as { linked?: boolean }).linked, false);
    const created = await prisma.user.findUniqueOrThrow({ where: { id: (result as { userId?: string }).userId! } });
    assert.equal(created.fullName, 'Ines Calloway');
    for (const r of records) assert.equal(await phoneOf(r.id), null);
  } finally {
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});

test('a chosen record must be an imported, never-signed-in staff record of this venue: another venue\'s, a signed-in one or a manager\'s is refused', async () => {
  const { location, manager, joinRequest } = await linkFixture('bad targets', 'Tarek', ['Tarek Halloumi', 'Tarek Benali']);
  const other = await createFixture('bad targets, other venue');
  const elsewhere = await prisma.user.create({ data: { locationId: other.location.id, fullName: 'Tarek Halloumi', systemRole: 'STAFF' } });
  const signedIn = await prisma.user.create({ data: { locationId: location.id, fullName: 'Tarek Oyelaran', systemRole: 'STAFF', phone: '+971500000097' } });
  const managerRecord = await prisma.user.create({ data: { locationId: location.id, fullName: 'Tarek Mansfield', systemRole: 'MANAGER' } });
  try {
    for (const target of [elsewhere.id, signedIn.id, managerRecord.id, 'no-such-record']) {
      const result = await approve(joinRequest.id, manager.id, target);
      assert.equal(result.result, 'link_target_invalid', target);
    }
    assert.equal(await statusOf(joinRequest.id), 'PENDING');
    assert.equal(await phoneOf(elsewhere.id), null);
    assert.equal(await phoneOf(managerRecord.id), null);
    assert.equal(await phoneOf(signedIn.id), '+971500000097');
  } finally {
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
    await prisma.location.delete({ where: { id: other.location.id } }).catch(() => {});
  }
});

test('joinLinkPlan: a first name only, a nickname, an initial or a surname only is never linked on its own', () => {
  const rec = (id: string, fullName: string) => ({ id, fullName, role: null });
  assert.equal(joinLinkPlan('Tarek Halloumi', [rec('a', 'Tarek Halloumi')]).kind, 'link');
  assert.equal(joinLinkPlan('Tarek Halloumi', [rec('a', 'Tarek Halloumi'), rec('b', 'Tarek')]).kind, 'choose', 'exact plus a first-name-only record');
  assert.equal(joinLinkPlan('Tarek', [rec('a', 'Tarek')]).kind, 'choose', 'a one-word name is a first name only');
  assert.equal(joinLinkPlan('Tarek Halloumi', [rec('a', 'Halloumi')]).kind, 'choose', 'surname only');
  assert.equal(joinLinkPlan('Tarek Halloumi', [rec('a', 'T. Halloumi')]).kind, 'choose', 'an initial');
  assert.equal(joinLinkPlan('Bill Ashgrove', [rec('a', 'William Ashgrove')]).kind, 'choose', 'a nickname');
  assert.equal(joinLinkPlan('Ines Calloway', [rec('a', 'Tarek Halloumi')]).kind, 'new');
  const plan = joinLinkPlan('Tarek Halloumi', [rec('b', 'Tarek'), rec('a', 'Tarek Halloumi')]);
  assert.ok(plan.kind === 'choose');
  assert.deepEqual(plan.candidates.map((c) => c.userId), ['a', 'b'], 'the exact match is listed first');
});
