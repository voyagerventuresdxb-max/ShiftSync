import { test } from 'node:test';
import assert from 'node:assert/strict';
import { similarity, bestMatch } from './textSimilarity.js';

test('similarity: identical strings score 1', () => {
  assert.equal(similarity('Ramadan Schedule', 'Ramadan Schedule'), 1);
});

test('similarity: case and whitespace differences are normalized away', () => {
  assert.equal(similarity('  ramadan   schedule ', 'Ramadan Schedule'), 1);
});

test('similarity: two empty strings are treated as identical', () => {
  assert.equal(similarity('', ''), 1);
});

test('similarity: empty vs non-empty is completely different', () => {
  assert.equal(similarity('', 'Ramadan Schedule'), 0);
});

test('similarity: completely different strings score low', () => {
  assert.ok(similarity('Ramadan Schedule', 'zzz') < 0.3);
});

test('bestMatch: a close-but-imperfect name resolves confidently against one saved template', () => {
  const candidates = [
    { id: 't1', name: 'Winter Holiday Schedule' },
    { id: 't2', name: 'Standard Weekday Rota' },
  ];
  const { best, runnerUp } = bestMatch('the holiday template', candidates);
  assert.equal(best?.id, 't1');
  assert.ok(best!.score > (runnerUp?.score ?? 0), 'the holiday-related template must score clearly above the unrelated one');
});

test('bestMatch: two similarly-named templates produce an ambiguous (close-margin) result', () => {
  const candidates = [
    { id: 't1', name: 'Ramadan Sahur' },
    { id: 't2', name: 'Ramadan Closing' },
  ];
  const { best, runnerUp } = bestMatch('Ramadan', candidates);
  assert.ok(best && runnerUp, 'both candidates should score against a bare "Ramadan" query');
  assert.ok(Math.abs(best!.score - runnerUp!.score) < 0.15, 'the two Ramadan-prefixed names should score within a close margin of each other');
});

test('bestMatch: empty candidate list returns no match', () => {
  const { best, runnerUp } = bestMatch('anything', []);
  assert.equal(best, null);
  assert.equal(runnerUp, null);
});
