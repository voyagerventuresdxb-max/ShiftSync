import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import type { GoogleGenAI } from '@google/genai';
import { createApp } from '../app.js';
import { issueSession } from '../lib/identity.js';
import { __setVoiceIntentClientForTests } from '../voice/parseIntent.js';
import { addDays, cleanupFixture, LEAK_STRINGS, seedFixture, snapshot, type Fixture } from '../../eval/voice/fixture.js';

/**
 * Run 17 F8 (made-up venue, eval/voice/fixture.ts; the model is scripted, nothing is paid): a name
 * that is nobody at the caller's venue is never silently turned into the caller's own action, nor
 * dropped. For every command that takes a person (shifts, time off, availability, swaps,
 * shout-outs, sections), "Zebulon" is "I couldn't find Zebulon on your team", asking who they
 * meant; whether the model passes the name on or leaves it out. A name that fits one person still
 * goes through, a first name two people share still asks "Which one?", staff are still refused
 * manager actions, and nothing changes in either venue.
 */

process.env.AI_MONTHLY_BUDGET_USD = '1000000';
process.env.AI_DAILY_CALL_LIMIT = '1000000';
process.env.AI_VOICE_DAILY_CALL_LIMIT = '1000000';
process.env.AI_VOICE_USER_DAILY_LIMIT = '1000000';
process.env.AI_VOICE_VENUE_DAILY_LIMIT = '1000000';

const prisma = new PrismaClient();
let fx: Fixture;
let base = '';
let server: import('node:http').Server;

before(async () => {
  fx = await seedFixture(prisma);
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

const tokens = new Map<string, string>();
async function tokenFor(userId: string): Promise<string> {
  if (!tokens.has(userId)) tokens.set(userId, (await issueSession(userId)).plainToken);
  return tokens.get(userId)!;
}

type Intent = Record<string, unknown> & { intent: string; summary?: string; reason?: string; person?: unknown; retry?: unknown; options?: unknown[]; team?: unknown[] };

/** Reads `transcript` as `userId` with the model scripted to answer `tool` with `args`. */
async function parse(userId: string, transcript: string, tool: string, args: Record<string, unknown>): Promise<Intent> {
  __setVoiceIntentClientForTests({
    models: {
      generateContent: async () => ({
        text: JSON.stringify({ tool, args, confidence: 0.95, summary: transcript, hasAdditionalRequest: false }),
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 },
      }),
    },
  } as unknown as GoogleGenAI);
  const res = await fetch(`${base}/api/voice/parse-intent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await tokenFor(userId)}` },
    body: JSON.stringify({ transcript }),
  });
  const body = (await res.json()) as { intent: Intent };
  assert.equal(res.status, 200, JSON.stringify(body));
  for (const leak of LEAK_STRINGS.filter((s) => s !== 'Bartholomew')) assert.ok(!JSON.stringify(body).includes(leak), `leaked ${leak}`);
  return body.intent;
}

