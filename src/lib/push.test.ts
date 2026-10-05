import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subscribeToPush } from './push';

// Just enough of the browser Push API for subscribeToPush to run under node.
function installBrowser(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  const calls = { fetch: [] as string[], subscribe: 0 };
  const registration = {
    pushManager: {
      getSubscription: async () => null,
      subscribe: async () => {
        calls.subscribe += 1;
        throw new Error('subscribe must not be reached when push is unavailable');
      },
    },
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: { serviceWorker: { getRegistration: async () => registration, register: async () => registration } },
    configurable: true,
  });
  Object.defineProperty(globalThis, 'window', { value: { PushManager: class {} }, configurable: true });
  Object.defineProperty(globalThis, 'Notification', {
    value: { permission: 'granted', requestPermission: async () => 'granted' },
    configurable: true,
  });
  Object.defineProperty(globalThis, 'fetch', {
    value: (url: string, init?: RequestInit) => {
      calls.fetch.push(`${init?.method ?? 'GET'} ${url}`);
      return fetchImpl(url, init);
    },
    configurable: true,
  });
  return calls;
}

test('server reports push unavailable (empty key): one GET, no subscribe, no throw, readable error', async () => {
  const calls = installBrowser(async () => new Response(JSON.stringify({ publicKey: '' }), { status: 200 }));
  const result = await subscribeToPush('token');
  assert.deepEqual(result, { ok: false, reason: 'error', message: 'Push is not configured for this venue yet.' });
  assert.deepEqual(calls.fetch, ['GET /api/push/vapid-public-key']);
  assert.equal(calls.subscribe, 0);
});

test('key endpoint down (500 or network error): resolves to an error result instead of throwing', async () => {
  for (const impl of [
    async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 }),
    async () => { throw new TypeError('Failed to fetch'); },
  ]) {
    const calls = installBrowser(impl);
    const result = await subscribeToPush('token');
    assert.equal(result.ok, false);
    assert.equal(calls.fetch.length, 1);
    assert.equal(calls.subscribe, 0);
  }
});
