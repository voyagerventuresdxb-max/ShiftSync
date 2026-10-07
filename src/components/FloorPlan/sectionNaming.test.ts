import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fallbackSectionLabel } from './sectionNaming';

test('fallbackSectionLabel numbers on from the sections that exist', () => {
  assert.equal(fallbackSectionLabel([]), 'Section 1');
  assert.equal(fallbackSectionLabel(['Terrace', 'Bar']), 'Section 3');
});

test('fallbackSectionLabel skips a "Section N" that is already taken, whatever its case or spacing', () => {
  // Section 1 was deleted, Section 2 remains: the count says 2, which is taken.
  assert.equal(fallbackSectionLabel(['Section 2']), 'Section 3');
  assert.equal(fallbackSectionLabel(['Terrace', ' section 3 ', 'Section 4']), 'Section 5');
});
