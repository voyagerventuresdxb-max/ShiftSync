import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { GoogleGenAI } from '@google/genai';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../app.js';
import { issueSession } from '../lib/identity.js';
import { __setVoiceClientForTests } from '../voice/transcribe.js';
import { VOICE_PAUSED_USER, VOICE_PAUSED_VENUE } from './voice.js';

process.env.AI_MONTHLY_BUDGET_USD = '1000000';
process.env.AI_DAILY_CALL_LIMIT = '1000000';
process.env.AI_VOICE_DAILY_CALL_LIMIT = '1000000';

const prisma = new PrismaClient();
let server: Server;
let base = '';
let orgId = '';
let token = '';
let providerCalls = 0;

before(async () => {
  const org = await prisma.organization.create({ data: { name: `__voice-quota-test__ ${Date.now()}` } });
  orgId = org.id;
  const location = await prisma.location.create({ data: { organizationId: org.id, name: org.name } });
  const staff = await prisma.user.create({ data: { locationId: location.id, fullName: 'Quota Staff', systemRole: 'STAFF' } });
  token = (await issueSession(staff.id)).plainToken;
  __setVoiceClientForTests({ models: { generateContent: async () => ((providerCalls++), { text: 'mark me off friday' }) } } as unknown as GoogleGenAI);
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  __setVoiceClientForTests(null);
  await new Promise<void>((r) => server.close(() => r()));
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

async function transcribe() {
  const form = new FormData();
  form.append('audio', new Blob([new Uint8Array(Buffer.from('fake audio'))], { type: 'audio/webm' }), 'a.webm');
  const res = await fetch(`${base}/api/voice/transcribe`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  return { status: res.status, body: (await res.json()) as { error?: string; errorCode?: string } };
}

test("a spent per-person voice quota answers its own message; nothing reaches the provider", async () => {
  process.env.AI_VOICE_USER_DAILY_LIMIT = '0';
  process.env.AI_VOICE_VENUE_DAILY_LIMIT = '1000000';
  const { status, body } = await transcribe();
  assert.equal(status, 503);
  assert.deepEqual(body, { error: VOICE_PAUSED_USER, errorCode: 'ai_paused' });
  assert.equal(providerCalls, 0);
});

test("a spent per-venue voice quota answers the venue message", async () => {
  process.env.AI_VOICE_USER_DAILY_LIMIT = '1000000';
  process.env.AI_VOICE_VENUE_DAILY_LIMIT = '0';
  const { status, body } = await transcribe();
  assert.equal(status, 503);
  assert.deepEqual(body, { error: VOICE_PAUSED_VENUE, errorCode: 'ai_paused' });
  assert.equal(providerCalls, 0);
});
