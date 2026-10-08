import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { canConfirmVoiceIntent } from '../../shared/voiceIntents';
import {
  VOICE_TIMEOUT_MS,
  VoiceOfflineError,
  VoiceTimeoutError,
  isReadIntent,
  parseVoiceIntent,
  voiceAnswer,
  voiceTimeoutMs,
  type ParsedIntent,
} from './voice';

const realFetch = globalThis.fetch;
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const g = globalThis as { __shiftsyncVoiceTimeoutMs?: number };

function setOnline(onLine: boolean) {
  Object.defineProperty(globalThis, 'navigator', { value: { onLine }, configurable: true, writable: true });
}

afterEach(() => {
  globalThis.fetch = realFetch;
  delete g.__shiftsyncVoiceTimeoutMs;
  if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
  else delete (globalThis as { navigator?: unknown }).navigator;
});

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('a typed command is sent as { transcript, source: "typed" }; a transcript defaults to "voice"', async () => {
  setOnline(true);
  const bodies: unknown[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return ok({ transcript: 'x', intent: { intent: 'UNRECOGNIZED', reason: '', summary: '' }, voiceLogId: null, hasAdditionalRequest: false });
  }) as typeof fetch;
  await parseVoiceIntent('t', "Who's working tonight?", 'typed');
  await parseVoiceIntent('t', 'Publish next week');
  assert.deepEqual(bodies, [
    { transcript: "Who's working tonight?", source: 'typed' },
    { transcript: 'Publish next week', source: 'voice' },
  ]);
});

test('offline: nothing is sent at all', async () => {
  setOnline(false);
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return ok({});
  }) as typeof fetch;
  await assert.rejects(parseVoiceIntent('t', 'hello', 'typed'), (err) => err instanceof VoiceOfflineError && err.sent === false);
  assert.equal(calls, 0);
});

test('a fetch TypeError (no answer at all) is a connection problem, not a server error', async () => {
  setOnline(true);
  globalThis.fetch = (async () => {
    throw new TypeError('Failed to fetch');
  }) as typeof fetch;
  await assert.rejects(parseVoiceIntent('t', 'hello'), (err) => err instanceof VoiceOfflineError && err.sent === true);
});

test('the client stops waiting after the voice timeout (25 s; injectable for tests) and aborts the request', async () => {
  assert.equal(voiceTimeoutMs(), VOICE_TIMEOUT_MS);
  assert.equal(VOICE_TIMEOUT_MS, 25_000);
  setOnline(true);
  g.__shiftsyncVoiceTimeoutMs = 30;
  let aborted = false;
  globalThis.fetch = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    })) as typeof fetch;
  await assert.rejects(parseVoiceIntent('t', 'hello'), (err) => err instanceof VoiceTimeoutError);
  assert.equal(aborted, true);
});

test('reads carry an answer and are never confirmable actions; DECLINED is neither', () => {
  const read: ParsedIntent = { intent: 'WHO_IS_WORKING', answer: { title: 'Working tonight', items: [], emptyText: 'Nobody.' }, confidence: 0.9, summary: 'x' };
  assert.equal(isReadIntent(read), true);
  assert.equal(voiceAnswer(read)?.emptyText, 'Nobody.');
  const legacy: ParsedIntent = { intent: 'QUERY_MY_SCHEDULE', confidence: 0.9, summary: 'You have no shifts.' };
  assert.equal(isReadIntent(legacy), true);
  assert.equal(voiceAnswer(legacy), null);
  const declined: ParsedIntent = { intent: 'DECLINED', category: 'payroll_wps', message: 'No.', screen: null, summary: 'No.', confidence: 1 };
  assert.equal(isReadIntent(declined), false);
  assert.equal(voiceAnswer(declined), null);
});

test('v2 changes (shared role lists): staff may request time off; only managers and owners may cancel a shift', () => {
  assert.equal(canConfirmVoiceIntent('STAFF', 'REQUEST_TIME_OFF'), true);
  assert.equal(canConfirmVoiceIntent('STAFF', 'CANCEL_SHIFT'), false);
  assert.equal(canConfirmVoiceIntent('MANAGER', 'CANCEL_SHIFT'), true);
  assert.equal(canConfirmVoiceIntent('OWNER', 'REQUEST_TIME_OFF'), true);
  assert.equal(canConfirmVoiceIntent('STAFF', 'PUBLISH_ROTA'), false);
  assert.equal(canConfirmVoiceIntent('MANAGER', 'PUBLISH_ROTA'), true);
  assert.equal(canConfirmVoiceIntent('ADMIN', 'REQUEST_TIME_OFF'), false);
});
