import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editedRanges, shiftTypeFor, typeTimes } from '../../../src/voice/shiftTiming.js';

/** Naming a venue shift type by voice, and the ranges an edit leaves. No database; made-up types. */
const shiftTypes = [
  { id: 'mid', name: 'Mid', ranges: [{ start: '11:00', end: '20:00' }] },
  { id: 'evening', name: 'Evening', ranges: [{ start: '16:00', end: '01:00' }] },
  { id: 'split', name: 'Split', ranges: [{ start: '11:00', end: '15:00' }, { start: '18:00', end: '23:00' }] },
  { id: 'late-bar', name: 'Late Bar', ranges: [{ start: '20:00', end: '03:00' }] },
];
const ctx = { shiftTypes };
const ids = (r: ReturnType<typeof shiftTypeFor>) => (r.kind === 'types' ? r.types.map((t) => t.id) : r.kind);

test('a shift type as said: "evening", "the evening shift", "a split", "mid" — one venue type each', () => {
  assert.deepEqual(ids(shiftTypeFor({ args: { shiftType: 'evening' } }, ctx, 'put Omar on evening Thursday', false)), ['evening']);
  assert.deepEqual(ids(shiftTypeFor({ args: { shiftType: 'the evening shift' } }, ctx, 'x', false)), ['evening']);
  assert.deepEqual(ids(shiftTypeFor({ args: { shiftType: 'a split' } }, ctx, "make Priya's Friday a split", false)), ['split']);
  assert.deepEqual(ids(shiftTypeFor({ args: { shiftType: 'Mid' } }, ctx, 'x', false)), ['mid']);
});

test('a type nobody has is asked as times; times said win over a type word; no type said is none', () => {
  const none = shiftTypeFor({ args: { shiftType: 'brunch' } }, ctx, 'x', false);
  assert.ok(none.kind === 'final' && none.intent.intent === 'UNRECOGNIZED');
  assert.ok(none.kind === 'final' && none.intent.summary === 'Your venue has no brunch shift type.');
  const split = shiftTypeFor({ args: { shiftType: 'split' } }, { shiftTypes: [] }, 'x', false);
  assert.ok(split.kind === 'final' && 'reason' in split.intent && /11 to 3 and 6 to 11/.test(split.intent.reason));
  assert.equal(shiftTypeFor({ args: { shiftType: 'evening', start: '5', end: '1' } }, ctx, 'Omar on evening, 5 to 1', true).kind, 'none');
  assert.equal(shiftTypeFor({ args: {} }, ctx, 'Omar on bartender Thursday', true).kind, 'none');
});

test('a new shift with no times may name a type in the words said ("a mid shift for Omar"), only when exactly one fits', () => {
  assert.deepEqual(ids(shiftTypeFor({ args: {} }, ctx, 'a mid shift for Omar on Friday', true)), ['mid']);
  assert.deepEqual(ids(shiftTypeFor({ args: {} }, ctx, 'Omar on the late bar Friday', true)), ['late-bar']);
  assert.equal(shiftTypeFor({ args: {} }, ctx, 'a mid shift for Omar on Friday', false).kind, 'none', 'edits name a type only as an argument');
  assert.equal(shiftTypeFor({ args: {} }, ctx, 'mid or evening for Omar', true).kind, 'none', 'two types said: not guessed');
});

test('a type\'s times: the first range, and a split\'s second', () => {
  assert.deepEqual(typeTimes(shiftTypes[1]!), { start: '16:00', end: '01:00' });
  assert.deepEqual(typeTimes(shiftTypes[2]!), { start: '11:00', end: '15:00', second: { start: '18:00', end: '23:00' } });
});

test('edited ranges: a split keeps its break on a new start or end; a second part or a split type reshapes it; null makes it one range', () => {
  const split = [{ start: '11:00', end: '15:00' }, { start: '18:00', end: '23:00' }];
  const one = [{ start: '16:00', end: '01:00' }];
  assert.equal(editedRanges(one, {}), undefined, 'no new times: the shift keeps its own');
  assert.deepEqual(editedRanges(one, { start: '17:00' }), [{ start: '17:00', end: '01:00' }]);
  assert.deepEqual(editedRanges(split, { end: '22:00' }), [{ start: '11:00', end: '15:00' }, { start: '18:00', end: '22:00' }]);
  assert.deepEqual(editedRanges(split, { start: '10:00' }), [{ start: '10:00', end: '15:00' }, { start: '18:00', end: '23:00' }]);
  assert.deepEqual(editedRanges(one, { start: '11:00', end: '15:00', second: { start: '18:00', end: '23:00' }, shiftTypeId: 'split' }), split);
  assert.deepEqual(editedRanges(split, { start: '16:00', end: '01:00', second: null, shiftTypeId: 'evening' }), one);
});

test('DIAGNOSTIC marker: this copy ran (expected to fail on purpose)', () => {
  assert.fail('diagnostic marker');
});
