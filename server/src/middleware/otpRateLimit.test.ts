import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { otpRequestRateLimiters, otpVerifyRateLimiters } from './rateLimit.js';

/**
 * Exercises the REAL `otpRequestRateLimiters` / `otpVerifyRateLimiters`
 * (the exact middleware arrays identity.ts, join.ts and signup.ts mount on
 * their six OTP routes) in front of a dummy 200 handler — proving the
 * per-phone and per-IP keys, the thresholds and the JSON 429 shape without
 * minting hundreds of real OtpCode rows. `trust proxy` is on so each request
 * can pick its client IP via X-Forwarded-For; the real app only trusts that
 * header behind a configured hop count (TRUST_PROXY).
 */
function buildApp(limiters: express.RequestHandler[]) {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.post('/otp', ...limiters, (_req, res) => res.status(200).json({ ok: true }));
  return app;
}

async function withServer<T>(app: express.Express, fn: (baseUrl: string) => Promise<T>): Promise<T> {
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

function post(baseUrl: string, phone: string, ip: string) {
  return fetch(`${baseUrl}/otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ phone }),
  });
}

// Unique per test so the shared limiter singletons' in-memory buckets never bleed between tests.
let seq = 0;
const nextPhone = () => `05${String(10_000_000 + (seq++ % 89_999_999)).padStart(8, '0')}`;
const nextIp = () => `10.${(seq >> 16) & 255}.${(seq >> 8) & 255}.${seq++ & 255}`;

test('request-otp: the same phone is limited after 5 requests, regardless of the IP it comes from', async () => {
  const phone = nextPhone();
  await withServer(buildApp(otpRequestRateLimiters), async (baseUrl) => {
    for (let i = 0; i < 5; i++) {
      const res = await post(baseUrl, phone, nextIp());
      assert.equal(res.status, 200, `request #${i + 1} for this phone is within the allowance`);
    }
    const limited = await post(baseUrl, phone, nextIp());
    assert.equal(limited.status, 429, 'the 6th request for the same phone must be limited even from a fresh IP');
    assert.equal(limited.headers.get('content-type')?.includes('application/json'), true);
    assert.match(((await limited.json()) as { error: string }).error, /too many/i);

    // The same phone written differently (+971 / spaces) shares the bucket.
    const alias = await post(baseUrl, `+971 ${phone.slice(1, 3)} ${phone.slice(3)}`, nextIp());
    assert.equal(alias.status, 429, 'phone keys are normalized digits, so a reformatted number cannot dodge the limit');

    // A different phone from a fresh IP is unaffected.
    const other = await post(baseUrl, nextPhone(), nextIp());
    assert.equal(other.status, 200);
  });
});

test('request-otp: one IP rotating phone numbers is limited after 30 requests, and another IP is unaffected', async () => {
  const ip = nextIp();
  await withServer(buildApp(otpRequestRateLimiters), async (baseUrl) => {
    for (let i = 0; i < 30; i++) {
      const res = await post(baseUrl, nextPhone(), ip);
      assert.equal(res.status, 200, `request #${i + 1} from this IP is within the allowance`);
    }
    const limited = await post(baseUrl, nextPhone(), ip);
    assert.equal(limited.status, 429, 'the 31st request from the same IP must be limited even with a brand-new phone');

    const other = await post(baseUrl, nextPhone(), nextIp());
    assert.equal(other.status, 200, 'a different IP has its own bucket');
  });
});

test('verify-otp: 10 per phone, 60 per IP', async () => {
  const phone = nextPhone();
  await withServer(buildApp(otpVerifyRateLimiters), async (baseUrl) => {
    for (let i = 0; i < 10; i++) {
      assert.equal((await post(baseUrl, phone, nextIp())).status, 200, `verify #${i + 1} for this phone is allowed`);
    }
    assert.equal((await post(baseUrl, phone, nextIp())).status, 429, 'the 11th verify for one phone is limited');

    const ip = nextIp();
    for (let i = 0; i < 60; i++) {
      assert.equal((await post(baseUrl, nextPhone(), ip)).status, 200, `verify #${i + 1} from this IP is allowed`);
    }
    assert.equal((await post(baseUrl, nextPhone(), ip)).status, 429, 'the 61st verify from one IP is limited');
  });
});

test('a request with no phone at all still counts against the caller IP (fails closed, never an unlimited bucket)', async () => {
  const ip = nextIp();
  await withServer(buildApp(otpRequestRateLimiters), async (baseUrl) => {
    const send = () =>
      fetch(`${baseUrl}/otp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: '{}' });
    // Without a phone the per-phone limiter also keys on IP, so its 5-cap is
    // what trips first — the point is that it trips at all.
    for (let i = 0; i < 5; i++) assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 429);
  });
});
