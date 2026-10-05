import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kioskTokenFromHash, venueReadHeaders } from './venueBinding';

test('kioskTokenFromHash: reads `k` from a kiosk link fragment, null otherwise', () => {
  assert.equal(kioskTokenFromHash('#k=abc_DEF-123'), 'abc_DEF-123');
  assert.equal(kioskTokenFromHash('k=abc'), 'abc');
  assert.equal(kioskTokenFromHash(''), null);
  assert.equal(kioskTokenFromHash('#k='), null);
  assert.equal(kioskTokenFromHash('#other=1'), null);
});

test('venueReadHeaders: the session wins; otherwise the kiosk token; otherwise nothing', () => {
  assert.deepEqual(venueReadHeaders('session-token', 'kiosk-token'), { Authorization: 'Bearer session-token' });
  assert.deepEqual(venueReadHeaders(null, 'kiosk-token'), { 'X-Kiosk-Token': 'kiosk-token' });
  assert.deepEqual(venueReadHeaders(null, null), {});
});
