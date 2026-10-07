import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { GoogleGenAI } from '@google/genai';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/app.js';
import { issueSession } from '../../src/lib/identity.js';
import { __setVoiceIntentClientForTests, normalizeParsedIntent } from '../../src/voice/parseIntent.js';
import { parseIntentRateLimiter } from '../../src/middleware/rateLimit.js';
import type { ParsedIntent } from '../../src/voice/intentSchema.js';
import { canConfirmVoiceIntent } from '../../../shared/voiceIntents.js';
import { CORPUS, intentRoleTable } from './corpus.js';
import { cleanupFixture, seedFixture, snapshot, type Fixture } from './fixture.js';
import { CALLER, rawModelOutput, scoreCase } from './score.js';

/**
 * The voice corpus through the real parse route with a scripted model (no network, nothing
 * paid). For every case: the ideal model answer produces the expected confirm sheet, and
 * nothing in the venue changes before a Confirm. For every adversarial case (a model that
 * ignores its schema, invents an id, or points at another venue): nothing is offered, and a
 * hand-crafted /execute of the same intent is refused where it must be.
 */
process.env.AI_MONTHLY_BUDGET_USD = '1000000';
process.env.AI_VISION_DAILY_CALL_LIMIT = '1000000';
process.env.AI_VOICE_DAILY_CALL_LIMIT = '1000000';
process.env.AI_DAILY_CALL_LIMIT = '1000000';
// Per-person and per-venue daily quotas, where present: the corpus sends far more than one person would.
process.env.AI_VOICE_USER_DAILY_LIMIT = '1000000';
process.env.AI_VOICE_VENUE_DAILY_LIMIT = '1000000';

const prisma = new PrismaClient();
let fx: Fixture;
let server: Server;
let base = '';
let next: Record<string, unknown> = {};

/**
 * A session for the role's caller. The parse route's rate limit (30 per 5 minutes per user)
 * stays on; the corpus resets the caller's in-memory bucket between cases, since it sends
 * far more commands than one person would.
 */
async function tokenFor(role: keyof typeof CALLER): Promise<string> {
  parseIntentRateLimiter.resetKey(fx.users[CALLER[role]]);
  return (await issueSession(fx.users[CALLER[role]])).plainToken;
}

before(async () => {
  fx = await seedFixture(prisma);
  __setVoiceIntentClientForTests({
    models: { generateContent: async () => ({ text: JSON.stringify(next), usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 } }) },
  } as unknown as GoogleGenAI);
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  __setVoiceIntentClientForTests(null);
  await new Promise<void>((r) => server.close(() => r()));
  await cleanupFixture(prisma, fx);
  await prisma.$disconnect();
});

async function parse(token: string, transcript: string, raw: Record<string, unknown>) {
  next = raw;
  const res = await fetch(`${base}/api/voice/parse-intent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ transcript }),
  });
  assert.equal(res.status, 200, `parse-intent answered ${res.status}`);
  return (await res.json()) as { intent: ParsedIntent; hasAdditionalRequest: boolean };
}

async function execute(token: string, transcript: string, intent: ParsedIntent) {
  return fetch(`${base}/api/voice/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ transcript, intent }),
  });
}

const locations = () => [fx.locationId, fx.otherLocationId];

test('the corpus covers every intent with at least 10 cases, and has negatives of every kind', () => {
  for (const { intent } of intentRoleTable()) {
    const cases = CORPUS.filter((c) => (c.expect.outcome === 'intent' && c.expect.intent === intent) || c.adversarial?.intent === intent);
    assert.ok(cases.length >= 10, `${intent}: ${cases.length} cases, need at least 10`);
  }
  for (const category of ['wrong-role', 'unknown-entity', 'past', 'overlap', 'empty', 'non-english', 'compound', 'cross-venue', 'injection'] as const) {
    assert.ok(CORPUS.some((c) => c.category === category), `negatives: ${category}`);
  }
  assert.equal(new Set(CORPUS.map((c) => c.id)).size, CORPUS.length);
});

