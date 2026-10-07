import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, MediaResolution, ThinkingLevel, type GoogleGenAI } from '@google/genai';
import { visionConfig } from '../lib/aiConfig.js';
import { MAX_OUTPUT_TOKENS } from '../lib/aiBudget.js';
import {
  GeminiVisionProvider,
  MockVisionProvider,
  VisionProviderError,
  billedOutputTokens,
  getVisionProvider,
  __setVisionProviderForTests,
  type VisionInput,
} from './visionProvider.js';

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

/** A fake SDK client: answers each call from `script` in order (a status number throws an ApiError). */
function fakeClient(script: (number | { text: string; usage?: { promptTokenCount: number; candidatesTokenCount: number }; finishReason?: string })[]) {
  const calls: { model: string; parts: unknown[]; config?: Record<string, unknown> }[] = [];
  const client = {
    models: {
      generateContent: async (req: { model: string; contents: { parts: unknown[] }[]; config?: Record<string, unknown> }) => {
        calls.push({ model: req.model, parts: req.contents[0]!.parts, config: req.config });
        const step = script[Math.min(calls.length - 1, script.length - 1)]!;
        if (typeof step === 'number') throw new ApiError({ message: `simulated ${step}`, status: step });
        return { text: step.text, usageMetadata: step.usage, candidates: [{ finishReason: step.finishReason ?? 'STOP' }] };
      },
    },
  } as unknown as GoogleGenAI;
  return { client, calls };
}

const config = visionConfig({ GEMINI_VERTEX_PROJECT: 'proj', VLM_MODEL: 'primary-m', VLM_FALLBACK_MODEL: 'fallback-m' });
const noWait = async () => {};
const image: VisionInput = { kind: 'file', data: Buffer.from('png-bytes'), mimeType: 'image/png', originalFilename: 'r.png', weekStart: '2026-08-17' };

async function captureErrors<T>(fn: () => Promise<T>): Promise<{ result?: T; error?: unknown; logs: string[] }> {
  const logs: string[] = [];
  const saved = { error: console.error, warn: console.warn };
  console.error = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
  console.warn = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
  try {
    return { result: await fn(), logs };
  } catch (error) {
    return { error, logs };
  } finally {
    console.error = saved.error;
    console.warn = saved.warn;
  }
}

test('Vertex config: the provider names itself vertex-gemini and reports the EU location', () => {
  const p = new GeminiVisionProvider(visionConfig({ GEMINI_VERTEX_PROJECT: 'proj' }));
  assert.equal(p.name, 'vertex-gemini');
  assert.equal(p.region, 'eu');
  assert.equal(new GeminiVisionProvider(visionConfig({ GEMINI_API_KEY: 'k' })).name, 'gemini-developer-api');
});

test('success: returns the raw JSON, the model that answered and token usage; an image goes as inlineData', async () => {
  const { client, calls } = fakeClient([{ text: '{"employees":[]}', usage: { promptTokenCount: 812, candidatesTokenCount: 95 } }]);
  const out = await new GeminiVisionProvider(config, { client, wait: noWait }).readRoster(image);
  assert.deepEqual(out, { raw: '{"employees":[]}', model: 'primary-m', usage: { promptTokens: 812, outputTokens: 95 } });
  assert.equal(calls.length, 1);
  assert.ok(JSON.stringify(calls[0]!.parts).includes('"inlineData"'));
});

test('every call caps its output and asks for the lowest thinking level; billed output counts thinking tokens', async () => {
  const { client, calls } = fakeClient([{ text: '{}' }]);
  await new GeminiVisionProvider(config, { client, wait: noWait }).readRoster(image);
  assert.equal(calls[0]!.config?.maxOutputTokens, MAX_OUTPUT_TOKENS.roster_vision);
  assert.deepEqual(calls[0]!.config?.thinkingConfig, { thinkingLevel: ThinkingLevel.MINIMAL });
  assert.equal(billedOutputTokens({ candidatesTokenCount: 90, thoughtsTokenCount: 10 }), 100);
  assert.equal(billedOutputTokens({ candidatesTokenCount: 90 }), 90);
  assert.equal(billedOutputTokens({ promptTokenCount: 5 }), null, 'no output count: charged the conservative reservation');
});

test('a grid is sent as text — and never with a reference week, which biased the model towards the upload week', async () => {
  const { client, calls } = fakeClient([{ text: '{}' }]);
  await new GeminiVisionProvider(config, { client, wait: noWait }).readRoster({ kind: 'grid', text: 'Name\tMon', originalFilename: 'g.csv', weekStart: '2026-08-17' });
  const sent = JSON.stringify(calls[0]!.parts);
  assert.ok(sent.includes('Name\\tMon') && !sent.includes('inlineData'));
  assert.ok(!sent.includes('2026-08-17'), 'no week is suggested to the model');
  assert.equal(calls[0]!.config?.mediaResolution, undefined, 'text input has no media to resolve');
});

