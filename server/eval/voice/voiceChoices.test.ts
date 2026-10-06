import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { GoogleGenAI } from '@google/genai';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/app.js';
import { issueSession } from '../../src/lib/identity.js';
import { __setVoiceIntentClientForTests, WHICH_DID_YOU_MEAN } from '../../src/voice/parseIntent.js';
import { parseIntentRateLimiter } from '../../src/middleware/rateLimit.js';
import type { ParsedIntent } from '../../src/voice/intentSchema.js';
import { addDays, cleanupFixture, LEAK_STRINGS, seedFixture, snapshot, type Fixture } from './fixture.js';
import { CALLER } from './score.js';

/**
 * "Which did you mean?": below the confidence threshold, the model's two or three readings are
 * offered as choices, but only readings that pass every check a confident answer must pass (the
 * caller's role, ids in the caller's own venue, no past dates). Nothing changes until a choice
 * is confirmed through /execute. Scripted model, no network.
 */
process.env.AI_MONTHLY_BUDGET_USD = '1000000';
process.env.AI_VISION_DAILY_CALL_LIMIT = '1000000';
process.env.AI_VOICE_DAILY_CALL_LIMIT = '1000000';
process.env.AI_DAILY_CALL_LIMIT = '1000000';
process.env.AI_VOICE_USER_DAILY_LIMIT = '1000000';
process.env.AI_VOICE_VENUE_DAILY_LIMIT = '1000000';

const prisma = new PrismaClient();
let fx: Fixture;
let server: Server;
let base = '';
let next: Record<string, unknown> = {};

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

async function parseWithLog(role: keyof typeof CALLER, transcript: string, raw: Record<string, unknown>) {
  next = raw;
  const res = await fetch(`${base}/api/voice/parse-intent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await tokenFor(role)}` },
    body: JSON.stringify({ transcript }),
  });
  assert.equal(res.status, 200);
  return (await res.json()) as { intent: ParsedIntent; voiceLogId: string | null };
}

const parse = async (role: keyof typeof CALLER, transcript: string, raw: Record<string, unknown>) => (await parseWithLog(role, transcript, raw)).intent;

const approve = (confidence: number) => ({ intent: 'APPROVE_SWAP', swapRequestId: fx.swaps['alex+1'], confidence, summary: "Approve Alex's swap request." });
const decline = (confidence: number) => ({ intent: 'DECLINE_SWAP', swapRequestId: fx.swaps['alex+1'], confidence, summary: "Decline Alex's swap request." });
const options = (intent: ParsedIntent) => (intent.intent === 'UNRECOGNIZED' ? (intent.options ?? []) : []);
const locations = () => [fx.locationId, fx.otherLocationId];

test('approve or decline? both readings are offered as choices, and nothing changes before a Confirm', async () => {
  const before = await snapshot(prisma, locations());
  const intent = await parse('MANAGER', "Alex's swap, the pending one", { ...approve(0.45), alternatives: [decline(0.4)] });
  assert.equal(intent.intent, 'UNRECOGNIZED');
  assert.equal(intent.summary, WHICH_DID_YOU_MEAN);
  assert.deepEqual(
    options(intent).map((o) => [o.intent, 'swapRequestId' in o ? o.swapRequestId : null]),
    [
      ['APPROVE_SWAP', fx.swaps['alex+1']],
      ['DECLINE_SWAP', fx.swaps['alex+1']],
    ],
  );
  assert.equal(await snapshot(prisma, locations()), before);
});

test("a choice outside the caller's role is never offered", async () => {
  // A staff caller: their own swap request, and two manager-only readings the model shouldn't have produced.
  const intent = await parse('STAFF', 'swap with omar or approve it', {
    intent: 'REQUEST_SWAP',
    shiftId: fx.shifts['sam+1'],
    targetUserId: fx.users.omar,
    targetUserName: 'Omar Haddad',
    reason: null,
    confidence: 0.4,
    summary: 'Ask Omar to cover your shift tomorrow.',
    alternatives: [approve(0.3), decline(0.3)],
  });
  assert.equal(intent.intent, 'UNRECOGNIZED');
  assert.deepEqual(options(intent), [], 'one action left is not a choice: the caller is asked to rephrase');
});

test("a choice that points at another venue's data is dropped, and nothing of that venue is shown", async () => {
  const intent = await parse('MANAGER', 'shout out to bart or approve the swap', {
    ...approve(0.4),
    alternatives: [{ intent: 'POST_SHOUTOUT', targetUserId: fx.other.person, targetUserName: 'Bartholomew Quill', content: 'Great work', confidence: 0.4, summary: 'Thank Bartholomew Quill.' }],
  });
  assert.equal(intent.intent, 'UNRECOGNIZED');
  assert.deepEqual(options(intent), []);
  const shown = JSON.stringify(intent);
  for (const s of [...LEAK_STRINGS, fx.other.person]) assert.ok(!shown.includes(s), `must not show ${s}`);
});

test('past dates and duplicates are dropped; at most three choices', async () => {
  const yesterday = addDays(fx.today, -1);
  const pastShift = { intent: 'CREATE_SHIFT', roleId: fx.roles.Server, userId: fx.users.layla, date: yesterday, start: '09:00', end: '17:00', confidence: 0.4, summary: 'Create a shift yesterday.' };
  const dropped = await parse('MANAGER', 'the swap, or a shift yesterday', { ...approve(0.4), alternatives: [pastShift, approve(0.35)] });
  assert.deepEqual(options(dropped), []);

  const join = (intent: string) => ({ intent, joinRequestId: fx.joins.riya, confidence: 0.3, summary: `${intent} Riya.` });
  const capped = await parse('MANAGER', 'approve them', { ...approve(0.4), alternatives: [decline(0.35), join('APPROVE_JOIN'), join('DECLINE_JOIN')] });
  assert.deepEqual(
    options(capped).map((o) => o.intent),
    ['APPROVE_SWAP', 'DECLINE_SWAP', 'APPROVE_JOIN'],
  );
});

test('a confident answer is offered on its own, as before', async () => {
  const intent = await parse('MANAGER', "approve Alex's swap", { ...approve(0.9), alternatives: [decline(0.1)] });
  assert.equal(intent.intent, 'APPROVE_SWAP');
});

test('the chosen reading goes through the normal /execute path once confirmed, and the voice log names it', async () => {
  const { intent, voiceLogId } = await parseWithLog('MANAGER', "Alex's swap", { ...approve(0.45), alternatives: [decline(0.4)] });
  assert.ok(voiceLogId);
  assert.equal((await prisma.voiceInteractionLog.findUniqueOrThrow({ where: { id: voiceLogId } })).outcome, 'LOW_CONFIDENCE');
  const chosen = options(intent).find((o) => o.intent === 'DECLINE_SWAP');
  assert.ok(chosen);
  const res = await fetch(`${base}/api/voice/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await tokenFor('MANAGER')}` },
    body: JSON.stringify({ transcript: "Alex's swap", intent: chosen, voiceLogId }),
  });
  assert.equal(res.status, 200);
  const swap = await prisma.shiftSwapRequest.findUniqueOrThrow({ where: { id: fx.swaps['alex+1'] } });
  assert.equal(swap.status, 'DECLINED');
  const log = await prisma.voiceInteractionLog.findUniqueOrThrow({ where: { id: voiceLogId } });
  assert.deepEqual([log.resolvedIntent, log.outcome], ['DECLINE_SWAP', 'EXECUTED']);
});