test('every case, with a well-behaved model: the expected confirm sheet, and nothing changes before Confirm', async () => {
  const failures: string[] = [];
  for (const c of CORPUS) {
    const caller = CALLER[c.role];
    const before = await snapshot(prisma, locations());
    const { intent, hasAdditionalRequest } = await parse(await tokenFor(c.role), c.text, rawModelOutput(fx, c, 'ideal'));
    const after = await snapshot(prisma, locations());
    if (before !== after) failures.push(`${c.id} changed data during parse`);
    const s = scoreCase(fx, c, intent, hasAdditionalRequest, caller);
    if (!s.ok) failures.push(`${c.id} "${c.text}" → ${intent.intent}${'reason' in intent ? ` (${intent.summary} / ${intent.reason})` : ''}`);
    if (s.leak) failures.push(`${c.id} leaked another venue or a number`);
  }
  assert.deepEqual(failures, []);
});

test('scoring: a "not understood" answer in the old generic wording fails, even where nothing should be offered', () => {
  const kevin = CORPUS.find((c) => c.text === 'Give Kevin a shoutout.')!;
  const old: ParsedIntent = { intent: 'UNRECOGNIZED', reason: 'Could not confidently match this to a supported command.', summary: 'Give Kevin a shoutout.' };
  assert.deepEqual([scoreCase(fx, kevin, old, false, 'hannah').ok, scoreCase(fx, kevin, old, false, 'hannah').robotic], [false, true]);
  const plain = CORPUS.find((c) => c.text === 'uh')!;
  assert.equal(scoreCase(fx, plain, old, false, 'sam').ok, false);
  const human: ParsedIntent = { intent: 'UNRECOGNIZED', reason: 'Try again with who, what and when.', summary: "I didn't catch what you'd like to do." };
  assert.equal(scoreCase(fx, plain, human, false, 'sam').ok, true);
  // A person question must be about the person: a generic "didn't catch that" is not enough.
  assert.equal(scoreCase(fx, kevin, human, false, 'hannah').ok, false);
});

test('every adversarial model answer is refused before a Confirm, and /execute refuses it where required; no data changes', async () => {
  const failures: string[] = [];
  for (const c of CORPUS.filter((x) => x.adversarial)) {
    const raw = rawModelOutput(fx, c, 'adversarial');
    const before = await snapshot(prisma, locations());
    const { intent } = await parse(await tokenFor(c.role), c.text, raw);
    if (intent.intent !== 'UNRECOGNIZED') failures.push(`${c.id} offered ${intent.intent} for an adversarial answer`);
    if (c.category === 'wrong-role' && canConfirmVoiceIntent(c.role, c.adversarial!.intent)) failures.push(`${c.id} the app would offer Confirm for ${c.adversarial!.intent}`);
    if (c.executeMustFail) {
      const res = await execute(await tokenFor(c.role), c.text, normalizeParsedIntent(raw));
      if (res.status < 400) failures.push(`${c.id} /execute accepted ${c.adversarial!.intent} (${res.status})`);
    }
    if ((await snapshot(prisma, locations())) !== before) failures.push(`${c.id} changed data`);
  }
  assert.deepEqual(failures, []);
});

test('conflicts: a decided swap or a reviewed join request cannot be decided again', async () => {
  const manager = await tokenFor('MANAGER');
  const approve = normalizeParsedIntent({ intent: 'APPROVE_SWAP', swapRequestId: fx.swaps['alex+1'], confidence: 0.9, summary: 'Approve.' });
  assert.equal((await execute(manager, 'approve the swap', approve)).status, 200);
  const decline = normalizeParsedIntent({ intent: 'DECLINE_SWAP', swapRequestId: fx.swaps['alex+1'], confidence: 0.9, summary: 'Decline.' });
  const before = await snapshot(prisma, locations());
  assert.equal((await execute(manager, 'decline it', decline)).status, 409);
  assert.equal(await snapshot(prisma, locations()), before);
  // And once decided, the parse step stops offering it.
  const { intent } = await parse(manager, 'decline the swap', { intent: 'DECLINE_SWAP', swapRequestId: fx.swaps['alex+1'], confidence: 0.9, summary: 'Decline.' });
  assert.equal(intent.intent, 'UNRECOGNIZED');

  const join = normalizeParsedIntent({ intent: 'DECLINE_JOIN', joinRequestId: fx.joins.riya, confidence: 0.9, summary: 'Decline.' });
  assert.equal((await execute(manager, 'decline riya', join)).status, 200);
  assert.equal((await execute(manager, 'decline riya again', join)).status, 409);
});
