import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, type GoogleGenAI } from '@google/genai';
import * as parseVision from './parseVision.js';
import { parseRosterImage, VisionIngestionError, __setGeminiClientForTests } from './parseVision.js';

/**
 * Proves the canned sample roster is gone from every production path: when
 * Gemini says 429 on every retry, the manager gets a clear error — never a
 * preview full of strangers. The only mock is the Gemini client itself
 * (a real 429 cannot be produced on demand, and every real call is paid);
 * everything from the retry loop down is the real code.
 */
const SAMPLE_NAMES = ['Andrea', 'Roberto', 'Alessandro', 'Tomas', 'Sintia', 'Pratik', 'Rojina', 'Hefny', 'Bashkar', 'Gattopardo'];

function fakeClientThatAlwaysReturns(status: number): GoogleGenAI {
  return {
    models: {
      generateContent: async () => {
        throw new ApiError({ message: `simulated ${status} from Gemini`, status });
      },
    },
  } as unknown as GoogleGenAI;
}

const savedEnv = { key: process.env.GEMINI_API_KEY, mode: process.env.VLM_FALLBACK_MODE };
before(() => {
  process.env.GEMINI_API_KEY = 'test-key-never-used';
  delete process.env.VLM_FALLBACK_MODE;
});
after(() => {
  __setGeminiClientForTests(null);
  if (savedEnv.key === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = savedEnv.key;
  if (savedEnv.mode === undefined) delete process.env.VLM_FALLBACK_MODE;
  else process.env.VLM_FALLBACK_MODE = savedEnv.mode;
});

async function expectVisionError(promise: Promise<unknown>, code: parseVision.VisionErrorCode): Promise<VisionIngestionError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof VisionIngestionError, `expected a VisionIngestionError, got ${String(caught)}`);
  assert.equal(caught.code, code);
  for (const name of SAMPLE_NAMES) assert.equal(caught.message.includes(name), false, `error must not mention sample staff "${name}"`);
  return caught;
}

test('the sample roster is no longer exported from parseVision (it lives only under __fixtures__)', () => {
  assert.equal('FALLBACK_SAMPLE_RESPONSE' in parseVision, false);
});

test('image upload + Gemini 429 on every retry: rejects with vision_busy and a message that names the way out', async () => {
  __setGeminiClientForTests(fakeClientThatAlwaysReturns(429));
  const err = await expectVisionError(parseRosterImage(Buffer.from('not really a png'), 'image/png', 'roster.png', '2026-08-17'), 'vision_busy');
  assert.match(err.message, /busy/i);
  assert.match(err.message, /Excel\/CSV/);
  assert.match(err.message, /few minutes/i);
  assert.ok(err.cause instanceof ApiError && err.cause.status === 429, 'the Gemini error is kept as the cause for the server log');
});

test('scanned PDF (no text layer) + Gemini 429: also rejects with vision_busy — no local parse is possible, so no data is invented', async () => {
  __setGeminiClientForTests(fakeClientThatAlwaysReturns(429));
  await expectVisionError(parseRosterImage(Buffer.from('%PDF-1.4 garbage with no text layer'), 'application/pdf', 'scan.pdf', '2026-08-17'), 'vision_busy');
});

test('Gemini 503 on every retry is the same "busy" outcome', async () => {
  __setGeminiClientForTests(fakeClientThatAlwaysReturns(503));
  await expectVisionError(parseRosterImage(Buffer.from('png'), 'image/png', 'roster.png'), 'vision_busy');
});

test('a non-transient Gemini failure (e.g. 401) rejects with vision_failed — distinguishable from quota', async () => {
  __setGeminiClientForTests(fakeClientThatAlwaysReturns(401));
  const err = await expectVisionError(parseRosterImage(Buffer.from('png'), 'image/png', 'roster.png'), 'vision_failed');
  assert.match(err.message, /couldn't read/i);
});

test('VLM_FALLBACK_MODE=sample no longer summons the sample: it behaves like auto and still fails clearly', async () => {
  process.env.VLM_FALLBACK_MODE = 'sample';
  try {
    __setGeminiClientForTests(fakeClientThatAlwaysReturns(429));
    await expectVisionError(parseRosterImage(Buffer.from('png'), 'image/png', 'roster.png'), 'vision_busy');
  } finally {
    delete process.env.VLM_FALLBACK_MODE;
  }
});

test('VLM_FALLBACK_MODE=off surfaces the same coded error', async () => {
  process.env.VLM_FALLBACK_MODE = 'off';
  try {
    __setGeminiClientForTests(fakeClientThatAlwaysReturns(429));
    await expectVisionError(parseRosterImage(Buffer.from('png'), 'image/png', 'roster.png'), 'vision_busy');
  } finally {
    delete process.env.VLM_FALLBACK_MODE;
  }
});

test('no Gemini credentials at all: an image rejects with vision_unconfigured instead of sample data', async () => {
  const key = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    __setGeminiClientForTests(null);
    const err = await expectVisionError(parseRosterImage(Buffer.from('png'), 'image/png', 'roster.png'), 'vision_unconfigured');
    assert.match(err.message, /Excel\/CSV/);
  } finally {
    process.env.GEMINI_API_KEY = key;
  }
});
