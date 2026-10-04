import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../app.js';
import { corsOptionsFromEnv } from './corsOptions.js';

/** Builds the real app with `CORS_ORIGINS` set to `value` (or unset), serves it on an ephemeral port, restores the env after. */
async function withServer<T>(value: string | undefined, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const previous = process.env.CORS_ORIGINS;
  if (value === undefined) delete process.env.CORS_ORIGINS;
  else process.env.CORS_ORIGINS = value;
  try {
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
  } finally {
    if (previous === undefined) delete process.env.CORS_ORIGINS;
    else process.env.CORS_ORIGINS = previous;
  }
}

function preflight(baseUrl: string, origin: string): Promise<Response> {
  return fetch(`${baseUrl}/api/identity/session`, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'DELETE', 'Access-Control-Request-Headers': 'authorization' },
  });
}

test('corsOptionsFromEnv: unset, empty or blank keeps the permissive default; entries are trimmed and lose trailing slashes', () => {
  assert.equal(corsOptionsFromEnv(undefined), undefined);
  assert.equal(corsOptionsFromEnv(''), undefined);
  assert.equal(corsOptionsFromEnv(' , '), undefined);
  assert.deepEqual(corsOptionsFromEnv(' https://localhost/ ,capacitor://localhost,, http://localhost '), {
    origin: ['https://localhost', 'capacitor://localhost', 'http://localhost'],
  });
});

test('CORS_ORIGINS unset: any origin is allowed, exactly as before the allowlist existed', async () => {
  await withServer(undefined, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/health`, { headers: { Origin: 'https://anything.example' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');

    const pre = await preflight(baseUrl, 'https://localhost');
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  });
});

test('CORS_ORIGINS set: listed origins (the Capacitor shell) are echoed back; anything else gets no CORS grant', async () => {
  await withServer('https://localhost, capacitor://localhost', async (baseUrl) => {
    const allowed = await fetch(`${baseUrl}/api/health`, { headers: { Origin: 'https://localhost' } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://localhost');
    assert.match(allowed.headers.get('vary') ?? '', /Origin/);

    const pre = await preflight(baseUrl, 'https://localhost');
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'https://localhost');
    assert.match(pre.headers.get('access-control-allow-headers') ?? '', /authorization/i);
    assert.match(pre.headers.get('access-control-allow-methods') ?? '', /DELETE/);

    const ios = await fetch(`${baseUrl}/api/health`, { headers: { Origin: 'capacitor://localhost' } });
    assert.equal(ios.headers.get('access-control-allow-origin'), 'capacitor://localhost');

    const other = await fetch(`${baseUrl}/api/health`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(other.headers.get('access-control-allow-origin'), null);
    const otherPre = await preflight(baseUrl, 'https://evil.example');
    assert.equal(otherPre.headers.get('access-control-allow-origin'), null);

    // Same-origin web traffic (via the /api rewrite) sends no Origin on GETs and is unaffected.
    const noOrigin = await fetch(`${baseUrl}/api/health`);
    assert.equal(noOrigin.status, 200);
  });
});
