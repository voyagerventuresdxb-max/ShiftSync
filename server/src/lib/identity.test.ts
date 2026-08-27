import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateOtp, hashOtp, phoneDigits } from './identity.js';

test('generateOtp returns a 6-digit numeric string', () => {
  const code = generateOtp();
  assert.match(code, /^\d{6}$/);
});

test('generateOtp is not deterministic across calls', () => {
  const codes = new Set(Array.from({ length: 20 }, () => generateOtp()));
  assert.ok(codes.size > 1, 'expected at least some variation across 20 generated codes');
});

test('hashOtp is deterministic for the same input and never returns the plaintext', () => {
  const a = hashOtp('123456');
  const b = hashOtp('123456');
  assert.equal(a, b);
  assert.notEqual(a, '123456');
  assert.equal(a.length, 64); // sha256 hex digest
});

test('hashOtp produces different hashes for different codes', () => {
  assert.notEqual(hashOtp('123456'), hashOtp('654321'));
});

test('phoneDigits normalizes local, international, and 00-prefixed formats to the same value', () => {
  // The same real number, entered three different ways — local trunk-0
  // format, international +971 format (with spaces), and the 00-dialing-
  // prefix format. All three must collapse to one canonical value, since
  // this is the entire login/join phone-matching mechanism.
  const local = phoneDigits('0501234567');
  const intl = phoneDigits('+971 50 123 4567');
  const zeroZero = phoneDigits('00971501234567');

  assert.equal(local, '501234567');
  assert.equal(intl, '501234567');
  assert.equal(zeroZero, '501234567');
  assert.equal(local, intl);
  assert.equal(intl, zeroZero);
});
