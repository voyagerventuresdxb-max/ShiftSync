import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, type GoogleGenAI } from '@google/genai';
import {
  transcribeAudio,
  VoiceTranscriptionError,
  geminiMimeTypeFor,
  classifyGeminiFailure,
  __setVoiceClientForTests,
} from './transcribe.js';

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

/**
 * The only mock is the Gemini client (a real 400/429 cannot be produced on
 * demand and every real call is paid). Everything from the mimetype
 * relabelling to the error classification is the real code.
 */
const savedKey = process.env.GEMINI_API_KEY;
before(() => {
  process.env.GEMINI_API_KEY = 'test-key-never-used';
});
after(() => {
  __setVoiceClientForTests(null);
  if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = savedKey;
});

test('geminiMimeTypeFor: iPhone audio/mp4 (with or without codec params) is sent as video/mp4; others pass through bare', () => {
  assert.equal(geminiMimeTypeFor('audio/mp4'), 'video/mp4');
  assert.equal(geminiMimeTypeFor('audio/mp4;codecs=mp4a.40.2'), 'video/mp4');
  assert.equal(geminiMimeTypeFor('audio/x-m4a'), 'video/mp4');
  assert.equal(geminiMimeTypeFor('audio/ogg;codecs=opus'), 'audio/ogg');
  assert.equal(geminiMimeTypeFor('audio/wav'), 'audio/wav');
  assert.equal(geminiMimeTypeFor('audio/webm'), 'audio/webm');
});

test('classifyGeminiFailure: 400/415 are a format rejection; 429/5xx/401 are "unavailable"', () => {
  assert.equal(classifyGeminiFailure(new ApiError({ message: 'Unsupported MIME type', status: 400 })), 'format_rejected');
  assert.equal(classifyGeminiFailure(new ApiError({ message: 'x', status: 415 })), 'format_rejected');
  assert.equal(classifyGeminiFailure(new ApiError({ message: 'quota', status: 429 })), 'unavailable');
  assert.equal(classifyGeminiFailure(new ApiError({ message: 'overloaded', status: 503 })), 'unavailable');
  assert.equal(classifyGeminiFailure(new ApiError({ message: 'bad key', status: 401 })), 'unavailable');
});

test('transcribeAudio puts video/mp4 on the inlineData part when the upload was audio/mp4', async () => {
  let seenMime: string | undefined;
  __setVoiceClientForTests({
    models: {
      generateContent: async (req: { contents: { parts: { inlineData?: { mimeType: string } }[] }[] }) => {
        seenMime = req.contents[0]!.parts.find((p) => p.inlineData)?.inlineData?.mimeType;
        return { text: 'move ahmed to section two' };
      },
    },
  } as unknown as GoogleGenAI);

  const transcript = await transcribeAudio(Buffer.from('fake aac bytes'), 'audio/mp4;codecs=mp4a.40.2');
  assert.equal(transcript, 'move ahmed to section two');
  assert.equal(seenMime, 'video/mp4');
});

async function expectFailure(kind: VoiceTranscriptionError['kind']): Promise<VoiceTranscriptionError> {
  let caught: unknown;
  try {
    await transcribeAudio(Buffer.from('bytes'), 'audio/mp4');
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof VoiceTranscriptionError, `expected VoiceTranscriptionError, got ${String(caught)}`);
  assert.equal(caught.kind, kind);
  return caught;
}

test('a Gemini 400 becomes a format_rejected error that records both the original and the sent mimetype', async () => {
  __setVoiceClientForTests({
    models: { generateContent: async () => { throw new ApiError({ message: 'Unsupported MIME type: video/mp4', status: 400 }); } },
  } as unknown as GoogleGenAI);
  const err = await expectFailure('format_rejected');
  assert.match(err.message, /mime=audio\/mp4 sent-as=video\/mp4/);
});

test('a Gemini 429 becomes an "unavailable" error — distinguishable from a format bug', async () => {
  __setVoiceClientForTests({
    models: { generateContent: async () => { throw new ApiError({ message: 'Resource exhausted', status: 429 }); } },
  } as unknown as GoogleGenAI);
  await expectFailure('unavailable');
});

test('a Gemini 404 (retired or misspelled VOICE_MODEL) becomes model_unavailable and is logged loudly with the model ID', async () => {
  assert.equal(classifyGeminiFailure(new ApiError({ message: 'not found', status: 404 })), 'model_unavailable');
  const savedModel = process.env.VOICE_MODEL;
  process.env.VOICE_MODEL = 'gemini-retired-example';
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
  try {
    __setVoiceClientForTests({
      models: { generateContent: async () => { throw new ApiError({ message: 'models/x is not found', status: 404 }); } },
    } as unknown as GoogleGenAI);
    await expectFailure('model_unavailable');
  } finally {
    console.error = original;
    if (savedModel === undefined) delete process.env.VOICE_MODEL;
    else process.env.VOICE_MODEL = savedModel;
  }
  const line = logged.find((l) => l.includes('MODEL NOT AVAILABLE'));
  assert.ok(line, 'a loud MODEL NOT AVAILABLE line is logged');
  assert.match(line!, /"gemini-retired-example"/);
  assert.ok(!line!.includes('test-key-never-used'), 'never logs the key');
});

test('with no Vertex project, no key and no fake base URL, transcription fails as not_configured', async () => {
  const saved = { key: process.env.GEMINI_API_KEY, project: process.env.GEMINI_VERTEX_PROJECT, base: process.env.GEMINI_BASE_URL };
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_VERTEX_PROJECT;
  delete process.env.GEMINI_BASE_URL;
  __setVoiceClientForTests(null);
  try {
    await expectFailure('not_configured');
  } finally {
    process.env.GEMINI_API_KEY = saved.key ?? 'test-key-never-used';
    if (saved.project !== undefined) process.env.GEMINI_VERTEX_PROJECT = saved.project;
    if (saved.base !== undefined) process.env.GEMINI_BASE_URL = saved.base;
  }
});

test('a refusal by the daily voice limit is "paused" and names the limit; the provider is never called', async () => {
  const savedLimit = process.env.AI_VOICE_DAILY_CALL_LIMIT;
  process.env.AI_VOICE_DAILY_CALL_LIMIT = '0';
  let called = false;
  __setVoiceClientForTests({ models: { generateContent: async () => { called = true; return { text: 'x' }; } } } as unknown as GoogleGenAI);
  try {
    const err = await expectFailure('paused');
    assert.equal(err.limit, 'daily_calls');
    assert.equal(called, false);
  } finally {
    if (savedLimit === undefined) delete process.env.AI_VOICE_DAILY_CALL_LIMIT;
    else process.env.AI_VOICE_DAILY_CALL_LIMIT = savedLimit;
  }
});

test('a clip with no clear speech becomes "no_speech", never a command built from the vocabulary list', async () => {
  let instruction = '';
  for (const answer of ['NO_SPEECH', 'NO_SPEECH.', '"no_speech"']) {
    __setVoiceClientForTests({
      models: {
        generateContent: async (req: { contents: { parts: { text?: string }[] }[] }) => {
          instruction = req.contents[0]!.parts.find((p) => p.text)?.text ?? '';
          return { text: answer };
        },
      },
    } as unknown as GoogleGenAI);
    let caught: unknown;
    try {
      await transcribeAudio(Buffer.from('silence'), 'audio/wav', 'Alex Example, Bar, Terrace');
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof VoiceTranscriptionError && caught.kind === 'no_speech', `answer ${answer}`);
  }
  assert.match(instruction, /no clear human speech .* return exactly NO_SPEECH/);
  assert.match(instruction, /never add a name or term that wasn't said/);
});
