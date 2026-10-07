import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voiceStepLabel, voiceStepPosition, voiceSteps } from './voiceSteps';
import { voiceExamples } from './voiceExamples';
import { canConfirmVoiceAction } from '@/api/voice';

test('a spoken change shows every step, in order, with real words', () => {
  assert.deepEqual(voiceSteps('voice').map(voiceStepLabel), [
    'Listening… tap the mic to stop',
    'Transcribing…',
    'Understanding…',
    'Ready to confirm',
    'Doing it…',
    'Done',
  ]);
});

test('a typed command skips listening and transcribing; a read ends at its answer', () => {
  assert.deepEqual(voiceSteps('typed'), ['understanding', 'ready', 'doing', 'done']);
  assert.deepEqual(voiceSteps('voice', 'read'), ['listening', 'transcribing', 'understanding', 'answered']);
  assert.deepEqual(voiceSteps('typed', 'read'), ['understanding', 'answered']);
});

test('position is 1-based within its own sequence', () => {
  assert.deepEqual(voiceStepPosition('transcribing', 'voice'), { index: 2, total: 6 });
  assert.deepEqual(voiceStepPosition('understanding', 'typed'), { index: 1, total: 4 });
  assert.deepEqual(voiceStepPosition('answered', 'typed', 'read'), { index: 2, total: 2 });
});

test('example phrases fit the role: staff never see manager-only commands', () => {
  const staff = voiceExamples('STAFF');
  const manager = voiceExamples('MANAGER');
  assert.ok(staff.length >= 2 && staff.length <= 3);
  assert.ok(manager.length >= 2 && manager.length <= 3);
  assert.deepEqual(voiceExamples('OWNER'), manager);
  for (const phrase of staff) assert.doesNotMatch(phrase, /publish|add an? .*shift|approve|announce|shout/i, phrase);
  // An unknown role gets the narrower list.
  assert.deepEqual(voiceExamples('ADMIN'), staff);
  // Staff's time-off example is a command staff may confirm.
  assert.equal(canConfirmVoiceAction('STAFF', 'REQUEST_TIME_OFF'), true);
});
