import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { applyVoicePatches, refusalReply, VOICE_PENDING_REQUEST, VOICE_WEEK_MOVED } from './weekWrites.js';

/**
 * Voice has no week version on screen, so it presents the version the week is at when the
 * confirmed command runs. A writer landing in between (simulated here by the version read coming
 * back one behind) is a conflict: the command is re-read and retried once, then refused.
 */
const WEEK = '2031-05-05';
const TUE = '2031-05-06';
let orgId = '';
let locationId = '';
let roleId = '';
let userId = '';

before(async () => {
  const org = await prisma.organization.create({ data: { name: `__voice-week-writes-test__ ${Date.now()}` } });
  orgId = org.id;
  locationId = (await prisma.location.create({ data: { organizationId: org.id, name: org.name, timezone: 'Asia/Dubai' } })).id;
  roleId = (await prisma.role.create({ data: { locationId, name: 'Server' } })).id;
  userId = (await prisma.user.create({ data: { locationId, fullName: 'Writes Example', systemRole: 'STAFF', roleId } })).id;
});

after(async () => {
  await prisma.shift.deleteMany({ where: { locationId } }).catch(() => {});
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
});

/** A client whose voice-side version read comes back one behind for the first `staleReads` transactions. */
function lagging(staleReads: number): typeof prisma {
  let left = staleReads;
  const bind = (target: object, prop: string | symbol) => {
    const value = Reflect.get(target, prop) as unknown;
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
  };
  return {
    $transaction: (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { maxWait?: number; timeout?: number }) =>
      prisma.$transaction((tx) => {
        const stale = left-- > 0;
        const rotaWeek = new Proxy(tx.rotaWeek, {
          get(target, prop) {
            if (prop !== 'findUnique' || !stale) return bind(target, prop);
            return async (args: { select?: { version?: boolean } }) => {
              const row = (await Reflect.apply(target.findUnique, target, [args])) as { version: number } | null;
              // Only the voice-side read (it selects the version alone); the week model's own reads are untouched.
              return args.select?.version ? { version: (row?.version ?? 1) - 1 } : row;
            };
          },
        });
        const client = new Proxy(tx, { get: (target, prop) => (prop === 'rotaWeek' ? rotaWeek : bind(target, prop)) });
        return fn(client as Prisma.TransactionClient);
      }, options),
  } as unknown as typeof prisma;
}

const create = (date: string) => [{ weekStart: WEEK, ops: [{ op: 'create' as const, userId, roleId, date, ranges: [{ start: '09:00', end: '17:00' }] }] }];
const versionNow = async () => (await prisma.rotaWeek.findUnique({ where: { locationId_weekStart: { locationId, weekStart: new Date(`${WEEK}T00:00:00.000Z`) } } }))?.version ?? 1;

test('a week that moved under the command is re-read and retried once, then applied', async () => {
  const before = await versionNow();
  const out = await applyVoicePatches({ locationId, actorId: userId, transcript: 'retry', patches: create(TUE) }, lagging(1));
  assert.equal(out.result, 'ok');
  assert.equal(await versionNow(), before + 1);
  assert.equal(await prisma.shift.count({ where: { locationId, userId } }), 1);
});

test('still moving after the retry: version_conflict, and nothing is written', async () => {
  const before = await versionNow();
  const count = await prisma.shift.count({ where: { locationId } });
  const out = await applyVoicePatches({ locationId, actorId: userId, transcript: 'conflict', patches: create('2031-05-07') }, lagging(2));
  assert.deepEqual(out, { result: 'version_conflict' });
  assert.equal(await versionNow(), before);
  assert.equal(await prisma.shift.count({ where: { locationId } }), count);
  assert.deepEqual(refusalReply('version_conflict', ''), { status: 409, error: VOICE_WEEK_MOVED });
});

test('a refusal is returned, not thrown, and rolls back every week of the command', async () => {
  // A second shift the same day for the same person: refused by the week model's person-day rule.
  const out = await applyVoicePatches({ locationId, actorId: userId, transcript: 'twice', patches: create(TUE) });
  assert.equal(out.result, 'refused');
  assert.ok(out.result === 'refused' && out.refusal === 'already_has_shift');
  assert.equal(await prisma.shift.count({ where: { locationId, userId, date: new Date(`${TUE}T00:00:00.000Z`) } }), 1);
  assert.deepEqual(refusalReply('pending_request', 'x'), { status: 409, error: VOICE_PENDING_REQUEST });
  assert.equal(refusalReply('bad_ranges', 'Times must be…').status, 422);
  assert.equal(refusalReply('past_day', 'x').status, 400);
});
