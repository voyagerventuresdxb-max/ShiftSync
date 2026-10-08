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
 * Voice commands that name a person, or leave out a part they need, through the real parse and
 * execute routes with a scripted model (no network). The person is looked up in the caller's own venue: someone who isn't there
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
/** The last request the scripted model received. */
let lastRequest: { config?: { temperature?: number; responseSchema?: { required?: string[] } } } = {};

async function tokenFor(role: keyof typeof CALLER): Promise<string> {
  parseIntentRateLimiter.resetKey(fx.users[CALLER[role]]);
  return (await issueSession(fx.users[CALLER[role]])).plainToken;
}

before(async () => {
  fx = await seedFixture(prisma);
  __setVoiceIntentClientForTests({
    models: {
      generateContent: async (request: typeof lastRequest) => {
        lastRequest = request;
        return { text: JSON.stringify(next), usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 } };
      },
    },
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

/** The model's answer under the tool contract: the tool, and the name exactly as heard. Never an id. */
const shoutout = (person: string, confidence = 0.92) => ({
  tool: 'POST_SHOUTOUT',
  args: { person, message: 'Great job' },
  confidence,
  summary: `Give ${person} a shoutout with this note.`,
});
const locations = () => [fx.locationId, fx.otherLocationId];
const question = (i: ParsedIntent) => {
  assert.equal(i.intent, 'UNRECOGNIZED');
  return i as Extract<ParsedIntent, { intent: 'UNRECOGNIZED' }>;
};
const offered = (i: ParsedIntent) => (question(i).options ?? []).map((o) => (o.intent === 'POST_SHOUTOUT' ? o.targetUserId : `${o.intent}?`));
const logRow = (id: string | null) => prisma.voiceInteractionLog.findUniqueOrThrow({ where: { id: id! } });
const dayAhead = (n: number) => {
  const d = new Date(`${fx.today}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const label = (iso: string) => new Date(`${iso}T00:00:00.000Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

test('a person who exists: the confirm sheet names them in full and previews the shout-out', async () => {
  const { intent } = await parse('MANAGER', 'Give Layla a shout-out saying great job', shoutout('Layla'));
  assert.equal(intent.intent, 'POST_SHOUTOUT');
  if (intent.intent !== 'POST_SHOUTOUT') return;
  assert.equal(intent.targetUserId, fx.users.layla);
  assert.equal(intent.targetUserName, PEOPLE.layla.name);
  assert.equal(intent.content, 'Great job');
  assert.deepEqual(intent.details, { person: PEOPLE.layla.name });
});

test("a person who isn't at the venue: a plain message naming them, no choices, nothing changes, and the log says why", async () => {
  const before = await snapshot(prisma, locations());
  const { intent, voiceLogId } = await parse('MANAGER', 'Give Rana a shout-out saying great job', shoutout('Rana'));
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
  const { intent } = await parse('STAFF', 'Ask Mariel to cover my shift tomorrow', { tool: 'REQUEST_SWAP', args: { person: 'Mariel', day: dayAhead(1) }, confidence: 0.9, summary: 'Ask Mariel to cover.' });
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

test('two people share the first name: "Which Karim?", one complete reading each, even when the model slips an id in', async () => {
  // The contract has no id fields; one a model adds anyway is dropped before anything is looked up.
  for (const extra of [{}, { targetUserId: fx.users.karim }]) {
    const before = await snapshot(prisma, locations());
    const raw = { ...shoutout('Karim'), ...extra, args: { ...shoutout('Karim').args, ...extra } };
    const { intent, voiceLogId } = await parse('MANAGER', 'Give Karim a shout-out saying great job', raw);
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
  const { intent, voiceLogId } = await parse('MANAGER', transcript, shoutout('Karim'));
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
    const { intent } = await parse('MANAGER', 'Give Karim a shout-out saying great job', shoutout('Karim'));
    assert.deepEqual(offered(intent).sort(), [fx.users.karim, fx.users.karim2, third.id].sort());
  } finally {
    await prisma.user.delete({ where: { id: third.id } });
  }
});

test("another venue's people are never offered or shown, even by full name or a near spelling", async () => {
  for (const [said, heard] of [
    ['Give Bartholomew a shout-out', 'Bartholomew'],
    ['Give Bartolomew Quil a shout-out', 'Bartolomew Quil'],
    ['Give Bartholomew a shout-out', 'Bartholomew Quill'],
  ] as const) {
    const { intent } = await parse('MANAGER', said, shoutout(heard));
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
  const { intent } = await parse('MANAGER', 'give them a shout-out', shoutout('Zebedee'));
  const q = question(intent);
  assert.equal(q.summary, "I couldn't find that person on your team.");
  assert.ok(!JSON.stringify(intent).includes('Zebedee'));
});

test('a staff caller asking for a shout-out is refused for the role, not asked which person', async () => {
  const { intent } = await parse('STAFF', 'Give Karim a shout-out', shoutout('Karim'));
  const q = question(intent);
  assert.equal(q.reason, VOICE_ROLE_REFUSAL);
  assert.equal(q.options, undefined);
  assert.equal(q.person, undefined);
});

test('low confidence because of the name: still the person question, logged as low confidence', async () => {
  const { intent, voiceLogId } = await parse('MANAGER', 'Give Karim a shout-out saying great job', shoutout('Karim', 0.4));
  assert.equal(question(intent).summary, 'Which Karim did you mean?');
  assert.equal(offered(intent).length, 2);
  const row = await logRow(voiceLogId);
  assert.deepEqual([row.outcome, row.declineReason], ['LOW_CONFIDENCE', 'person_ambiguous:2']);
});

test('a section assignment and a new shift look the name up the same way', async () => {
  const date = dayAhead(1);
  const section = await parse('MANAGER', 'Put Karim on the terrace tomorrow evening', {
    tool: 'ASSIGN_SECTION', args: { person: 'Karim', section: 'terrace', day: date, period: 'PM' }, confidence: 0.9, summary: 'Put Karim on the terrace.',
  });
  const options = question(section.intent).options ?? [];
  assert.deepEqual(options.map((o) => (o.intent === 'ASSIGN_SECTION' ? [o.staffId, o.details?.section] : null)).sort(), [
    [fx.users.karim2, 'Terrace'],
    [fx.users.karim, 'Terrace'],
  ].sort());

  const shift = await parse('MANAGER', 'Create a server shift for Rana tomorrow from 12 to 8', {
    tool: 'CREATE_SHIFT', args: { role: 'server', person: 'Rana', day: date, start: '12', end: '8' }, confidence: 0.9, summary: 'Create a shift.',
  });
  assert.equal(question(shift.intent).summary, "I couldn't find Rana on your team.");

  // An open shift names nobody: nothing to look up. "12 to 8" with no am/pm: noon to 8pm is the only plausible reading.
  const open = await parse('MANAGER', 'Add an open server shift tomorrow from 12 to 8', {
    tool: 'CREATE_SHIFT', args: { role: 'server', day: date, start: '12', end: '8' }, confidence: 0.9, summary: 'Create an open shift.',
  });
  assert.equal(open.intent.intent, 'UNRECOGNIZED', '12 to 8 could be noon–8pm or midnight–8am: asked');
  const readings = question(open.intent).options!.map((o) => (o.intent === 'CREATE_SHIFT' ? `${o.start}-${o.end}` : ''));
  assert.deepEqual(readings, ['12:00-20:00', '00:00-08:00'], 'the evening (later) reading first');
  const clear = await parse('MANAGER', 'Add an open server shift tomorrow from 12pm to 8pm', {
    tool: 'CREATE_SHIFT', args: { role: 'server', day: date, start: '12pm', end: '8pm' }, confidence: 0.9, summary: 'Create an open shift.',
  });
  assert.equal(clear.intent.intent, 'CREATE_SHIFT');
  assert.deepEqual(clear.intent.intent === 'CREATE_SHIFT' && [clear.intent.start, clear.intent.end, clear.intent.details], ['12:00', '20:00', { person: null, role: 'Server' }]);
});

test('not understood, with no reason from the model: human words, never the old "supported command" text', async () => {
  const { intent } = await parse('MANAGER', 'order more limes', { tool: 'UNRECOGNIZED', args: {}, summary: 'Could not determine what to do.' });
  const q = question(intent);
  assert.equal(q.summary, VOICE_DIDNT_CATCH);
  assert.match(q.reason, /^Try again with who, what and when/);
  // A recognised command with nothing filled in is asked about, not "didn't catch that".
  const shapeless = question((await parse('MANAGER', 'give a shout-out', { tool: 'POST_SHOUTOUT', args: {}, confidence: 0.9, summary: 'x' })).intent);
  assert.equal(shapeless.summary, "I've got a shout-out — who is it for, and what should it say?");
});

test('the model is asked for every key, at temperature 0, and the arguments have no ids', async () => {
  await parse('MANAGER', 'Give Layla a shout-out saying great job', shoutout('Layla'));
  assert.equal(lastRequest.config?.temperature, 0);
  const schema = lastRequest.config?.responseSchema as unknown as { required: string[]; properties: { args: { required: string[] } } };
  assert.deepEqual(schema.required.slice(0, 2), ['tool', 'args']);
  assert.ok(schema.properties.args.required.includes('end'));
  assert.ok(schema.properties.args.required.includes('section'));
  assert.ok(!schema.properties.args.required.some((k) => /id$/i.test(k)));
});

// Seen live (real model, every key optional, temperature unset): recognised commands with parts left
// out, at 0.95 confidence. They used to end in the generic "I didn't catch what you'd like to do.".
test('a new shift with no end or role: says what it has, asks for exactly those two; nothing changes', async () => {
  const date = dayAhead(3);
  const before = await snapshot(prisma, locations());
  const { intent, voiceLogId } = await parse('MANAGER', 'Create a shift on Friday from 6 p.m.', {
    tool: 'CREATE_SHIFT', args: { day: date, start: '18:00' }, summary: 'Create a shift from 18:00.', confidence: 0.95,
  });
  const q = question(intent);
  assert.equal(q.summary, `I've got a new shift on ${label(date)} from 18:00 — what time does it end, and which role?`);
  assert.deepEqual(q.incomplete, { intent: 'CREATE_SHIFT', missing: ['end', 'roleId'] });
  assert.doesNotMatch(`${q.summary} ${q.reason}`, /didn't catch|supported command/i);
  assert.equal(q.options, undefined);
  assert.equal(await snapshot(prisma, locations()), before);
  assert.equal((await logRow(voiceLogId)).declineReason, 'incomplete:CREATE_SHIFT:end,roleId');
});

test('a section move with no section or day: names the person, asks for those two ("evening" already says PM)', async () => {
  const { intent } = await parse('MANAGER', 'Put Alex on the bar tomorrow evening.', {
    tool: 'ASSIGN_SECTION', args: { person: 'Alex' }, summary: 'Put Alex on the bar tomorrow evening.', confidence: 0.95,
  });
  const q = question(intent);
  assert.equal(q.summary, `I've got a section move for ${PEOPLE.alex.name} — which section, and which day?`);
  assert.deepEqual(q.incomplete?.missing, ['sectionId', 'shiftDate']);
  assert.equal(q.person, undefined);
});

test('"Put Karim on the terrace…" missing its parts still asks which Karim; with its parts, it is the "Which Karim?" choice', async () => {
  const said = 'Put Karim on the terrace tomorrow.';
  const partial = question((await parse('MANAGER', said, { tool: 'ASSIGN_SECTION', args: { person: 'Karim' }, summary: 'Put Karim on the terrace.', confidence: 0.95 })).intent);
  assert.equal(partial.summary, `I've got a section move for Karim — which Karim (${PEOPLE.karim2.name} or ${PEOPLE.karim.name}), which section, which day, and morning or evening?`);
  assert.deepEqual(partial.person, { heard: 'Karim', status: 'ambiguous' });
  const complete = question(
    (await parse('MANAGER', said, { tool: 'ASSIGN_SECTION', args: { person: 'Karim', section: 'terrace', day: dayAhead(1), period: 'PM' }, summary: 'Put Karim on the terrace.', confidence: 0.95 })).intent,
  );
  assert.equal(complete.summary, 'Which Karim did you mean?');
  assert.equal(complete.options?.length, 2);
});

test('a shout-out to someone missing, with the note left out too: the person comes first', async () => {
  const q = question((await parse('MANAGER', 'Give Rana a shout-out', { tool: 'POST_SHOUTOUT', args: { person: 'Rana' }, confidence: 0.9, summary: 'x' })).intent);
  assert.equal(q.summary, "I couldn't find Rana on your team.");
});

test('every key sent, null where unused: a complete answer is unaffected', async () => {
  const nullArgs = Object.fromEntries(['person', 'personFull', 'newPerson', 'unassign', 'requester', 'applicant', 'section', 'role', 'template', 'day', 'endDay', 'newDay', 'at', 'start', 'end', 'start2', 'end2', 'period', 'availability', 'week', 'message', 'reason', 'duty', 'category'].map((k) => [k, null]));
  const top = { unrecognizedReason: null, hasAdditionalRequest: false, alternatives: null };
  const { intent } = await parse('MANAGER', 'Give Layla a shout-out saying great job', { ...top, tool: 'POST_SHOUTOUT', args: { ...nullArgs, person: 'Layla', message: 'Great job' }, confidence: 0.95, summary: 'Give Layla a shout-out.' });
  assert.equal(intent.intent, 'POST_SHOUTOUT');
  const staffAsked = question((await parse('STAFF', 'Give Karim a shout-out', { ...top, tool: 'POST_SHOUTOUT', args: { ...nullArgs, person: 'Karim' }, confidence: 0.9, summary: 'x' })).intent);
  assert.equal(staffAsked.reason, VOICE_ROLE_REFUSAL, 'an out-of-role command missing parts is still refused for the role, not asked about');
});

test('"Move Alex\'s shift to 7pm": the name is whose shift it is, not a new person — the person stays', async () => {
  const { intent } = await parse('MANAGER', "Move Alex's shift tomorrow to start at 7 p.m.", {
    tool: 'EDIT_SHIFT', args: { person: 'Alex', day: dayAhead(1), start: '7 p.m.' }, confidence: 0.92, summary: "Move Alex's shift to 19:00.",
  });
  assert.equal(intent.intent, 'EDIT_SHIFT');
  if (intent.intent !== 'EDIT_SHIFT') return;
  assert.equal(intent.shiftId, fx.shifts['alex+1']);
  assert.equal(intent.userId, undefined);
  assert.equal(intent.start, '19:00');
  assert.ok(!('person' in (intent.details ?? {})), 'no change of person in the preview');
});

test('"Give Alek a shout-out." with no note: Alex Morgan is still named, and offered as the same words with his name to read again', async () => {
  const said = 'Give Alek a shout-out.';
  const q = question((await parse('MANAGER', said, { tool: 'POST_SHOUTOUT', args: { person: 'Alek' }, confidence: 0.9, summary: 'Give Alek a shout-out.' })).intent);
  assert.equal(q.summary, "I couldn't find Alek on your team.");
  assert.ok(q.reason.startsWith(`Did you mean ${PEOPLE.alex.name}? If Alek is new`), q.reason);
  assert.equal(q.options, undefined, 'no complete reading to confirm: the note is missing');
  assert.deepEqual(q.retry, [{ person: PEOPLE.alex.name, text: `Give ${PEOPLE.alex.name} a shout-out.` }]);
  // Reading those words again: the person is settled, and only the note is asked for.
  const again = question((await parse('MANAGER', q.retry![0]!.text, { tool: 'POST_SHOUTOUT', args: { person: PEOPLE.alex.name }, confidence: 0.9, summary: 'x' })).intent);
  assert.equal(again.summary, `I've got a shout-out for ${PEOPLE.alex.name} — what should it say?`);
});

test('"Alix": a short sound-alike is asked about — another name (Aziz) is within two letters', async () => {
  const said = 'Give Alix a shout-out.';
  const asked = question((await parse('MANAGER', said, { tool: 'POST_SHOUTOUT', args: { person: 'Alix' }, confidence: 0.9, summary: said })).intent);
  assert.equal(asked.summary, "I couldn't find Alix on your team.");
  assert.deepEqual(asked.retry, [{ person: PEOPLE.alex.name, text: `Give ${PEOPLE.alex.name} a shout-out.` }]);
});

test('nobody close to the name said: the whole team is offered to pick from, each as a checked reading with their role', async () => {
  const before = await snapshot(prisma, locations());
  const { intent } = await parse('MANAGER', 'Give Bartholomew a shout-out saying great job', shoutout('Bartholomew'));
  const q = question(intent);
  assert.equal(q.summary, "I couldn't find Bartholomew on your team.");
  assert.equal(q.options, undefined);
  const team = q.team ?? [];
  assert.ok(team.length >= Object.keys(PEOPLE).length, `team of ${team.length}`);
  for (const o of team) {
    assert.equal(o.intent, 'POST_SHOUTOUT');
    assert.ok(o.intent === 'POST_SHOUTOUT' && Object.values(fx.users).includes(o.targetUserId), 'only this venue');
  }
  // The other venue has a Bartholomew Quill: never offered, never named.
  for (const s of LEAK_STRINGS) assert.ok(!JSON.stringify(team).includes(s) || s === 'Bartholomew', `must not show ${s}`);
  assert.ok(!JSON.stringify(team).includes('Quill'));
  assert.equal(await snapshot(prisma, locations()), before);
});

test('the same sentence from the model as summary and reason reaches the app once', async () => {
  const limes = 'I can only help with scheduling, shifts, rotas, and staff announcements.';
  const q = question((await parse('MANAGER', 'Order more limes.', { tool: 'UNRECOGNIZED', args: {}, summary: limes, unrecognizedReason: limes, confidence: null })).intent);
  assert.equal(q.summary, limes);
  assert.notEqual(q.reason, limes);
});

test('"Shukran Layla, give her a shout-out … habibi" (seen live, the model sent "her"): the shout-out is for Layla', async () => {
  const said = 'Shukran Layla, give her a shout-out for helping today habibi';
  const { intent } = await parse('MANAGER', said, { tool: 'POST_SHOUTOUT', args: { person: 'her', message: 'Thanks for helping today' }, confidence: 0.9, summary: 'Give her a shout-out.' });
  assert.equal(intent.intent, 'POST_SHOUTOUT');
  assert.deepEqual(intent.intent === 'POST_SHOUTOUT' && [intent.targetUserId, intent.targetUserName], [fx.users.layla, PEOPLE.layla.name]);
});

test('a pronoun with two names in the sentence asks who; with no name, the caller picks from the team; nothing changes', async () => {
  const before = await snapshot(prisma, locations());
  const two = question((await parse('MANAGER', 'Layla and Maricel were great tonight, give her a shout-out', shoutout('her'))).intent);
  assert.equal(two.summary, 'Who did you mean?');
  assert.deepEqual(offered(two).sort(), [fx.users.layla, fx.users.maricel].sort());
  const none = question((await parse('MANAGER', 'give her a shout-out for helping today', shoutout('her'))).intent);
  assert.equal(none.summary, "I couldn't find that person on your team.");
  assert.equal(none.options, undefined);
  assert.ok((none.team ?? []).length >= Object.keys(PEOPLE).length - 1, 'the team to pick from');
  // "Karim" is two people: the pronoun doesn't settle it.
  const shared = question((await parse('MANAGER', 'Thanks Karim, give him a shout-out', shoutout('him'))).intent);
  assert.deepEqual(offered(shared).sort(), [fx.users.karim, fx.users.karim2].sort());
  assert.equal(await snapshot(prisma, locations()), before);
});
