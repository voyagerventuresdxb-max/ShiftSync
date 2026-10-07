import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, VoiceOfflineError, VoiceTimeoutError } from '@/api/voice';
import { IPHONE_MIC_HELP, micProblem, offlineProblem, requestProblem } from './voiceErrors';

const understand = { stage: 'understand' as const, online: true };

test('a blocked microphone says so and explains how to turn it back on in iPhone Safari', () => {
  const p = micProblem(new DOMException('Permission denied', 'NotAllowedError'));
  assert.equal(p.kind, 'mic_denied');
  assert.equal(p.title, 'Microphone is off');
  assert.match(p.message, /type your command below/i);
  assert.deepEqual(p.help, IPHONE_MIC_HELP);
  assert.match(p.help!.join(' '), /Website Settings → Microphone → Allow/);
  // Older Safari names the same refusal differently.
  assert.equal(micProblem({ name: 'SecurityError' }).kind, 'mic_denied');
});

test('no microphone, or one that will not start, is told apart from a refusal', () => {
  assert.equal(micProblem(new DOMException('none', 'NotFoundError')).kind, 'mic_missing');
  assert.equal(micProblem(new DOMException('busy', 'NotReadableError')).kind, 'mic_failed');
  assert.equal(micProblem('weird').kind, 'mic_failed');
});

test('offline: nothing was sent, and the message says so for each stage', () => {
  assert.match(offlineProblem('record').message, /nothing was recorded/);
  assert.match(offlineProblem('understand').message, /Nothing was sent/);
  assert.match(offlineProblem('execute').message, /tap Confirm again/);
  const p = requestProblem(new VoiceOfflineError(false), understand);
  assert.equal(p.kind, 'offline');
  assert.equal(p.title, "You're offline");
});

test('a request that got no answer while the phone thought it was online is a dropped connection, not "offline"', () => {
  const p = requestProblem(new VoiceOfflineError(true), understand);
  assert.equal(p.kind, 'offline');
  assert.equal(p.title, "Can't reach ShiftSync");
  // After Confirm it may have landed anyway: never promise "nothing changed".
  assert.match(requestProblem(new VoiceOfflineError(true), { stage: 'execute', online: true }).message, /may still have gone through/);
  // The phone went offline in the meantime: plain offline.
  assert.equal(requestProblem(new VoiceOfflineError(true), { stage: 'understand', online: false }).title, "You're offline");
});

test('a timeout has its own message, with the seconds waited', () => {
  const p = requestProblem(new VoiceTimeoutError(25), understand);
  assert.equal(p.kind, 'timeout');
  assert.match(p.message, /within 25 seconds/);
  assert.match(p.message, /Nothing changed/);
  assert.match(requestProblem(new VoiceTimeoutError(25), { stage: 'execute', online: true }).message, /may still have gone through/);
});

test('503 is "assistant unavailable"; the server\'s own sentence wins over the generic one', () => {
  const generic = requestProblem(new ApiError('Request failed (503)', 503), understand);
  assert.equal(generic.kind, 'unavailable');
  assert.match(generic.message, /isn't available right now/);
  const own = requestProblem(new ApiError("Voice commands aren't available right now — try again later.", 503, undefined, 'voice_unavailable'), understand);
  assert.equal(own.message, "Voice commands aren't available right now — try again later.");
});

test('429 and the spend cap are "limit reached", keeping the server message', () => {
  const rate = requestProblem(new ApiError('Too many requests — please wait a few minutes and try again.', 429), understand);
  assert.equal(rate.kind, 'limit');
  assert.equal(rate.message, 'Too many requests — please wait a few minutes and try again.');
  const paused = requestProblem(new ApiError("You've used today's voice commands; they're back tomorrow.", 503, undefined, 'ai_paused'), understand);
  assert.equal(paused.kind, 'limit');
  assert.equal(requestProblem(new ApiError('Request failed (429)', 429), understand).message, "You've reached the limit for voice commands for now. Try again later.");
});

test('any other server answer keeps its message; an unknown failure gets a plain one', () => {
  assert.equal(requestProblem(new ApiError('That shift overlaps another one.', 409), { stage: 'execute', online: true }).message, 'That shift overlaps another one.');
  assert.equal(requestProblem(new Error('boom'), understand).message, 'Could not process the voice command.');
});
