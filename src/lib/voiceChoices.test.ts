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
