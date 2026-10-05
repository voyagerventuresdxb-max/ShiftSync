import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../app.js';
import { issueSession } from './identity.js';
import { AiBudgetExceededError, MAX_OUTPUT_TOKENS, aiBudgetConfig, costUsd, withAiBudget, aiUsageSummary, visionWeeklyLimit, type AiCallUsage } from './aiBudget.js';

test('AI_VISION_WEEKLY_LIMIT: default 1 (the old once-a-week), whole numbers from 0 up, anything else the default', () => {
  assert.equal(visionWeeklyLimit({}), 1);
  assert.equal(visionWeeklyLimit({ AI_VISION_WEEKLY_LIMIT: '5' }), 5);
  assert.equal(visionWeeklyLimit({ AI_VISION_WEEKLY_LIMIT: ' 0 ' }), 0);
  for (const bad of ['', '-1', '2.5', 'five']) assert.equal(visionWeeklyLimit({ AI_VISION_WEEKLY_LIMIT: bad }), 1, bad);
});

/**
 * The spend cap's counters are deployment-wide per UTC month/day, so every test here runs on
 * its own far-future month (an injected clock) and removes its rows afterwards — real usage in
 * this database is never touched.
 */
const prisma = new PrismaClient();
const monthsUsed = new Set<string>();
const daysUsed = new Set<string>();
const locationsMade: string[] = [];

function clock(iso: string) {
  monthsUsed.add(iso.slice(0, 7));
  daysUsed.add(iso.slice(0, 10));
  return () => new Date(iso);
}

const env = (budget: number, calls = 1000) => ({ AI_MONTHLY_BUDGET_USD: String(budget), AI_DAILY_CALL_LIMIT: String(calls), AI_PRICE_IN_PER_M: '3', AI_PRICE_OUT_PER_M: '15' });
const config = aiBudgetConfig(env(5));
/** Worst case of a voice_intent call with 1,000 input tokens: 1,000 in + 2,048 out. */
const WORST = costUsd(1_000, MAX_OUTPUT_TOKENS.voice_intent, config);

async function spend(month: string) {
  const row = await prisma.aiSpendMonth.findUnique({ where: { month } });
  return { spent: Number(row?.spentUsd ?? 0), reserved: Number(row?.reservedUsd ?? 0) };
}

async function venue(label: string) {
  const seed = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seed, 'seed data (a location) must exist to run this test');
  const location = await prisma.location.create({ data: { organizationId: seed!.organizationId, name: `__ai-budget-test__ ${label}`, timezone: 'Asia/Dubai' } });
  locationsMade.push(location.id);
  return location;
}

after(async () => {
  await prisma.aiUsage.deleteMany({ where: { month: { in: [...monthsUsed] } } });
  await prisma.aiSpendMonth.deleteMany({ where: { month: { in: [...monthsUsed] } } });
  await prisma.aiCallDay.deleteMany({ where: { day: { in: [...daysUsed] } } });
  await prisma.user.deleteMany({ where: { locationId: { in: locationsMade } } });
  await prisma.location.deleteMany({ where: { id: { in: locationsMade } } });
  await prisma.$disconnect();
});

const exact = (usage: AiCallUsage) => async () => ({ value: 'ok', usage });

test('a call whose worst case would cross the monthly budget is refused and the provider is never called', async () => {
  const now = clock('2099-01-10T10:00:00.000Z');
  let providerCalls = 0;
  await assert.rejects(
    withAiBudget({ locationId: null, feature: 'voice_intent', inputTokensEstimate: 1_000 }, async () => {
      providerCalls++;
      return { value: 'x', usage: { inputTokens: 1, outputTokens: 1 } };
    }, { now, env: env(WORST / 2) }),
    (err: unknown) => err instanceof AiBudgetExceededError && err.limit === 'monthly_budget',
  );
  assert.equal(providerCalls, 0);
  assert.deepEqual(await spend('2099-01'), { spent: 0, reserved: 0 }, 'a refusal reserves nothing');
});

