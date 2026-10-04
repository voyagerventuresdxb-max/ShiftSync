import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../api/schedules';
import { cooldownAfterRefusal, RESEND_COOLDOWN_SECONDS } from './useResendCooldown';

test('cooldownAfterRefusal: a 429 waits for Retry-After, falling back to the standard 30s; other errors add no wait', () => {
  assert.equal(cooldownAfterRefusal(new ApiError('slow down', 429, 17)), 17);
  assert.equal(cooldownAfterRefusal(new ApiError('slow down', 429)), RESEND_COOLDOWN_SECONDS);
  assert.equal(cooldownAfterRefusal(new ApiError('nope', 404)), 0);
  assert.equal(cooldownAfterRefusal(new Error('network')), 0);
});
