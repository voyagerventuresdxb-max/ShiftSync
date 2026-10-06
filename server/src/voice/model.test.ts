import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { voiceClientOptions } from './model.js';
import { VertexCredentialsError } from '../lib/aiConfig.js';

// These tests drive the real vision/voice code against a fake Gemini client. The AI spend cap
// (lib/aiBudget.ts) has its own tests; its shared day/month counters must not throttle these.
process.env.AI_MONTHLY_BUDGET_USD = '1000000';
process.env.AI_DAILY_CALL_LIMIT = '1000000';
process.env.AI_VISION_DAILY_CALL_LIMIT = '1000000';
process.env.AI_VOICE_DAILY_CALL_LIMIT = '1000000';
process.env.AI_VOICE_USER_DAILY_LIMIT = '1000000';
process.env.AI_VOICE_VENUE_DAILY_LIMIT = '1000000';
process.env.AI_VISION_USER_DAILY_LIMIT = '1000000';
process.env.AI_VISION_VENUE_DAILY_LIMIT = '1000000';

test('voiceClientOptions: unconfigured without a key or a base URL', () => {
  assert.equal(voiceClientOptions({}), null);
  assert.equal(voiceClientOptions({ GEMINI_BASE_URL: '  ' }), null);
});

test('voiceClientOptions: a real key alone talks to the Gemini Developer API (no base URL override)', () => {
  assert.deepEqual(voiceClientOptions({ GEMINI_API_KEY: 'real-key' }), { apiKey: 'real-key', httpOptions: { timeout: 30_000 } });
});

test('voiceClientOptions: a Vertex project wins over a key — same project, region and credentials as roster vision', () => {
  const sa = JSON.stringify({ client_email: 'svc@example.iam.gserviceaccount.com', private_key: 'not-a-real-key' });
  assert.deepEqual(voiceClientOptions({ GEMINI_VERTEX_PROJECT: 'proj-v', GEMINI_API_KEY: 'real-key' }), {
    vertexai: true,
    project: 'proj-v',
    location: 'eu',
    httpOptions: { timeout: 30_000 },
  });
  assert.deepEqual(voiceClientOptions({ GEMINI_VERTEX_PROJECT: 'proj-v', GEMINI_VERTEX_LOCATION: 'us', GOOGLE_SERVICE_ACCOUNT_JSON: sa }), {
    vertexai: true,
    project: 'proj-v',
    location: 'us',
    httpOptions: { timeout: 30_000 },
    googleAuthOptions: { credentials: { client_email: 'svc@example.iam.gserviceaccount.com', private_key: 'not-a-real-key' } },
  });
});

test('voiceClientOptions: an unreadable service-account variable throws without echoing it', () => {
  assert.throws(
    () => voiceClientOptions({ GEMINI_VERTEX_PROJECT: 'proj-v', GOOGLE_SERVICE_ACCOUNT_JSON: '{not json secret-ish' }),
    (err: unknown) => err instanceof VertexCredentialsError && !err.message.includes('secret-ish'),
  );
});

test('voiceClientOptions: GEMINI_BASE_URL redirects the client and needs no real key', () => {
  assert.deepEqual(voiceClientOptions({ GEMINI_BASE_URL: 'http://127.0.0.1:4599' }), {
    apiKey: 'local-fake-gemini',
    httpOptions: { baseUrl: 'http://127.0.0.1:4599' },
  });
  assert.deepEqual(voiceClientOptions({ GEMINI_API_KEY: 'real-key', GEMINI_BASE_URL: 'http://127.0.0.1:4599' }), {
    apiKey: 'real-key',
    httpOptions: { baseUrl: 'http://127.0.0.1:4599' },
  });
});

test('transcribeAudio sends its generateContent call to GEMINI_BASE_URL, never to Google', async () => {
  const seen: { url: string; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', body });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'mark me off friday' }] }, finishReason: 'STOP' }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const previous = process.env.GEMINI_BASE_URL;
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    // Imported after the env is set: transcribe.ts builds its client once, on first use.
    const { transcribeAudio } = await import('./transcribe.js');
    assert.equal(await transcribeAudio(Buffer.from('fake audio'), 'audio/webm'), 'mark me off friday');
    assert.equal(seen.length, 1);
    assert.match(seen[0]!.url, /\/models\/[^/]+:generateContent$/);
    assert.ok(seen[0]!.body.includes(Buffer.from('fake audio').toString('base64')), 'the audio must be in the request');
  } finally {
    if (previous === undefined) delete process.env.GEMINI_BASE_URL;
    else process.env.GEMINI_BASE_URL = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
