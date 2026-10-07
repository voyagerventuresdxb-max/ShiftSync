import { test } from 'node:test';
import assert from 'node:assert/strict';
import { focusInstruction, isReadingAnswer, ROSTER_READING_VERSION, ROSTER_VLM_GEMINI_SCHEMA, ROSTER_VLM_SYSTEM_PROMPT } from './vlmPrompt.js';

test('the prompt asks for every person row (no-shift people too) and dates exactly as printed — never a week of its own', () => {
  assert.match(ROSTER_VLM_SYSTEM_PROMPT, /List EVERY one/);
  assert.match(ROSTER_VLM_SYSTEM_PROMPT, /including people\s+with no times at all this week/);
  assert.match(ROSTER_VLM_SYSTEM_PROMPT, /never add a year, never assume a week/);
  assert.doesNotMatch(ROSTER_VLM_SYSTEM_PROMPT, /current (active )?week|reference week/i);
});

test('the schema lets title and role be null (the old one forced a role and an AM/PM period on every cell) and pins pages, sections and counts', () => {
  const person = ROSTER_VLM_GEMINI_SCHEMA.properties.pages.items.properties.sec.items.properties.ppl.items;
  assert.equal(person.properties.t.nullable, true);
  assert.deepEqual(person.required, ['nm', 't', 'i', 'c']);
  assert.equal(ROSTER_VLM_GEMINI_SCHEMA.properties.title.nullable, true);
  assert.deepEqual(ROSTER_VLM_GEMINI_SCHEMA.properties.pages.items.required, ['p', 'rows', 'sec', 'unread']);
  assert.match(ROSTER_READING_VERSION, /^[0-9a-f]{16}$/);
});

test('focused reads name their page (and rows); isReadingAnswer tells the two answer shapes apart', () => {
  assert.match(focusInstruction(2), /Read ONLY page 2/);
  assert.match(focusInstruction(1, { from: 21, to: null }), /person rows 21 to the last one/);
  assert.equal(isReadingAnswer({ days: [], pages: [] }), true);
  assert.equal(isReadingAnswer({ employees: [] }), false);
});