const friday = () => {
  const d = new Date(`${fx.today}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + (((5 - d.getUTCDay() + 7) % 7) || 7));
  return d.toISOString().slice(0, 10);
};
const snap = () => snapshot(prisma, [fx.locationId, fx.otherLocationId]).then((s: unknown) => JSON.stringify(s));

function assertNotFound(r: Intent, heard: string, what: string) {
  assert.equal(r.intent, 'UNRECOGNIZED', `${what}: ${JSON.stringify(r)}`);
  assert.equal(r.summary, `I couldn't find ${heard} on your team.`, what);
  assert.deepEqual(r.person, { heard, status: 'missing' }, what);
}

test('F8 an unknown name, for every command that takes a person, is asked about: never the caller, never dropped, nothing changes', async () => {
  const before = await snap();
  const fri = friday();
  const tomorrow = addDays(fx.today, 1);
  const cases: [string, string, string, Record<string, unknown>][] = [
    // Time off and availability: the model passes the name on, or leaves it out.
    ['time off (name passed on)', 'Give Zebulon next Friday off.', 'REQUEST_TIME_OFF', { day: fri, person: 'Zebulon' }],
    ['time off (name left out)', 'Give Zebulon next Friday off.', 'REQUEST_TIME_OFF', { day: fri }],
    ['availability (name passed on)', 'Mark Zebulon unavailable on Friday.', 'MARK_AVAILABILITY', { day: fri, availability: 'UNAVAILABLE', person: 'Zebulon' }],
    ['availability (name left out)', 'Mark Zebulon unavailable on Friday.', 'MARK_AVAILABILITY', { day: fri, availability: 'UNAVAILABLE' }],
    // A new shift: the name passed on, or left out (it must not become an open shift).
    ['new shift (name passed on)', 'Create a Bartender shift for Zebulon tomorrow from 6pm to 2am.', 'CREATE_SHIFT', { person: 'Zebulon', role: 'Bartender', day: tomorrow, start: '6pm', end: '2am' }],
    ['new shift (name left out)', 'Create a Bartender shift for Zebulon tomorrow from 6pm to 2am.', 'CREATE_SHIFT', { role: 'Bartender', day: tomorrow, start: '6pm', end: '2am' }],
    ['section', 'Put Zebulon on the Terrace tomorrow evening.', 'ASSIGN_SECTION', { person: 'Zebulon', section: 'Terrace', day: tomorrow, period: 'PM' }],
    ['shout-out', 'Give Zebulon a shout-out saying great job.', 'POST_SHOUTOUT', { person: 'Zebulon', message: 'great job' }],
  ];
  for (const [what, transcript, tool, args] of cases) assertNotFound(await parse(fx.users.hannah, transcript, tool, args), 'Zebulon', what);
  // A swap is a staff member's own shift, covered by a colleague.
  assertNotFound(await parse(fx.users.sam, 'Ask Zebulon to cover my shift tomorrow.', 'REQUEST_SWAP', { person: 'Zebulon', day: tomorrow }), 'Zebulon', 'swap');
  assert.equal(await snap(), before, 'nothing changes in either venue');
});

test('F8 time off for an unknown name asks who they meant; a close name is offered to read again', async () => {
  const none = await parse(fx.users.hannah, 'Give Zebulon next Friday off.', 'REQUEST_TIME_OFF', { day: friday(), person: 'Zebulon' });
  assert.match(String(none.reason), /^Who did you mean\? By voice, time off and availability are for your own days only/);
  const close = await parse(fx.users.hannah, 'Give Alix next Friday off.', 'REQUEST_TIME_OFF', { day: friday(), person: 'Alix' });
  assertNotFound(close, 'Alix', 'close name');
  assert.match(String(close.reason), /^Did you mean Alex Morgan\?/);
  assert.deepEqual(close.retry, [{ person: 'Alex Morgan', text: 'Give Alex Morgan next Friday off.' }]);
  // Another venue's person is nobody here: asked about, and nothing of theirs is shown (checked in parse()).
  assertNotFound(await parse(fx.users.hannah, 'Give Bartholomew next Friday off.', 'REQUEST_TIME_OFF', { day: friday() }), 'Bartholomew', 'other venue');
});

test('F8 a teammate named in time off is "not theirs"; your own days still go through', async () => {
  const other = await parse(fx.users.hannah, 'Give Omar next Friday off.', 'REQUEST_TIME_OFF', { day: friday(), person: 'Omar' });
  assert.equal(other.summary, "That would book your own days off, not Omar's.");
  for (const [transcript, args] of [
    ['Give me next Friday off.', { day: friday(), person: 'me' }],
    ['I need next Friday off.', { day: friday() }],
    ['Hannah Clarke needs next Friday off.', { day: friday(), person: 'Hannah Clarke' }],
  ] as const) {
    const own = await parse(fx.users.hannah, transcript, 'REQUEST_TIME_OFF', args);
    assert.equal(own.intent, 'REQUEST_TIME_OFF', `${transcript}: ${JSON.stringify(own)}`);
  }
});

test('F8 a name that fits one person still goes through; a first name two people share still asks "Which one?"', async () => {
  const tomorrow = addDays(fx.today, 1);
  const layla = await parse(fx.users.hannah, 'Create a Server shift for Layla tomorrow from 5pm to 11pm.', 'CREATE_SHIFT', { role: 'Server', day: tomorrow, start: '5pm', end: '11pm' });
  assert.equal(layla.intent, 'CREATE_SHIFT', JSON.stringify(layla));
  assert.equal(layla.targetUserName, 'Layla Nasser');
  assert.equal(layla.userId, fx.users.layla);
  const open = await parse(fx.users.hannah, 'Create an open Server shift tomorrow from 5pm to 11pm.', 'CREATE_SHIFT', { role: 'Server', day: tomorrow, start: '5pm', end: '11pm' });
  assert.equal(open.intent, 'CREATE_SHIFT', JSON.stringify(open));
  assert.equal(open.userId ?? null, null, 'an open shift stays open');
  const karim = await parse(fx.users.hannah, 'Give Karim a shout-out saying great job.', 'POST_SHOUTOUT', { person: 'Karim', message: 'great job' });
  assert.equal(karim.intent, 'UNRECOGNIZED');
  assert.equal(karim.summary, 'Which Karim did you mean?');
});

test('F8 staff: manager actions with an unknown name are still refused for the role (403 at Confirm); their own time off asks who', async () => {
  const shift = await parse(fx.users.sam, 'Create a Bartender shift for Zebulon tomorrow from 6pm to 2am.', 'CREATE_SHIFT', { person: 'Zebulon', role: 'Bartender', day: addDays(fx.today, 1), start: '6pm', end: '2am' });
  assert.equal(shift.intent, 'UNRECOGNIZED');
  assert.doesNotMatch(String(shift.summary), /couldn't find/);
  const res = await fetch(`${base}/api/voice/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await tokenFor(fx.users.sam)}` },
    body: JSON.stringify({ transcript: 'x', intent: { intent: 'CREATE_SHIFT', roleId: 'r', date: addDays(fx.today, 1), start: '18:00', end: '02:00', userId: null, targetUserName: 'Zebulon', confidence: 0.95, summary: 's' } }),
  });
  assert.equal(res.status, 403);
  const own = await parse(fx.users.sam, 'Give Zebulon next Friday off.', 'REQUEST_TIME_OFF', { day: friday(), person: 'Zebulon' });
  assertNotFound(own, 'Zebulon', 'staff time off');
});
