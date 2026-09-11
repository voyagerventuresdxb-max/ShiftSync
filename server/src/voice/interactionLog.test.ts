import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outcomeAtParseTime, shouldPromptForAdditionalRequest } from './interactionLog.js';
import type { VoiceIntentResolution } from './parseIntent.js';
import type { ParsedIntent } from './intentSchema.js';

function resolution(attempted: ParsedIntent, response: ParsedIntent, hasAdditionalRequest = false): VoiceIntentResolution {
  return { attempted, response, hasAdditionalRequest };
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

test('shouldPromptForAdditionalRequest: true + a genuine pending-confirmation intent -> true', () => {
  const intent: ParsedIntent = { intent: 'MARK_AVAILABILITY', date: '2026-09-25', type: 'UNAVAILABLE', confidence: 0.9, summary: 'Mark you unavailable.' };
  assert.equal(shouldPromptForAdditionalRequest(resolution(intent, intent, true)), true);
});

test('shouldPromptForAdditionalRequest: true + a genuine QUERY_MY_SCHEDULE (answer-only) -> true', () => {
  const intent: ParsedIntent = { intent: 'QUERY_MY_SCHEDULE', confidence: 0.95, summary: 'You are working Friday 6pm-close.' };
  assert.equal(shouldPromptForAdditionalRequest(resolution(intent, intent, true)), true);
});

test('shouldPromptForAdditionalRequest: true + attempted genuinely UNRECOGNIZED -> false', () => {
  const unrecognized: ParsedIntent = { intent: 'UNRECOGNIZED', reason: 'no match', summary: 'x' };
  assert.equal(shouldPromptForAdditionalRequest(resolution(unrecognized, unrecognized, true)), false);
});

test('shouldPromptForAdditionalRequest: true + a real intent coerced to UNRECOGNIZED by the confidence gate -> false', () => {
  const attempted: ParsedIntent = { intent: 'ASSIGN_SECTION', sectionId: 's1', staffId: 'u1', shiftDate: '2026-09-25', period: 'PM', dutyLabel: null, confidence: 0.2, summary: 'Move Ahmed to the Bar section.' };
  const coercedResponse: ParsedIntent = { intent: 'UNRECOGNIZED', reason: 'not confident enough', summary: 'x' };
  assert.equal(shouldPromptForAdditionalRequest(resolution(attempted, coercedResponse, true)), false);
});

test('shouldPromptForAdditionalRequest: false -> false regardless of intent', () => {
  const intent: ParsedIntent = { intent: 'QUERY_MY_SCHEDULE', confidence: 0.95, summary: 'You are working Friday 6pm-close.' };
  assert.equal(shouldPromptForAdditionalRequest(resolution(intent, intent, false)), false);
});
