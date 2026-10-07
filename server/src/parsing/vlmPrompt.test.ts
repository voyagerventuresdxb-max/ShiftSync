import { test } from 'node:test';
import assert from 'node:assert/strict';
import { columnsToRows, focusInstruction, isColumnAnswer, isReadingAnswer, ROSTER_READING_VERSION, ROSTER_VLM_COLUMN_PROMPT, ROSTER_VLM_COLUMN_SCHEMA, ROSTER_VLM_GEMINI_SCHEMA, ROSTER_VLM_SYSTEM_PROMPT } from './vlmPrompt.js';

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

test('both framings: text wins over colour, every person row is listed (titles are never names), and a row is cut off only at the page edge', () => {
  for (const prompt of [ROSTER_VLM_SYSTEM_PROMPT, ROSTER_VLM_COLUMN_PROMPT]) {
    assert.match(prompt, /TEXT always wins over its colour/);
    assert.match(prompt, /Only a cell with NO text at all/);
    assert.match(prompt, /titles, never names/);
    assert.match(prompt, /"Total staff …"/);
    assert.match(prompt, /cut off only when the page edge actually cuts through it/);
  }
  assert.match(ROSTER_VLM_COLUMN_PROMPT, /COLUMN BY COLUMN/);
});

test('the column framing has its own schema; columnsToRows lays it out person by person', () => {
  assert.deepEqual(ROSTER_VLM_COLUMN_SCHEMA.properties.pages.items.required, ['p', 'rows', 'ppl', 'cols', 'unread']);
  const col = {
    title: null,
    days: ['Mon 17/08', 'Tue 18/08'],
    key: [],
    pages: [{ p: 1, rows: 2, ppl: [{ i: 1, nm: 'Test Alpha', t: null, h: 'WAITERS' }, { i: 2, nm: 'Test Beta', t: null, h: 'WAITERS' }], cols: [{ d: 0, c: [{ i: 2, x: '9-17' }] }, { d: 1, c: [{ i: 1, x: 'OFF' }] }], unread: [] }],
  };
  assert.equal(isColumnAnswer(col), true);
  assert.equal(isColumnAnswer({ days: [], pages: [{ p: 1, rows: 0, sec: [], unread: [] }] }), false);
  assert.deepEqual(columnsToRows(col).pages[0]!.sec, [{ h: 'WAITERS', n: 2, ppl: [{ nm: 'Test Alpha', t: null, i: 1, c: ['', 'OFF'] }, { nm: 'Test Beta', t: null, i: 2, c: ['9-17', ''] }] }]);
});
