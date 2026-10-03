import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSessionRejection, onSessionRejected, retryAfterSeconds } from './http';

test('isSessionRejection: only a 401 on a request that carried a token counts', () => {
  assert.equal(isSessionRejection(401, { headers: { Authorization: 'Bearer x' } }), true);
  assert.equal(isSessionRejection(401, { headers: { authorization: 'Bearer x' } }), true);
  assert.equal(isSessionRejection(401, { headers: new Headers({ Authorization: 'Bearer x' }) }), true);
  assert.equal(isSessionRejection(401, { headers: [['Authorization', 'Bearer x']] }), true);
  assert.equal(isSessionRejection(401, { headers: { 'Content-Type': 'application/json' } }), false, 'verify-otp 401s are form errors');
  assert.equal(isSessionRejection(401, undefined), false);
  assert.equal(isSessionRejection(403, { headers: { Authorization: 'Bearer x' } }), false, 'a 403 is a permission answer, the session is fine');
  assert.equal(isSessionRejection(500, { headers: { Authorization: 'Bearer x' } }), false);
});

test('onSessionRejected: subscribe returns an unsubscribe', () => {
  let calls = 0;
  const off = onSessionRejected(() => calls++);
  off();
  assert.equal(calls, 0);
});

test('retryAfterSeconds: parses a numeric header, ignores the rest', () => {
  const withHeader = (value: string | null) => new Response(null, { status: 429, headers: value === null ? {} : { 'Retry-After': value } });
  assert.equal(retryAfterSeconds(withHeader('27')), 27);
  assert.equal(retryAfterSeconds(withHeader('0.4')), 1);
  assert.equal(retryAfterSeconds(withHeader('0')), null);
  assert.equal(retryAfterSeconds(withHeader('soon')), null);
  assert.equal(retryAfterSeconds(withHeader(null)), null);
});