test('a PDF goes natively at high media resolution with its own text layer, page by page; a focused read names its page', async () => {
  const { client, calls } = fakeClient([{ text: '{}' }]);
  const pdf: VisionInput = { kind: 'file', data: Buffer.from('%PDF'), mimeType: 'application/pdf', originalFilename: 'r.pdf', pageTexts: ['Test Alpha | 9-17', 'Test Beta | 10-18'], focus: { page: 2 }, strict: true };
  await new GeminiVisionProvider(config, { client, wait: noWait }).readRoster(pdf);
  assert.equal(calls[0]!.config?.mediaResolution, MediaResolution.MEDIA_RESOLUTION_HIGH);
  const sent = JSON.stringify(calls[0]!.parts);
  assert.ok(sent.includes('"inlineData"') && sent.includes('application/pdf'));
  assert.ok(sent.includes('Read ONLY page 2'), 'the focused page is named');
  assert.ok(sent.includes('Test Beta | 10-18') && !sent.includes('Test Alpha'), 'only that page\'s text layer is sent');
  assert.ok(sent.includes('Count the person rows again'), 'the stricter second read asks for a recount');
});

test('an answer cut off at the output cap is marked truncated (never trusted as complete)', async () => {
  const { client } = fakeClient([{ text: '{"pages":[', finishReason: 'MAX_TOKENS' }]);
  const out = await new GeminiVisionProvider(config, { client, wait: noWait }).readRoster(image);
  assert.equal(out.truncated, true);
});

test('a read with too little time left before its deadline starts no attempt; each attempt\'s timeout fits the deadline', async () => {
  const late = fakeClient([{ text: '{}' }]);
  const { error } = await captureErrors(() => new GeminiVisionProvider(config, { client: late.client, wait: noWait }).readRoster({ ...image, deadline: Date.now() + 2000 }));
  assert.equal(late.calls.length, 0);
  assert.ok(error instanceof VisionProviderError);
  const timely = fakeClient([{ text: '{}' }]);
  await new GeminiVisionProvider(config, { client: timely.client, wait: noWait }).readRoster({ ...image, deadline: Date.now() + 40_000 });
  const timeout = (timely.calls[0]!.config?.httpOptions as { timeout: number }).timeout;
  assert.ok(timeout <= 40_000 && timeout > 30_000, `timeout ${timeout}`);
});

test('a timed-out attempt (504) is retried on the fallback model', async () => {
  const { client, calls } = fakeClient([504, { text: '{"ok":1}' }]);
  const { result } = await captureErrors(() => new GeminiVisionProvider(config, { client, wait: noWait }).readRoster(image));
  assert.equal(result?.model, 'fallback-m');
  assert.equal(calls.length, 2);
});

test('a retired primary (404) is logged loudly with its ID and the fallback model answers', async () => {
  const { client, calls } = fakeClient([404, { text: '{"ok":1}' }]);
  const { result, logs } = await captureErrors(() => new GeminiVisionProvider(config, { client, wait: noWait }).readRoster(image));
  assert.equal(result?.model, 'fallback-m');
  assert.deepEqual(calls.map((c) => c.model), ['primary-m', 'fallback-m']);
  const line = logs.find((l) => l.includes('MODEL NOT AVAILABLE'));
  assert.ok(line && line.includes('"primary-m"') && line.includes('"eu"'), line ?? 'no MODEL NOT AVAILABLE line');
});

test('404 on every model → model_unavailable (not "busy", not "failed")', async () => {
  const { client, calls } = fakeClient([404]);
  const { error } = await captureErrors(() => new GeminiVisionProvider(config, { client, wait: noWait }).readRoster(image));
  assert.ok(error instanceof VisionProviderError && error.kind === 'model_unavailable');
  assert.equal(calls.length, 3);
});

test('429/503 on every attempt → busy, after the primary and two fallback tries with back-off', async () => {
  const waits: number[] = [];
  const { client, calls } = fakeClient([429, 503, 429]);
  const { error } = await captureErrors(() =>
    new GeminiVisionProvider(config, { client, wait: async (ms) => void waits.push(ms) }).readRoster(image),
  );
  assert.ok(error instanceof VisionProviderError && error.kind === 'busy');
  assert.deepEqual(calls.map((c) => c.model), ['primary-m', 'fallback-m', 'fallback-m']);
  assert.deepEqual(waits, [1000, 2000]);
});

test('any other failure (401) → failed at once, no retry; an empty answer is failed too', async () => {
  const auth = fakeClient([401]);
  const { error } = await captureErrors(() => new GeminiVisionProvider(config, { client: auth.client, wait: noWait }).readRoster(image));
  assert.ok(error instanceof VisionProviderError && error.kind === 'failed');
  assert.equal(auth.calls.length, 1);
  const empty = fakeClient([{ text: '' }]);
  const second = await captureErrors(() => new GeminiVisionProvider(config, { client: empty.client, wait: noWait }).readRoster(image));
  assert.ok(second.error instanceof VisionProviderError && second.error.kind === 'failed');
});

test('getVisionProvider: null when not configured; a test override wins; the mock records its calls', async () => {
  const saved = { p: process.env.GEMINI_VERTEX_PROJECT, k: process.env.GEMINI_API_KEY };
  delete process.env.GEMINI_VERTEX_PROJECT;
  delete process.env.GEMINI_API_KEY;
  try {
    assert.equal(getVisionProvider(), null);
    const mock = new MockVisionProvider('{"employees":[]}');
    __setVisionProviderForTests(mock);
    assert.equal(getVisionProvider(), mock);
    const out = await mock.readRoster(image);
    assert.equal(out.raw, '{"employees":[]}');
    assert.equal(mock.calls.length, 1);
  } finally {
    __setVisionProviderForTests(null);
    if (saved.p !== undefined) process.env.GEMINI_VERTEX_PROJECT = saved.p;
    if (saved.k !== undefined) process.env.GEMINI_API_KEY = saved.k;
  }
});
