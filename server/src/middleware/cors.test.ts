import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../app.js';

/**
 * Exercises the REAL app (createApp) so the CORS lock is proven where it is
 * mounted, not on a stand-in. Only /api/health is hit — no DB, no session.
 */
async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = createApp();
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function withFrontendOrigin<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.FRONTEND_ORIGIN;
  if (value === undefined) delete process.env.FRONTEND_ORIGIN;
  else process.env.FRONTEND_ORIGIN = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.FRONTEND_ORIGIN;
    else process.env.FRONTEND_ORIGIN = previous;
  }
}

test('a request from an origin not on the allowlist is refused outright (403), not merely left without CORS headers', async () => {
  await withFrontendOrigin('https://app.example', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/health`, { headers: { Origin: 'https://evil.example' } });
      assert.equal(res.status, 403);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /origin/i);
      assert.equal(res.headers.get('access-control-allow-origin'), null);

      // A cross-site POST to an OTP route is the case that matters — it must
      // never reach the handler (which would mint a real code).
      const post = await fetch(`${baseUrl}/api/identity/request-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
        body: JSON.stringify({ phone: '0501234567' }),
      });
      assert.equal(post.status, 403);

      // Preflight from a bad origin is refused too.
      const preflight = await fetch(`${baseUrl}/api/identity/request-otp`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
      });
      assert.equal(preflight.status, 403);
    });
  });
});

test('the configured frontend origin (any entry of a comma-separated list) is allowed and echoed back', async () => {
  await withFrontendOrigin('https://app.example, https://custom.example/', async () => {
    await withServer(async (baseUrl) => {
      for (const origin of ['https://app.example', 'https://custom.example']) {
        const res = await fetch(`${baseUrl}/api/health`, { headers: { Origin: origin } });
        assert.equal(res.status, 200, `${origin} must be allowed`);
        assert.equal(res.headers.get('access-control-allow-origin'), origin);
      }
      const preflight = await fetch(`${baseUrl}/api/identity/request-otp`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://app.example', 'Access-Control-Request-Method': 'POST' },
      });
      assert.equal(preflight.status, 204);
    });
  });
});

test('a request with no Origin header (health checks, curl, same-origin GETs) passes through', async () => {
  await withFrontendOrigin('https://app.example', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/health`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
    });
  });
});

test('with FRONTEND_ORIGIN unset only the local Vite dev origin is allowed', async () => {
  await withFrontendOrigin(undefined, async () => {
    await withServer(async (baseUrl) => {
      const dev = await fetch(`${baseUrl}/api/health`, { headers: { Origin: 'http://localhost:5173' } });
      assert.equal(dev.status, 200);
      assert.equal(dev.headers.get('access-control-allow-origin'), 'http://localhost:5173');
      const other = await fetch(`${baseUrl}/api/health`, { headers: { Origin: 'http://localhost:3000' } });
      assert.equal(other.status, 403);
    });
  });
});
