import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { ApiError, type GoogleGenAI } from '@google/genai';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../app.js';
import { issueSession } from './identity.js';
import { __setSelfTestClientForTests, runAiSelfTest, silentWav } from './aiSelfTest.js';

// The spend cap's shared day/month counters must not throttle these (aiBudget.test.ts covers the cap).
process.env.AI_MONTHLY_BUDGET_USD = '1000000';
process.env.AI_VISION_DAILY_CALL_LIMIT = '1000000';
process.env.AI_VOICE_DAILY_CALL_LIMIT = '1000000';
delete process.env.AI_DAILY_CALL_LIMIT;

const prisma = new PrismaClient();
const TAG = '__ai-self-test__';
let locationId = '';
let server: Server;
let base = '';

interface Seen {
  model: string;
  mimeType: string | undefined;
}

function fakeClient(answer: (model: string) => unknown, seen: Seen[] = []): GoogleGenAI {
  return {
    models: {
      generateContent: async (req: { model: string; contents: { parts: { inlineData?: { mimeType: string } }[] }[] }) => {
        seen.push({ model: req.model, mimeType: req.contents[0]!.parts.find((p) => p.inlineData)?.inlineData?.mimeType });
        const out = answer(req.model);
        if (out instanceof Error) throw out;
        return out;
      },
    },
  } as unknown as GoogleGenAI;
}

const OK = { text: 'OK', usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 1 } };

before(async () => {
  const seed = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seed, 'seed data (a location) must exist to run this test');
  const location = await prisma.location.create({ data: { organizationId: seed!.organizationId, name: `${TAG} venue`, timezone: 'Asia/Dubai' } });
  locationId = location.id;
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => __setSelfTestClientForTests(null));

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await prisma.aiUsage.deleteMany({ where: { locationId } });
  await prisma.user.deleteMany({ where: { locationId } });
  await prisma.location.deleteMany({ where: { id: locationId } });
  await prisma.$disconnect();
});

async function tokenFor(systemRole: 'OWNER' | 'MANAGER' | 'STAFF'): Promise<string> {
  const u = await prisma.user.create({ data: { locationId, systemRole, fullName: `${TAG} ${systemRole}` } });
  return (await issueSession(u.id)).plainToken;
}

const post = (token: string | null) =>
  fetch(`${base}/api/ai/self-test`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} });

test('silentWav is a valid quarter-second 16 kHz mono WAV', () => {
  const wav = silentWav();
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.length, 44 + 8_000);
});

test('owner: one image call on the vision model and one audio call on the voice model; only status, model, region and latency come back', async () => {
  const seen: Seen[] = [];
  __setSelfTestClientForTests(fakeClient(() => OK, seen));
  const owner = await tokenFor('OWNER');
  const res = await post(owner);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(body).sort(), ['vision', 'voice']);
  for (const check of [body.vision!, body.voice!]) {
    assert.deepEqual(Object.keys(check).sort(), ['backend', 'latencyMs', 'location', 'model', 'ok']);
    assert.equal(check.ok, true);
    assert.equal(typeof check.latencyMs, 'number');
  }
  assert.deepEqual(seen.map((s) => s.mimeType), ['image/png', 'audio/wav']);
  const ledger = await prisma.aiUsage.findMany({ where: { locationId }, select: { feature: true, calls: true } });
  assert.deepEqual(ledger.map((r) => r.feature).sort(), ['self_test_vision', 'self_test_voice'], 'both calls went through the spend cap');
});

test('a failure names a reason code only — never the provider message', async () => {
  let calls = 0;
  // Vision runs first, then voice.
  __setSelfTestClientForTests(
    fakeClient(() =>
      ++calls === 1
        ? new ApiError({ message: 'models/secret-sounding-detail is not found', status: 404 })
        : new ApiError({ message: 'permission denied on project-detail', status: 403 }),
    ),
  );
  const result = await runAiSelfTest(locationId);
  assert.deepEqual([result.vision.ok, result.vision.reason], [false, 'model_unavailable']);
  assert.deepEqual([result.voice.ok, result.voice.reason], [false, 'access_denied']);
  assert.ok(!JSON.stringify(result).includes('detail'), 'no provider text in the result');
});

test("the voice daily limit refuses the voice check before anything is sent; vision still runs", async () => {
  const seen: Seen[] = [];
  __setSelfTestClientForTests(fakeClient(() => OK, seen));
  process.env.AI_VOICE_DAILY_CALL_LIMIT = '0';
  try {
    const result = await runAiSelfTest(locationId);
    assert.equal(result.vision.ok, true);
    assert.deepEqual([result.voice.ok, result.voice.reason, result.voice.latencyMs], [false, 'paused_today', null]);
    assert.deepEqual(seen.map((s) => s.mimeType), ['image/png']);
  } finally {
    process.env.AI_VOICE_DAILY_CALL_LIMIT = '1000000';
  }
});

test('with no Vertex project and no key, both checks say not_configured and nothing is sent', async () => {
  const saved = { key: process.env.GEMINI_API_KEY, project: process.env.GEMINI_VERTEX_PROJECT, base: process.env.GEMINI_BASE_URL };
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_VERTEX_PROJECT;
  delete process.env.GEMINI_BASE_URL;
  try {
    const result = await runAiSelfTest(locationId);
    assert.deepEqual([result.vision.reason, result.voice.reason], ['not_configured', 'not_configured']);
    assert.deepEqual([result.vision.backend, result.voice.backend], [null, null]);
  } finally {
    if (saved.key !== undefined) process.env.GEMINI_API_KEY = saved.key;
    if (saved.project !== undefined) process.env.GEMINI_VERTEX_PROJECT = saved.project;
    if (saved.base !== undefined) process.env.GEMINI_BASE_URL = saved.base;
  }
});

test('only the owner may run it: anonymous 401, manager and staff 403; nothing is sent', async () => {
  const seen: Seen[] = [];
  __setSelfTestClientForTests(fakeClient(() => OK, seen));
  assert.equal((await post(null)).status, 401);
  assert.equal((await post(await tokenFor('MANAGER'))).status, 403);
  assert.equal((await post(await tokenFor('STAFF'))).status, 403);
  assert.equal(seen.length, 0);
});

test('rate limited: the fourth run within five minutes is refused with 429', async () => {
  __setSelfTestClientForTests(fakeClient(() => OK));
  const owner = await tokenFor('OWNER');
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await post(owner)).status);
  assert.deepEqual(statuses, [200, 200, 200, 429]);
});