test('the daily call limit refuses further calls without calling the provider', async () => {
  const now = clock('2099-02-10T10:00:00.000Z');
  let providerCalls = 0;
  const once = () =>
    withAiBudget({ locationId: null, feature: 'voice_intent', inputTokensEstimate: 100 }, async () => {
      providerCalls++;
      return { value: 'x', usage: { inputTokens: 10, outputTokens: 10 } };
    }, { now, env: env(1000, 2) });
  await once();
  await once();
  await assert.rejects(once(), (err: unknown) => err instanceof AiBudgetExceededError && err.limit === 'daily_calls');
  assert.equal(providerCalls, 2);
});

test('defaults: vision 60 and voice 200 calls a day, and no overall ceiling unless AI_DAILY_CALL_LIMIT is set', () => {
  const c = aiBudgetConfig({});
  assert.deepEqual([c.visionDailyCallLimit, c.voiceDailyCallLimit, c.dailyCallLimit], [60, 200, null]);
  assert.equal(aiBudgetConfig({ AI_DAILY_CALL_LIMIT: '0' }).dailyCallLimit, 0);
  assert.equal(aiBudgetConfig({ AI_VOICE_DAILY_CALL_LIMIT: 'lots' }).voiceDailyCallLimit, 200, 'a non-number keeps the default');
});

test('vision and voice have separate daily limits: a spent voice allowance never blocks roster reading', async () => {
  const now = clock('2099-09-10T10:00:00.000Z');
  const e = { AI_MONTHLY_BUDGET_USD: '1000', AI_VOICE_DAILY_CALL_LIMIT: '2', AI_VISION_DAILY_CALL_LIMIT: '1', AI_PRICE_IN_PER_M: '3', AI_PRICE_OUT_PER_M: '15' };
  let providerCalls = 0;
  const call = (feature: 'voice_transcribe' | 'voice_intent' | 'roster_vision') =>
    withAiBudget({ locationId: null, feature, inputTokensEstimate: 100 }, async () => {
      providerCalls++;
      return { value: 'x', usage: { inputTokens: 10, outputTokens: 10 } };
    }, { now, env: e });
  await call('voice_transcribe');
  await call('voice_intent');
  await assert.rejects(call('voice_transcribe'), (err: unknown) => err instanceof AiBudgetExceededError && err.limit === 'daily_calls');
  await call('roster_vision');
  await assert.rejects(call('roster_vision'), (err: unknown) => err instanceof AiBudgetExceededError && err.limit === 'daily_calls');
  assert.equal(providerCalls, 3);
  const day = await prisma.aiCallDay.findUniqueOrThrow({ where: { day: '2099-09-10' } });
  assert.deepEqual([day.calls, day.voiceCalls, day.visionCalls], [3, 2, 1]);
  const summary = await aiUsageSummary((await venue('per-feature')).id, { now, env: e });
  assert.deepEqual(summary.voice, { callsToday: 2, callLimit: 2, paused: true });
  assert.deepEqual(summary.vision, { callsToday: 1, callLimit: 1, paused: true });
  assert.equal(summary.paused, false, 'the monthly budget is not reached');
});

test('AI_DAILY_CALL_LIMIT=0 still stops every feature (the runbook switch)', async () => {
  const now = clock('2099-10-10T10:00:00.000Z');
  for (const feature of ['roster_vision', 'voice_transcribe'] as const) {
    await assert.rejects(
      withAiBudget({ locationId: null, feature, inputTokensEstimate: 100 }, async () => ({ value: 'x', usage: { inputTokens: 1, outputTokens: 1 } }), { now, env: env(1000, 0) }),
      (err: unknown) => err instanceof AiBudgetExceededError && err.limit === 'daily_calls',
    );
  }
});

