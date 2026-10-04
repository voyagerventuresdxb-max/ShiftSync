import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { backfillPhonesToE164, describePhoneBackfill } from './phoneBackfill.js';

const prisma = new PrismaClient();

/** A random 7-digit tail so each run uses numbers nobody else holds. */
const tail = () => String(Math.floor(1_000_000 + Math.random() * 8_999_999));

test('backfillPhonesToE164: converts only certain, unique mobiles; leaves landlines, junk and collisions exactly as stored; keeps the original; idempotent', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (a location) must exist to run this test');
  const t1 = tail();
  const t2 = tail();
  const t3 = tail();
  const t4 = tail();
  const make = (name: string, phone: string) =>
    prisma.user.create({ data: { locationId: location!.id, fullName: `__phone-backfill-test__ ${name}`, systemRole: 'STAFF', phone } });

  const users = {
    local: await make('local format', `050 ${t1}`),
    canonical: await make('already E.164', `+97150${t2}`),
    landline: await make('landline', '04 345 6789'),
    junk: await make('junk', `not-a-number-${t1}`),
    // Two records whose different strings are the SAME real number.
    twinA: await make('twin A', `050${t3}`),
    twinB: await make('twin B', `+971 50 ${t3}`),
    // A legacy string that would become a number another user already holds in E.164.
    holder: await make('holder', `+97150${t4}`),
    clash: await make('clash', `0 50 ${t4}`),
  };
  const ids = Object.values(users).map((u) => u.id);
  const phoneOf = async (id: string) => prisma.user.findUniqueOrThrow({ where: { id }, select: { phone: true, phoneBeforeE164: true } });

  try {
    // Dry run: the plan, and nothing written.
    const plan = await backfillPhonesToE164(prisma, { dryRun: true, onlyUserIds: ids });
    assert.deepEqual(plan.converted, [users.local.id]);
    assert.deepEqual([...plan.unparseable].sort(), [users.landline.id, users.junk.id].sort());
    assert.deepEqual([...plan.conflicts].sort(), [users.twinA.id, users.twinB.id, users.clash.id].sort());
    assert.equal((await phoneOf(users.local.id)).phone, `050 ${t1}`, 'dry run writes nothing');

    const report = await backfillPhonesToE164(prisma, { onlyUserIds: ids });
    assert.deepEqual(report.converted, [users.local.id]);

    // Converted, with the original kept for revert.
    assert.deepEqual(await phoneOf(users.local.id), { phone: `+97150${t1}`, phoneBeforeE164: `050 ${t1}` });
    // Everything else is byte-for-byte untouched.
    assert.deepEqual(await phoneOf(users.canonical.id), { phone: `+97150${t2}`, phoneBeforeE164: null });
    assert.deepEqual(await phoneOf(users.landline.id), { phone: '04 345 6789', phoneBeforeE164: null });
    assert.deepEqual(await phoneOf(users.junk.id), { phone: `not-a-number-${t1}`, phoneBeforeE164: null });
    assert.deepEqual(await phoneOf(users.twinA.id), { phone: `050${t3}`, phoneBeforeE164: null });
    assert.deepEqual(await phoneOf(users.twinB.id), { phone: `+971 50 ${t3}`, phoneBeforeE164: null });
    assert.deepEqual(await phoneOf(users.holder.id), { phone: `+97150${t4}`, phoneBeforeE164: null });
    assert.deepEqual(await phoneOf(users.clash.id), { phone: `0 50 ${t4}`, phoneBeforeE164: null });

    // Idempotent: a second run (as on the next API start) changes nothing.
    const again = await backfillPhonesToE164(prisma, { onlyUserIds: ids });
    assert.deepEqual(again.converted, []);
    assert.deepEqual(await phoneOf(users.local.id), { phone: `+97150${t1}`, phoneBeforeE164: `050 ${t1}` });

    // The log line carries ids and counts, never a phone number.
    const line = describePhoneBackfill(report, false);
    assert.match(line, /converted 1 user phone/);
    for (const t of [t1, t2, t3, t4]) assert.ok(!line.includes(t), 'no phone digits in the log line');
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
});
