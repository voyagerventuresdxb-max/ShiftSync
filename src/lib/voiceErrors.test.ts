import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, VoiceOfflineError, VoiceTimeoutError } from '@/api/voice';
import { IPHONE_MIC_HELP, alreadyDone, micProblem, offlineProblem, previewChanged, requestProblem } from './voiceErrors';

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

test('a repeated Confirm the server already did (409 voice_already_executed) counts as done; other 409s do not', () => {
  assert.equal(alreadyDone(new ApiError('That command has already been done.', 409, undefined, 'voice_already_executed')), true);
  assert.equal(alreadyDone(new ApiError('That shift overlaps another one.', 409)), false);
  assert.equal(alreadyDone(new VoiceTimeoutError(25)), false);
});

test('a recording refused before any model call says so plainly; a changed preview is told apart from other refusals', () => {
  const short = requestProblem(new ApiError("I didn't hear anything: the recording was empty or too short.", 422, undefined, 'voice_audio_too_short'), { stage: 'understand', online: true });
  assert.equal(short.kind, 'no_speech');
  assert.equal(short.title, "Didn't hear anything");
  const long = requestProblem(new ApiError('That recording is too long for a voice command.', 413, undefined, 'voice_audio_too_long'), { stage: 'understand', online: true });
  assert.equal(long.title, 'Recording too long');
  assert.match(long.message, /too long/);
  assert.equal(previewChanged(new ApiError('Things changed.', 409, undefined, 'voice_preview_changed')), true);
  assert.equal(previewChanged(new ApiError('Already done.', 409, undefined, 'voice_already_executed')), false);
  assert.equal(alreadyDone(new ApiError('Things changed.', 409, undefined, 'voice_preview_changed')), false);
});

test('a Confirm whose outcome is unknown, or still running, is never called "Didn\'t go through"', () => {
  const said = "I couldn't confirm whether that went through. Check the schedule, then preview it again if it's still needed.";
  const unknown = requestProblem(new ApiError(said, 409, undefined, 'voice_confirm_unknown'), { stage: 'execute', online: true });
  assert.equal(unknown.title, 'Not sure it went through');
  assert.equal(unknown.message, said);
  const running = requestProblem(new ApiError("That's still going through.", 409, undefined, 'voice_confirm_in_progress'), { stage: 'execute', online: true });
  assert.equal(running.title, 'Still going through');
});
