import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AiBudgetExceededError, withAiBudget } from './aiBudget.js';
import { meterCheck, meterRecord, meteredTotalUsd, spendMeter } from './aiSpendMeter.js';

const tempLog = () => join(mkdtempSync(join(tmpdir(), 'ai-meter-')), 'spend.log');
const lines = (log: string) => readFileSync(log, 'utf8').trim().split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>);

/** A ledger that accepts every reservation, so withAiBudget can run without a database. */
function acceptingDb() {
  const tx = { $executeRaw: async () => 1, aiUsage: { upsert: async () => ({}) } };
  return { ...tx, $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) } as never;
}
/** A ledger that must never be reached. */
const untouchableDb = new Proxy({}, { get: () => { throw new Error('the ledger was reached'); } }) as never;

const env = (log: string, stop = '1') => ({ AI_SPEND_METER_LOG: log, AI_SPEND_METER_STOP_USD: stop, AI_MONTHLY_BUDGET_USD: '100', AI_PRICE_IN_PER_M: '3', AI_PRICE_OUT_PER_M: '15' });

test('off unless AI_SPEND_METER_LOG is set; a log without a positive stop value refuses (fail closed)', () => {
  assert.equal(spendMeter({}), null);
  assert.equal(spendMeter({ AI_SPEND_METER_LOG: '  ' }), null);
  assert.deepEqual(spendMeter({ AI_SPEND_METER_LOG: 'x.log', AI_SPEND_METER_STOP_USD: '18' }), { log: 'x.log', stopUsd: 18 });
  for (const bad of [undefined, '', '0', '-1', 'abc']) {
    assert.throws(() => spendMeter({ AI_SPEND_METER_LOG: 'x.log', AI_SPEND_METER_STOP_USD: bad }), AiBudgetExceededError, String(bad));
  }
});

test('the running total is the sum of recorded calls; stop lines and non-JSON notes add nothing', () => {
  const log = tempLog();
  assert.equal(meteredTotalUsd(log), 0);
  const meter = { log, stopUsd: 1 };
  meterRecord(meter, { feature: 'roster_vision', usd: 0.25, worstCaseUsd: 0.3, usage: { inputTokens: 10, outputTokens: 20 }, ok: true });
  meterRecord(meter, { feature: 'voice_intent', usd: 0.5, worstCaseUsd: 0.6, usage: { inputTokens: null, outputTokens: null }, ok: false });
  writeFileSync(log, readFileSync(log, 'utf8') + 'a note by hand\n');
  assert.equal(meteredTotalUsd(log), 0.75);
  assert.deepEqual(lines(log).slice(0, 2).map((l) => l.cumulativeUsd), [0.25, 0.75]);
  assert.throws(() => meterCheck(meter, 'roster_vision', 0.3), AiBudgetExceededError);
  assert.equal(meteredTotalUsd(log), 0.75, 'a refusal is logged but costs nothing');
  meterCheck(meter, 'voice_intent', 0.25); // exactly at the stop value is still allowed
});

test('withAiBudget: a call whose worst case would pass the stop value is never sent', async () => {
  const log = tempLog();
  writeFileSync(log, `${JSON.stringify({ usd: 0.9 })}\n`);
  let sent = false;
  await assert.rejects(
    withAiBudget({ locationId: null, feature: 'roster_vision', inputTokensEstimate: 10_000 }, async () => {
      sent = true;
      return { value: 'x', usage: { inputTokens: 1, outputTokens: 1 } };
    }, { db: untouchableDb, env: env(log) }),
    AiBudgetExceededError,
  );
  assert.equal(sent, false);
  assert.equal(lines(log).at(-1)!.event, 'stopped');
});

test('withAiBudget: every attempt is appended with its estimated cost, failed ones included', async () => {
  const log = tempLog();
  const deps = { db: acceptingDb(), env: env(log, '5') };
  const value = await withAiBudget({ locationId: null, feature: 'voice_intent', inputTokensEstimate: 1_000 }, async () => ({ value: 'ok', usage: { inputTokens: 1_000, outputTokens: 100 } }), deps);
  assert.equal(value, 'ok');
  // A timeout may have been billed: the whole worst case is counted.
  await assert.rejects(withAiBudget({ locationId: null, feature: 'voice_intent', inputTokensEstimate: 1_000 }, async () => { throw new Error('timeout'); }, deps));
  const [first, second] = lines(log);
  assert.equal(first.usd, (1_000 * 3 + 100 * 15) / 1_000_000);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.usd, second.worstCaseUsd);
  assert.equal(meteredTotalUsd(log), Number(((first.usd as number) + (second.usd as number)).toFixed(6)));
});

test('withAiBudget without the meter variables writes no log and behaves as before', async () => {
  const value = await withAiBudget({ locationId: null, feature: 'voice_intent', inputTokensEstimate: 1_000 }, async () => ({ value: 7, usage: { inputTokens: 1, outputTokens: 1 } }), {
    db: acceptingDb(),
    env: { AI_MONTHLY_BUDGET_USD: '100' },
  });
  assert.equal(value, 7);
});
