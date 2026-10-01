import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateOtp, hashOtp } from './identity.js';
import { toE164 } from './phone.js';

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

test('toE164: every way of writing one UAE mobile becomes the same E.164 number', () => {
  // This is the entire login/join phone-matching mechanism, so every common
  // way of typing the same number must collapse to one canonical value.
  for (const raw of ['0501234567', '050 123 4567', '+971 50 123 4567', '00971501234567', '971501234567', '501234567', '+971501234567']) {
    assert.equal(toE164(raw), '+971501234567', raw);
  }
});

test('toE164: foreign mobiles keep their own country code', () => {
  assert.equal(toE164('+91 97155 51234'), '+919715551234');
  assert.equal(toE164('+63 917 123 4567'), '+639171234567');
  assert.equal(toE164('+1 415 555 2671'), '+14155552671');
});

test('toE164: rejects what can never receive an SMS code, and the old digit-collision case', () => {
  // The old phoneDigits() turned BOTH of these into 5551234 and matched them as one person.
  assert.equal(toE164('9715551234'), null, 'ambiguous: no UAE mobile is 971-555-1234');
  assert.notEqual(toE164('+919715551234'), toE164('+971 555 1234'));
  for (const raw of ['043456789', '+97143456789', '0511234567', '05', '+971 50 123 45678', 'abc', '']) {
    assert.equal(toE164(raw), null, `must reject ${JSON.stringify(raw)}`);
  }
});
