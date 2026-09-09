import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outcomeAtParseTime } from './interactionLog.js';
import type { VoiceIntentResolution } from './parseIntent.js';
import type { ParsedIntent } from './intentSchema.js';

function resolution(attempted: ParsedIntent, response: ParsedIntent): VoiceIntentResolution {
  return { attempted, response };
}

test('outcomeAtParseTime: an attempted UNRECOGNIZED always logs UNRECOGNIZED', () => {
  const unrecognized: ParsedIntent = { intent: 'UNRECOGNIZED', reason: 'no match', summary: 'x' };
  assert.equal(outcomeAtParseTime(resolution(unrecognized, unrecognized)), 'UNRECOGNIZED');
});

test('outcomeAtParseTime: a QUERY_MY_SCHEDULE coerced to UNRECOGNIZED by the confidence gate logs LOW_CONFIDENCE, not ANSWERED', () => {
  const attempted: ParsedIntent = { intent: 'QUERY_MY_SCHEDULE', confidence: 0.2, summary: 'You are working Friday.' };
  const coercedResponse: ParsedIntent = { intent: 'UNRECOGNIZED', reason: 'not confident enough', summary: 'x' };
  assert.equal(outcomeAtParseTime(resolution(attempted, coercedResponse)), 'LOW_CONFIDENCE');
});

test('outcomeAtParseTime: a genuine above-threshold QUERY_MY_SCHEDULE logs ANSWERED', () => {
  const intent: ParsedIntent = { intent: 'QUERY_MY_SCHEDULE', confidence: 0.95, summary: 'You are working Friday 6pm-close.' };
  assert.equal(outcomeAtParseTime(resolution(intent, intent)), 'ANSWERED');
});

test('outcomeAtParseTime: any other genuine intent logs PENDING_CONFIRMATION', () => {
  const intent: ParsedIntent = { intent: 'MARK_AVAILABILITY', date: '2026-09-25', type: 'UNAVAILABLE', confidence: 0.9, summary: 'Mark you unavailable.' };
  assert.equal(outcomeAtParseTime(resolution(intent, intent)), 'PENDING_CONFIRMATION');
});
