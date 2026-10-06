import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { GoogleGenAI } from '@google/genai';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/app.js';
import { issueSession } from '../../src/lib/identity.js';
import { __setVoiceIntentClientForTests, VOICE_DIDNT_CATCH } from '../../src/voice/parseIntent.js';
import { parseIntentRateLimiter } from '../../src/middleware/rateLimit.js';
import type { ParsedIntent } from '../../src/voice/intentSchema.js';
import { VOICE_ROLE_REFUSAL } from '../../../shared/voiceIntents.js';
import { cleanupFixture, LEAK_STRINGS, PEOPLE, seedFixture, snapshot, type Fixture } from './fixture.js';
import { CALLER } from './score.js';

/**
 * Voice commands that name a person, through the real parse and execute routes with a scripted
 * model (no network). The person is looked up in the caller's own venue: someone who isn't there
 * gets a plain "I couldn't find Rana on your team.", a first name two or three people share is a
 * "Which Karim?" question with one complete reading per person, and nothing changes until one is
 * confirmed. Made-up names only.
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

async function parse(role: keyof typeof CALLER, transcript: string, raw: Record<string, unknown>) {
  next = raw;
  const res = await fetch(`${base}/api/voice/parse-intent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await tokenFor(role)}` },
    body: JSON.stringify({ transcript }),
  });
  assert.equal(res.status, 200);
  return (await res.json()) as { intent: ParsedIntent; voiceLogId: string | null };
}

async function execute(role: keyof typeof CALLER, transcript: string, intent: ParsedIntent, voiceLogId: string | null) {
  return fetch(`${base}/api/voice/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await tokenFor(role)}` },
    body: JSON.stringify({ transcript, intent, voiceLogId }),
  });
}

const shoutout = (targetUserName: string, targetUserId: string | null, confidence = 0.92) => ({
  intent: 'POST_SHOUTOUT',
  targetUserId,
  targetUserName,
  content: 'Great job',
  confidence,
  summary: `Give ${targetUserName} a shoutout with this note.`,
});
const locations = () => [fx.locationId, fx.otherLocationId];
const question = (i: ParsedIntent) => {
  assert.equal(i.intent, 'UNRECOGNIZED');
  return i as Extract<ParsedIntent, { intent: 'UNRECOGNIZED' }>;
};
const offered = (i: ParsedIntent) => (question(i).options ?? []).map((o) => (o.intent === 'POST_SHOUTOUT' ? o.targetUserId : `${o.intent}?`));
const logRow = (id: string | null) => prisma.voiceInteractionLog.findUniqueOrThrow({ where: { id: id! } });

test('a person who exists: the confirm sheet names them in full and previews the shout-out', async () => {
  const { intent } = await parse('MANAGER', 'Give Layla a shout-out saying great job', shoutout('Layla', null));
  assert.equal(intent.intent, 'POST_SHOUTOUT');
  if (intent.intent !== 'POST_SHOUTOUT') return;
  assert.equal(intent.targetUserId, fx.users.layla);
  assert.equal(intent.targetUserName, PEOPLE.layla.name);
  assert.equal(intent.content, 'Great job');
  assert.deepEqual(intent.details, { person: PEOPLE.layla.name });
});

test("a person who isn't at the venue: a plain message naming them, no choices, nothing changes, and the log says why", async () => {
  const before = await snapshot(prisma, locations());
  const { intent, voiceLogId } = await parse('MANAGER', 'Give Rana a shout-out saying great job', shoutout('Rana', null));
  const q = question(intent);
  assert.equal(q.summary, "I couldn't find Rana on your team.");
  assert.match(q.reason, /add them in People/);
  assert.deepEqual(q.person, { heard: 'Rana', status: 'missing' });
  assert.equal(q.options, undefined);
  assert.doesNotMatch(`${q.summary} ${q.reason}`, /supported command|intent/i);
  assert.equal(await snapshot(prisma, locations()), before);
  const row = await logRow(voiceLogId);
  assert.deepEqual([row.resolvedIntent, row.outcome, row.declineReason], ['POST_SHOUTOUT', 'REJECTED_VALIDATION', 'person_missing:0']);
});

test('a staff member is not told to add people; a similar name is suggested', async () => {
  const { intent } = await parse('STAFF', 'Ask Mariel to cover my shift tomorrow', {
    intent: 'REQUEST_SWAP', shiftId: fx.shifts['sam+1'], targetUserId: null, targetUserName: 'Mariel', reason: null, confidence: 0.9, summary: 'Ask Mariel to cover.',
  });
  const q = question(intent);
  assert.equal(q.summary, "I couldn't find Mariel on your team.");
  assert.doesNotMatch(q.reason, /People/);
  const options = q.options ?? [];
  assert.deepEqual(
    options.map((o) => [o.intent, o.intent === 'REQUEST_SWAP' ? o.targetUserId : null]),
    [['REQUEST_SWAP', fx.users.maricel]],
  );
  assert.match(options[0]!.summary, new RegExp(`^Ask ${PEOPLE.maricel.name} to cover your \\w{3} \\d{1,2} \\w{3} shift\\.$`));
});

test('two people share the first name: "Which Karim?", one complete reading each, even when the model picked one at high confidence', async () => {
  for (const modelId of [null, fx.users.karim]) {
    const before = await snapshot(prisma, locations());
    const { intent, voiceLogId } = await parse('MANAGER', 'Give Karim a shout-out saying great job', shoutout('Karim', modelId));
    const q = question(intent);
    assert.equal(q.summary, 'Which Karim did you mean?');
    assert.deepEqual(q.person, { heard: 'Karim', status: 'ambiguous' });
    assert.deepEqual(offered(intent).sort(), [fx.users.karim, fx.users.karim2].sort());
    for (const o of q.options ?? []) {
      assert.equal(o.intent, 'POST_SHOUTOUT');
      if (o.intent !== 'POST_SHOUTOUT') continue;
      assert.equal(o.content, 'Great job', 'the note is the same in every choice');
      assert.equal(o.summary, `Give ${o.targetUserName} a shout-out.`);
      assert.deepEqual(o.details, { person: o.targetUserName });
    }
    assert.equal(await snapshot(prisma, locations()), before);
    assert.equal((await logRow(voiceLogId)).declineReason, 'person_ambiguous:2');
  }
});

test('picking one Karim and confirming posts exactly one shout-out, to that person; the log keeps the question', async () => {
  const transcript = 'Give Karim a shout-out saying great job';
  const { intent, voiceLogId } = await parse('MANAGER', transcript, shoutout('Karim', null));
  const aziz = question(intent).options!.find((o) => o.intent === 'POST_SHOUTOUT' && o.targetUserId === fx.users.karim2)!;
  const res = await execute('MANAGER', transcript, aziz, voiceLogId);
  assert.equal(res.status, 201);
  const posted = await prisma.shoutout.findMany({ where: { locationId: fx.locationId } });
  assert.deepEqual(posted.map((s) => [s.employeeId, s.note]), [[fx.users.karim2, 'Great job']]);
  const row = await logRow(voiceLogId);
  assert.deepEqual([row.resolvedIntent, row.outcome, row.declineReason], ['POST_SHOUTOUT', 'EXECUTED', 'person_ambiguous:2']);
  await prisma.shoutout.deleteMany({ where: { locationId: fx.locationId } });
});

test('three people share the first name: all three are offered', async () => {
  const third = await prisma.user.create({ data: { locationId: fx.locationId, fullName: 'Karim Bashir', systemRole: 'STAFF' } });
  try {
    const { intent } = await parse('MANAGER', 'Give Karim a shout-out saying great job', shoutout('Karim', fx.users.karim2));
    assert.deepEqual(offered(intent).sort(), [fx.users.karim, fx.users.karim2, third.id].sort());
  } finally {
    await prisma.user.delete({ where: { id: third.id } });
  }
});

test("the model's pick disagreeing with the name it heard: both are offered, as 'Who did you mean?'", async () => {
  const { intent } = await parse('MANAGER', 'Give Layla a shout-out saying great job', shoutout('Layla', fx.users.omar));
  const q = question(intent);
  assert.equal(q.summary, 'Who did you mean?');
  assert.deepEqual(offered(intent).sort(), [fx.users.layla, fx.users.omar].sort());
});

test("another venue's people are never offered or shown, even with their id or a near spelling", async () => {
  for (const [said, heard, id] of [
    ['Give Bartholomew a shout-out', 'Bartholomew', fx.other.person],
    ['Give Bartolomew Quil a shout-out', 'Bartolomew Quil', null],
  ] as const) {
    const { intent } = await parse('MANAGER', said, shoutout(heard, id));
    const q = question(intent);
    assert.equal(q.person?.status, 'missing');
    assert.deepEqual(q.options, undefined);
    const shown = JSON.stringify(intent);
    for (const s of [VENUE_B_NAME, fx.other.person]) assert.ok(!shown.includes(s), `${said}: must not show ${s}`);
    for (const s of LEAK_STRINGS) assert.ok(!shown.includes(s) || said.includes(s), `${said}: must not show ${s}`);
  }
});
const VENUE_B_NAME = 'Bartholomew Quill';

test('a name the caller never said is not echoed back', async () => {
  const { intent } = await parse('MANAGER', 'give them a shout-out', shoutout('Zebedee', null));
  const q = question(intent);
  assert.equal(q.summary, "I couldn't find that person on your team.");
  assert.ok(!JSON.stringify(intent).includes('Zebedee'));
});

test('a staff caller asking for a shout-out is refused for the role, not asked which person', async () => {
  const { intent } = await parse('STAFF', 'Give Karim a shout-out', shoutout('Karim', null));
  const q = question(intent);
  assert.equal(q.reason, VOICE_ROLE_REFUSAL);
  assert.equal(q.options, undefined);
  assert.equal(q.person, undefined);
});

test('low confidence because of the name: still the person question, logged as low confidence', async () => {
  const { intent, voiceLogId } = await parse('MANAGER', 'Give Karim a shout-out saying great job', shoutout('Karim', null, 0.4));
  assert.equal(question(intent).summary, 'Which Karim did you mean?');
  assert.equal(offered(intent).length, 2);
  const row = await logRow(voiceLogId);
  assert.deepEqual([row.outcome, row.declineReason], ['LOW_CONFIDENCE', 'person_ambiguous:2']);
});

test('a section assignment and a new shift look the name up the same way', async () => {
  const tomorrow = new Date(`${fx.today}T00:00:00.000Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const date = tomorrow.toISOString().slice(0, 10);
  const section = await parse('MANAGER', 'Put Karim on the terrace tomorrow evening', {
    intent: 'ASSIGN_SECTION', sectionId: fx.sections.Terrace, staffId: null, targetUserName: 'Karim', shiftDate: date, period: 'PM', confidence: 0.9, summary: 'Put Karim on the terrace.',
  });
  const options = question(section.intent).options ?? [];
  assert.deepEqual(options.map((o) => (o.intent === 'ASSIGN_SECTION' ? [o.staffId, o.details?.section] : null)).sort(), [
    [fx.users.karim2, 'Terrace'],
    [fx.users.karim, 'Terrace'],
  ].sort());

  const shift = await parse('MANAGER', 'Create a server shift for Rana tomorrow from 12 to 8', {
    intent: 'CREATE_SHIFT', roleId: fx.roles.Server, userId: null, targetUserName: 'Rana', date, start: '12:00', end: '20:00', confidence: 0.9, summary: 'Create a shift.',
  });
  assert.equal(question(shift.intent).summary, "I couldn't find Rana on your team.");

  // An open shift names nobody: nothing to look up.
  const open = await parse('MANAGER', 'Add an open server shift tomorrow from 12 to 8', {
    intent: 'CREATE_SHIFT', roleId: fx.roles.Server, userId: null, date, start: '12:00', end: '20:00', confidence: 0.9, summary: 'Create an open shift.',
  });
  assert.equal(open.intent.intent, 'CREATE_SHIFT');
  assert.deepEqual(open.intent.intent === 'CREATE_SHIFT' && open.intent.details, { person: null, role: 'Server' });
});

test('not understood, with no reason from the model: human words, never the old "supported command" text', async () => {
  const { intent } = await parse('MANAGER', 'order more limes', { intent: 'UNRECOGNIZED', summary: 'Could not determine what to do.' });
  const q = question(intent);
  assert.equal(q.summary, VOICE_DIDNT_CATCH);
  assert.match(q.reason, /^Try again with who, what and when/);
  const shapeless = question((await parse('MANAGER', 'give a shout-out', { intent: 'POST_SHOUTOUT', confidence: 0.9, summary: 'x' })).intent);
  assert.equal(shapeless.summary, VOICE_DIDNT_CATCH);
});
