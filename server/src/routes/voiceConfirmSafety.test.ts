import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import type { GoogleGenAI } from '@google/genai';
import { createApp } from '../app.js';
import { issueSession } from '../lib/identity.js';
import { publishFingerprint } from '../lib/actions/rotaActions.js';
import { announcementAudience } from '../lib/actions/communicationActions.js';
import { refineAnnouncementResponse } from '../voice/parseIntent.js';
import { sweepExpiredConfirmations } from '../voice/confirmations.js';
import { __setVoiceClientForTests } from '../voice/transcribe.js';
import { addDays, cleanupFixture, seedFixture, type Fixture } from '../../eval/voice/fixture.js';

/**
 * Run 17 voice Confirm safety (made-up venue, eval/voice/fixture.ts; no model is called):
 *  - F1: publish and announcement Confirms carry what the preview showed; if it changed since,
 *    nothing is published or posted. Without it (an older app) both work as before.
 *  - F2: one confirmation key, one run (double tap, retry after a timeout, a voice log that
 *    can't be written), another person's key refused, a refusal can be retried, expiry.
 *  - F3: empty, too small and too long recordings are refused before any model call.
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
let transcribeCalls = 0;

before(async () => {
  fx = await seedFixture(prisma);
  __setVoiceClientForTests({ models: { generateContent: async () => (transcribeCalls++, { text: 'mark me off friday' }) } } as unknown as GoogleGenAI);
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  __setVoiceClientForTests(null);
  await new Promise<void>((r) => server.close(() => r()));
  await prisma.voiceConfirmation.deleteMany({ where: { locationId: { in: [fx.locationId, fx.otherLocationId] } } });
  await cleanupFixture(prisma, fx);
  await prisma.$disconnect();
});

const tokens = new Map<string, string>();
async function tokenFor(userId: string): Promise<string> {
  if (!tokens.has(userId)) tokens.set(userId, (await issueSession(userId)).plainToken);
  return tokens.get(userId)!;
}

async function execute(userId: string, intent: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/api/voice/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await tokenFor(userId)}` },
    body: JSON.stringify({ transcript: 'voice confirm safety', intent: { confidence: 0.95, summary: 'test', ...intent }, ...extra }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const mondayOf = (iso: string) => addDays(iso, -((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7));
const shoutouts = () => prisma.shoutout.count({ where: { locationId: fx.locationId } });
const shout = (note: string) => ({ intent: 'POST_SHOUTOUT', targetUserId: fx.users.alex, targetUserName: 'Alex Morgan', content: note });
const key = (tag: string) => `r17-${tag}-${Math.random().toString(36).slice(2)}-key`;

// ── F1 ────────────────────────────────────────────────────────────────────────────────────────

test('F1 publish: the week changed between preview and Confirm → refused, nothing published; unchanged → published', async () => {
  const week = mondayOf(fx.today);
  const weekStart = new Date(`${week}T00:00:00Z`);
  const previewed = await publishFingerprint(prisma, fx.locationId, weekStart);
  // A shift is added after the preview.
  const added = await prisma.shift.create({
    data: { locationId: fx.locationId, roleId: fx.roles.Server, userId: fx.users.layla, date: new Date(`${fx.today}T00:00:00Z`), startTime: new Date(`${fx.today}T14:00:00Z`), endTime: new Date(`${fx.today}T18:00:00Z`) },
  });
  const refused = await execute(fx.users.hannah, { intent: 'PUBLISH_ROTA', weekStart: week, fingerprint: previewed, counts: { shiftsChanging: 1, peopleNotified: 1 } });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.errorCode, 'voice_preview_changed');
  assert.match(String(refused.body.error), /Things changed since this preview, so nothing was sent/);
  assert.equal(await prisma.rotaPublish.count({ where: { locationId: fx.locationId, weekStart } }), 0);
  assert.equal(await prisma.shift.count({ where: { id: added.id, status: 'PUBLISHED' } }), 0);

  // A fresh preview of the same week: published.
  const fresh = await publishFingerprint(prisma, fx.locationId, weekStart);
  const ok = await execute(fx.users.hannah, { intent: 'PUBLISH_ROTA', weekStart: week, fingerprint: fresh });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(await prisma.rotaPublish.count({ where: { locationId: fx.locationId, weekStart } }), 1);
});

test('F1 publish from an older app (no fingerprint): published as before', async () => {
  const next = addDays(mondayOf(fx.today), 7);
  const res = await execute(fx.users.hannah, { intent: 'PUBLISH_ROTA', weekStart: next });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(await prisma.rotaPublish.count({ where: { locationId: fx.locationId, weekStart: new Date(`${next}T00:00:00Z`) } }), 1);
});

test('F1 announcement: the preview counts who is notified; someone joined since → refused, nothing posted; unchanged and older app → posted', async () => {
  const reading = await refineAnnouncementResponse(
    { intent: 'POST_ANNOUNCEMENT', content: 'Staff meeting Monday at 3.', confidence: 0.95, summary: 's' },
    { id: fx.users.hannah, locationId: fx.locationId },
  );
  assert.ok(reading.intent === 'POST_ANNOUNCEMENT');
  const active = await prisma.user.count({ where: { locationId: fx.locationId, isActive: true, id: { not: fx.users.hannah } } });
  assert.equal(reading.recipients, active);
  const before = await prisma.announcement.count({ where: { locationId: fx.locationId } });
  const joined = await prisma.user.create({ data: { locationId: fx.locationId, fullName: 'Nadia Newstarter', systemRole: 'STAFF' } });
  try {
    const refused = await execute(fx.users.hannah, reading as unknown as Record<string, unknown>);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.errorCode, 'voice_preview_changed');
    assert.equal(await prisma.announcement.count({ where: { locationId: fx.locationId } }), before);

    const audience = await announcementAudience(prisma, fx.locationId, fx.users.hannah);
    const ok = await execute(fx.users.hannah, { ...reading, recipients: audience.recipients, fingerprint: audience.fingerprint });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const older = await execute(fx.users.hannah, { intent: 'POST_ANNOUNCEMENT', content: 'Payday is Thursday.' });
    assert.equal(older.status, 201, JSON.stringify(older.body));
    assert.equal(await prisma.announcement.count({ where: { locationId: fx.locationId } }), before + 2);
  } finally {
    await prisma.user.update({ where: { id: joined.id }, data: { isActive: false } });
  }
});

// ── F2 ────────────────────────────────────────────────────────────────────────────────────────

test('F2 double tap: two Confirms with the same key at once run the command once', async () => {
  const k = key('double');
  const before = await shoutouts();
  const [a, b] = await Promise.all([execute(fx.users.hannah, shout('Double tap'), { idempotencyKey: k }), execute(fx.users.hannah, shout('Double tap'), { idempotencyKey: k })]);
  assert.equal(await shoutouts(), before + 1);
  const statuses = [a.status, b.status].sort();
  assert.ok(statuses[0] === 201 && (statuses[1] === 201 || statuses[1] === 409), JSON.stringify([a, b]));
});

test('F2 retry after a timeout (same key): the stored answer comes back, nothing runs twice; a new key is a new command', async () => {
  const k = key('retry');
  const before = await shoutouts();
  const first = await execute(fx.users.hannah, shout('Retry'), { idempotencyKey: k });
  const again = await execute(fx.users.hannah, shout('Retry'), { idempotencyKey: k });
  assert.equal(first.status, 201);
  assert.equal(again.status, 201);
  assert.deepEqual(again.body, first.body);
  assert.equal(await shoutouts(), before + 1);
  const other = await execute(fx.users.hannah, shout('Retry'), { idempotencyKey: key('retry-new') });
  assert.equal(other.status, 201);
  assert.equal(await shoutouts(), before + 2);
});

test('F2 a voice log that cannot be written: without a key a retry runs twice (as before); with one it runs once', async () => {
  const before = await shoutouts();
  const missingLog = { voiceLogId: 'cmzz0000no0such0voice0log0' };
  await execute(fx.users.hannah, shout('No log'), missingLog);
  await execute(fx.users.hannah, shout('No log'), missingLog);
  assert.equal(await shoutouts(), before + 2);
  const k = key('nolog');
  await execute(fx.users.hannah, shout('No log, keyed'), { ...missingLog, idempotencyKey: k });
  await execute(fx.users.hannah, shout('No log, keyed'), { ...missingLog, idempotencyKey: k });
  assert.equal(await shoutouts(), before + 3);
});

test("F2 another person's key, or another venue's, is refused and nothing runs", async () => {
  const k = key('owned');
  const before = await shoutouts();
  assert.equal((await execute(fx.users.hannah, shout('Mine'), { idempotencyKey: k })).status, 201);
  const otherPerson = await execute(fx.users.rashid, shout('Not mine'), { idempotencyKey: k });
  assert.equal(otherPerson.status, 409);
  assert.equal(otherPerson.body.errorCode, 'voice_key_conflict');
  assert.equal(await shoutouts(), before + 1);
  // A staff member at the other venue, with a command staff may run.
  const bPerson = await prisma.user.findFirst({ where: { locationId: fx.otherLocationId } });
  const marks = await prisma.availabilityMark.count({ where: { userId: bPerson!.id } });
  const otherVenue = await execute(bPerson!.id, { intent: 'MARK_AVAILABILITY', date: addDays(fx.today, 3), type: 'UNAVAILABLE' }, { idempotencyKey: k });
  assert.equal(otherVenue.status, 409);
  assert.equal(otherVenue.body.errorCode, 'voice_key_conflict');
  assert.equal(await prisma.availabilityMark.count({ where: { userId: bPerson!.id } }), marks);
});

test('F2 a Confirm refused before anything changed can be tried again with the same key', async () => {
  const k = key('refused');
  await prisma.user.update({ where: { id: fx.users.alex }, data: { isActive: false } });
  try {
    const refused = await execute(fx.users.hannah, shout('Refused first'), { idempotencyKey: k });
    assert.ok(refused.status >= 400 && refused.status < 500, JSON.stringify(refused.body));
  } finally {
    await prisma.user.update({ where: { id: fx.users.alex }, data: { isActive: true } });
  }
  const before = await shoutouts();
  const retried = await execute(fx.users.hannah, shout('Refused first'), { idempotencyKey: k });
  assert.equal(retried.status, 201, JSON.stringify(retried.body));
  assert.equal(await shoutouts(), before + 1);
});

test('F2 a key still running, or whose outcome is unknown, is refused with a clear message and nothing runs', async () => {
  const before = await shoutouts();
  const running = key('running');
  await prisma.voiceConfirmation.create({
    data: { key: running, locationId: fx.locationId, userId: fx.users.hannah, intent: 'POST_SHOUTOUT', status: 'PENDING', expiresAt: new Date(Date.now() + 60_000) },
  });
  const busy = await execute(fx.users.hannah, shout('Still running'), { idempotencyKey: running });
  assert.equal(busy.status, 409, JSON.stringify(busy.body));
  assert.equal(busy.body.errorCode, 'voice_confirm_in_progress');
  assert.match(String(busy.body.error), /still going through\. Check the shout-outs in a moment, then preview it again/);

  // The server stopped half way (a claim with no answer for over 2 minutes): its outcome is unknown.
  const stale = key('unknown');
  await prisma.voiceConfirmation.create({
    data: { key: stale, locationId: fx.locationId, userId: fx.users.hannah, intent: 'CREATE_SHIFT', status: 'PENDING', expiresAt: new Date(Date.now() + 60_000) },
  });
  await prisma.$executeRaw`UPDATE voice_confirmations SET updated_at = now() - interval '5 minutes' WHERE key = ${stale}`;
  const unknown = await execute(fx.users.hannah, shout('Unknown outcome'), { idempotencyKey: stale });
  assert.equal(unknown.status, 409, JSON.stringify(unknown.body));
  assert.equal(unknown.body.errorCode, 'voice_confirm_unknown');
  assert.equal(unknown.body.error, "I couldn't confirm whether that went through. Check the schedule, then preview it again if it's still needed.");
  assert.equal(await shoutouts(), before);
});

test('F2 keys expire after 24 hours and are swept', async () => {
  const k = key('expired');
  await prisma.voiceConfirmation.create({
    data: { key: k, locationId: fx.locationId, userId: fx.users.hannah, intent: 'POST_SHOUTOUT', status: 'DONE', responseStatus: 201, responseBody: {}, expiresAt: new Date(Date.now() - 1000) },
  });
  assert.ok((await sweepExpiredConfirmations()) >= 1);
  assert.equal(await prisma.voiceConfirmation.count({ where: { key: k } }), 0);
  const fresh = await prisma.voiceConfirmation.findFirst({ where: { locationId: fx.locationId } });
  if (fresh) assert.ok(fresh.expiresAt.getTime() - fresh.createdAt.getTime() >= 24 * 60 * 60 * 1000 - 1000);
});

// ── F3 ────────────────────────────────────────────────────────────────────────────────────────

function wav(seconds: number): Buffer {
  const rate = 16000;
  const data = Math.round(seconds * rate) * 2;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + data, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(data, 40);
  return b;
}

async function transcribe(buf: Buffer, type = 'audio/webm') {
  const form = new FormData();
  form.append('audio', new Blob([new Uint8Array(buf)], { type }), type === 'audio/wav' ? 'a.wav' : 'a.webm');
  const res = await fetch(`${base}/api/voice/transcribe`, { method: 'POST', headers: { Authorization: `Bearer ${await tokenFor(fx.users.sam)}` }, body: form });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test('F3 empty, tiny, too-short and too-long recordings are refused before any model call; a normal one is transcribed', async () => {
  const calls = transcribeCalls;
  for (const [buf, type, status, code] of [
    [Buffer.alloc(0), 'audio/webm', 422, 'voice_audio_too_short'],
    [Buffer.alloc(500, 3), 'audio/webm', 422, 'voice_audio_too_short'],
    [wav(0.1), 'audio/wav', 422, 'voice_audio_too_short'],
    [Buffer.alloc(3 * 1024 * 1024 + 1, 3), 'audio/webm', 413, 'voice_audio_too_long'],
  ] as const) {
    const res = await transcribe(buf, type);
    assert.equal(res.status, status, `${buf.length} bytes: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.errorCode, code);
    assert.match(String(res.body.error), status === 422 ? /didn't hear anything/i : /too long/i);
  }
  assert.equal(transcribeCalls, calls, 'no model call for a refused recording');
  const ok = await transcribe(wav(1.5), 'audio/wav');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(transcribeCalls, calls + 1);
});
