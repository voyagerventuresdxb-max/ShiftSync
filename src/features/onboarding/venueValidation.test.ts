import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCanContinue } from './venueValidation';

/**
 * Regression coverage for: Continue used to be enabled as soon as name +
 * venueType were filled in, regardless of whether the manager had ever
 * touched the city/emirate chips — `city` starts pre-seeded to `'Dubai'`,
 * so a manager who never touches the chips got that default silently
 * persisted as their venue's real emirate.
 */

test('computeCanContinue requires an explicit city selection, not just name + venueType', () => {
  assert.equal(
    computeCanContinue({ name: 'Marina Speakeasy', venueType: 'Bar / Lounge', cityTouched: false }),
    false,
    'must stay disabled until the manager has actually touched a city chip, even with every other field filled in',
  );
  assert.equal(
    computeCanContinue({ name: 'Marina Speakeasy', venueType: 'Bar / Lounge', cityTouched: true }),
    true,
    'enables once a city has genuinely been chosen (including deliberately re-picking the pre-highlighted default)',
  );
});

test('computeCanContinue still requires name and venueType regardless of cityTouched', () => {
  assert.equal(computeCanContinue({ name: '', venueType: 'Bar / Lounge', cityTouched: true }), false);
  assert.equal(computeCanContinue({ name: '   ', venueType: 'Bar / Lounge', cityTouched: true }), false, 'a whitespace-only name must not count');
  assert.equal(computeCanContinue({ name: 'Marina Speakeasy', venueType: null, cityTouched: true }), false);
});