test('parallel calls can never reserve past the budget', async () => {
  const now = clock('2099-03-10T10:00:00.000Z');
  const budget = WORST * 3 + WORST / 2; // room for exactly three worst cases
  let providerCalls = 0;
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () =>
      withAiBudget({ locationId: null, feature: 'voice_intent', inputTokensEstimate: 1_000 }, async () => {
        providerCalls++;
        await new Promise((r) => setTimeout(r, 150));
        return { value: 'x', usage: { inputTokens: null, outputTokens: null } }; // charged the full worst case
      }, { now, env: env(budget) }),
    ),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
  assert.equal(providerCalls, 3, 'only the reserved calls reach the provider');
  const { spent, reserved } = await spend('2099-03');
  assert.equal(reserved, 0, 'every reservation settled');
  assert.ok(spent <= budget, `spent ${spent} must stay within ${budget}`);
});

test('a new UTC month starts a new budget', async () => {
  const jan = clock('2099-04-30T23:59:00.000Z');
  const feb = clock('2099-05-01T00:01:00.000Z');
  const budget = WORST * 1.5;
  const call = (now: () => Date) =>
    withAiBudget({ locationId: null, feature: 'voice_intent', inputTokensEstimate: 1_000 }, async () => ({ value: 'x', usage: { inputTokens: null, outputTokens: null } }), { now, env: env(budget) });
  await call(jan);
  await assert.rejects(call(jan), AiBudgetExceededError);
  await call(feb); // next month: fresh budget
  assert.ok((await spend('2099-05')).spent > 0);
});

test('missing token counts are charged the conservative worst case; real counts settle to the real cost', async () => {
  const now = clock('2099-06-10T10:00:00.000Z');
  const e = env(1000);
  await withAiBudget({ locationId: null, feature: 'voice_intent', inputTokensEstimate: 1_000 }, exact({ inputTokens: null, outputTokens: 40 }), { now, env: e });
  assert.equal((await spend('2099-06')).spent.toFixed(6), WORST.toFixed(6));
  await withAiBudget({ locationId: null, feature: 'voice_intent', inputTokensEstimate: 1_000 }, exact({ inputTokens: 200, outputTokens: 50 }), { now, env: e });
  assert.equal((await spend('2099-06')).spent.toFixed(6), (WORST + costUsd(200, 50, config)).toFixed(6));
});

test('a provider error status is not charged; a network failure is charged the worst case; both count as calls', async () => {
  const now = clock('2099-07-10T10:00:00.000Z');
  const e = env(1000);
  await assert.rejects(
    withAiBudget({ locationId: null, feature: 'voice_intent', inputTokensEstimate: 1_000 }, async () => {
      throw Object.assign(new Error('busy'), { status: 503 });
    }, { now, env: e }),
  );
  assert.equal((await spend('2099-07')).spent, 0);
  await assert.rejects(
    withAiBudget({ locationId: null, feature: 'voice_intent', inputTokensEstimate: 1_000 }, async () => {
      throw new TypeError('fetch failed');
    }, { now, env: e }),
  );
  assert.equal((await spend('2099-07')).spent.toFixed(6), WORST.toFixed(6));
  assert.equal((await prisma.aiCallDay.findUnique({ where: { day: '2099-07-10' } }))?.calls, 2);
});

test('if the spend counters cannot be reached the call is refused (fail closed) and the provider is never called', async () => {
  const unreachable = { $transaction: async () => { throw new Error('connection refused'); } } as unknown as PrismaClient;
  let providerCalls = 0;
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(' '));
  try {
    await assert.rejects(
      withAiBudget({ locationId: null, feature: 'voice_intent', inputTokensEstimate: 100 }, async () => {
        providerCalls++;
        return { value: 'x', usage: { inputTokens: 1, outputTokens: 1 } };
      }, { db: unreachable, env: env(1000) }),
      (err: unknown) => err instanceof AiBudgetExceededError && err.limit === 'ledger_unavailable',
    );
  } finally {
    console.error = original;
  }
  assert.equal(providerCalls, 0);
  assert.ok(errors.some((e) => e.includes('spend ledger unreachable')));
});

