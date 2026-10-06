import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ParsedIntent } from '@/api/voice';
import { choosableFor } from './voiceChoices';

const approve: ParsedIntent = { intent: 'APPROVE_SWAP', swapRequestId: 's1', confidence: 0.4, summary: 'Approve.' };
const decline: ParsedIntent = { intent: 'DECLINE_SWAP', swapRequestId: 's1', confidence: 0.4, summary: 'Decline.' };
const swap: ParsedIntent = { intent: 'REQUEST_SWAP', shiftId: 'x', targetUserId: 'u', targetUserName: 'U', reason: null, confidence: 0.4, summary: 'Swap.' };
const query: ParsedIntent = { intent: 'QUERY_MY_SCHEDULE', confidence: 0.4, summary: 'You work Friday.' };
const unsure = (options: ParsedIntent[]): ParsedIntent => ({ intent: 'UNRECOGNIZED', reason: 'Not sure.', summary: 'Which did you mean?', options });

test('a manager keeps every choice they can confirm', () => {
  assert.deepEqual(choosableFor('MANAGER', unsure([approve, decline])), unsure([approve, decline]));
});

test("a staff member never sees a manager action as a choice; one left is no choice at all", () => {
  const shown = choosableFor('STAFF', unsure([swap, approve, decline]));
  assert.equal(shown.intent, 'UNRECOGNIZED');
  assert.equal('options' in shown ? shown.options : undefined, undefined);
  assert.notEqual(shown.summary, 'Which did you mean?');
});

test('questions and non-answers are never choices', () => {
  const shown = choosableFor('MANAGER', unsure([query, approve]));
  assert.equal('options' in shown ? shown.options : undefined, undefined);
});

test('a confident answer passes through untouched', () => {
  assert.equal(choosableFor('STAFF', approve), approve);
});

const shoutout = (id: string, name: string): ParsedIntent => ({
  intent: 'POST_SHOUTOUT', targetUserId: id, targetUserName: name, content: 'Great job', confidence: 0.9, summary: `Give ${name} a shout-out.`, details: { person: name },
});

test('a question about a person keeps even a single suggestion', () => {
  const missing: ParsedIntent = {
    intent: 'UNRECOGNIZED', reason: 'Did you mean this person?', summary: "I couldn't find Mariel on your team.",
    person: { heard: 'Mariel', status: 'missing' }, options: [shoutout('m1', 'Maricel Dizon')],
  };
  assert.deepEqual(choosableFor('MANAGER', missing), missing);
});

test('a person question whose choices this role cannot confirm keeps the question, with a reason that no longer points at them', () => {
  const which: ParsedIntent = {
    intent: 'UNRECOGNIZED', reason: 'Pick one.', summary: 'Which Karim did you mean?',
    person: { heard: 'Karim', status: 'ambiguous' }, options: [shoutout('k1', 'Karim Saleh'), shoutout('k2', 'Karim Aziz')],
  };
  const shown = choosableFor('STAFF', which);
  assert.ok(shown.intent === 'UNRECOGNIZED');
  assert.equal(shown.summary, 'Which Karim did you mean?');
  assert.deepEqual(shown.person, { heard: 'Karim', status: 'ambiguous' });
  assert.equal(shown.options, undefined);
  assert.equal(shown.reason, 'Say their full name and try again.');
});
