import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripUaeCountryCode } from './phoneFormat';

/**
 * Regression coverage for: `commitPhone` double-prepended the country code
 * on a freshly-typed number. `phoneFor` used to only strip a leading
 * `+971`/`971` from the SERVER-STORED phone, not from an in-progress typed
 * draft — so a manager who typed/pasted "+971501234567" into the field
 * (which already shows a static "+971" label beside it) got
 * "+971971501234567" persisted.
 */

test('stripUaeCountryCode strips a leading +971', () => {
  assert.equal(stripUaeCountryCode('+971501234567'), '501234567');
});

test('stripUaeCountryCode strips a leading bare 971 (no plus)', () => {
  assert.equal(stripUaeCountryCode('971501234567'), '501234567');
});

test('stripUaeCountryCode leaves an already-local number untouched', () => {
  assert.equal(stripUaeCountryCode('501234567'), '501234567');
});

test('stripUaeCountryCode trims surrounding whitespace', () => {
  assert.equal(stripUaeCountryCode('  +971501234567  '), '501234567');
});

test('stripUaeCountryCode is idempotent (applying it twice, as phoneFor now does to both the draft and the stored value, gives the same result)', () => {
  const once = stripUaeCountryCode('+971501234567');
  const twice = stripUaeCountryCode(once);
  assert.equal(once, twice);
  assert.equal(twice, '501234567');
});