test('the per-venue ledger records counts and estimated cost only, and the 80% warning is logged once', async () => {
  const now = clock('2099-08-10T10:00:00.000Z');
  const location = await venue('ledger');
  const budget = costUsd(1_000, 1_000, config) * 1.2;
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(' '));
  try {
    await withAiBudget({ locationId: location.id, feature: 'voice_transcribe', inputTokensEstimate: 2_000 }, exact({ inputTokens: 1_000, outputTokens: 1_000 }), { now, env: env(budget) });
  } finally {
    console.warn = original;
  }
  const row = await prisma.aiUsage.findUniqueOrThrow({ where: { locationId_feature_month: { locationId: location.id, feature: 'voice_transcribe', month: '2099-08' } } });
  assert.deepEqual(
    { calls: row.calls, inputTokens: row.inputTokens, outputTokens: row.outputTokens, usd: Number(row.estimatedUsd).toFixed(6) },
    { calls: 1, inputTokens: 1_000, outputTokens: 1_000, usd: costUsd(1_000, 1_000, config).toFixed(6) },
  );
  assert.deepEqual(Object.keys(row).sort(), ['calls', 'estimatedUsd', 'feature', 'id', 'inputTokens', 'locationId', 'month', 'outputTokens', 'updatedAt']);
  assert.equal(warnings.filter((w) => w.includes('80% of AI_MONTHLY_BUDGET_USD')).length, 1);
  const summary = await aiUsageSummary(location.id, { now, env: env(budget) });
  assert.equal(summary.venue.calls, 1);
  assert.equal(summary.month, '2099-08');
});

test('GET /api/ai/usage: the owner sees the cap; staff, managers, other venues and anonymous callers are refused', async () => {
  const location = await venue('usage A');
  const other = await venue('usage B');
  const mk = (locationId: string, systemRole: 'OWNER' | 'MANAGER' | 'STAFF') =>
    prisma.user.create({ data: { locationId, systemRole, fullName: `__ai-budget-test__ ${systemRole}` } });
  const [owner, manager, staff, otherOwner] = await Promise.all([mk(location.id, 'OWNER'), mk(location.id, 'MANAGER'), mk(location.id, 'STAFF'), mk(other.id, 'OWNER')]);
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const get = async (userId: string | null, query = '') => {
      const headers: Record<string, string> = {};
      if (userId) headers.Authorization = `Bearer ${(await issueSession(userId)).plainToken}`;
      return fetch(`${base}/api/ai/usage${query}`, { headers });
    };
    const ok = await get(owner.id, `?locationId=${location.id}`);
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ['callLimit', 'callsToday', 'limitUsd', 'month', 'monthToDateUsd', 'paused', 'venue', 'vision', 'voice']);
    assert.equal((await get(null)).status, 401);
    assert.equal((await get(staff.id)).status, 403);
    assert.equal((await get(manager.id)).status, 403);
    assert.equal((await get(otherOwner.id, `?locationId=${location.id}`)).status, 403);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('a spreadsheet roster is read by the deterministic parsers and never touches the AI cap', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const location = await venue('deterministic');
  const manager = await prisma.user.create({ data: { locationId: location.id, systemRole: 'MANAGER', fullName: '__ai-budget-test__ manager' } });
  const csv = readFileSync(join(import.meta.dirname, '..', '..', 'eval', 'roster', 'corpus', 'csv-grid.csv'));
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(csv)], { type: 'text/csv' }), 'roster.csv');
    form.append('weekStart', '2031-03-03');
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/schedules/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${(await issueSession(manager.id)).plainToken}` },
      body: form,
    });
    assert.equal(res.status, 200);
    assert.ok(((await res.json()) as { preview: unknown[] }).preview.length > 0, 'the CSV was parsed');
    assert.equal(await prisma.aiUsage.count({ where: { locationId: location.id } }), 0, 'no AI call was recorded for this venue');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
