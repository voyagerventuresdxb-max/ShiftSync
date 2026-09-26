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
