import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../app.js';
import { otpPhoneRetryAfterSeconds, phoneDigits } from '../lib/identity.js';
import { otpClientKey } from '../middleware/rateLimit.js';

const prisma = new PrismaClient();

/** Starts the real Express app on an ephemeral port and hands the caller its base URL. */
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

/** Unique-enough test phone number per test run, so parallel/rerun tests never collide. */
function testPhone(): string {
  return `05${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
}

function requestOtp(baseUrl: string, route: 'signup' | 'join', phone: string) {
  return fetch(`${baseUrl}/api/${route}/request-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  });
}

/** Moves every code for `phone` back in time, as if it had been requested `ms` earlier. */
async function age(phone: string, ms: number) {
  await prisma.$executeRaw`UPDATE otp_codes SET created_at = created_at - (${ms} * interval '1 millisecond') WHERE phone = ${phoneDigits(phone)}`;
}

test('otpPhoneRetryAfterSeconds: waits for the row that must age out of each violated window', () => {
  const now = new Date('2026-10-01T12:00:00Z');
  const ago = (s: number) => new Date(now.getTime() - s * 1000);
  assert.equal(otpPhoneRetryAfterSeconds([], now), 0);
  assert.equal(otpPhoneRetryAfterSeconds([ago(10)], now), 20, 'one code 10s ago: 20s left of the 30s resend window');
  assert.equal(otpPhoneRetryAfterSeconds([ago(31)], now), 0);
  // 5 in the last hour, oldest 50 min ago: the 5th-newest must leave the hour window (10 min).
  assert.equal(otpPhoneRetryAfterSeconds([ago(60), ago(600), ago(1200), ago(2400), ago(3000)], now), 600);
  // 10 in the last day (none in the last hour), oldest 23h ago: wait 1h.
  const day = Array.from({ length: 10 }, (_, i) => ago(2 * 3600 + i * 60));
  day[9] = ago(23 * 3600);
  assert.equal(otpPhoneRetryAfterSeconds(day, now), 3600);
});

test('request-otp: a second code for the same number within 30s is a 429 with Retry-After, shared across signup and join; it clears once the window passes', async () => {
  const phone = testPhone();
  try {
    await withServer(async (baseUrl) => {
      assert.equal((await requestOtp(baseUrl, 'signup', phone)).status, 200);

      const again = await requestOtp(baseUrl, 'signup', phone);
      assert.equal(again.status, 429);
      const retryAfter = Number(again.headers.get('retry-after'));
      assert.ok(retryAfter > 0 && retryAfter <= 30, `Retry-After within the 30s window, got ${retryAfter}`);
      const { error } = (await again.json()) as { error: string };
      assert.match(error, /^Too many code requests for this number — try again in \d+ seconds?\.$/);

      // The cap is per phone across purposes: switching route doesn't get another code.
      assert.equal((await requestOtp(baseUrl, 'join', phone)).status, 429);
      // Same number written differently is the same phone.
      assert.equal((await requestOtp(baseUrl, 'signup', `+971 ${phone.slice(1)}`)).status, 429);

      await age(phone, 31_000);
      assert.equal((await requestOtp(baseUrl, 'join', phone)).status, 200, 'allowed again after 30s');
      assert.equal(await prisma.otpCode.count({ where: { phone: phoneDigits(phone) } }), 2, 'rejected requests create no code');
    });
  } finally {
    await prisma.otpCode.deleteMany({ where: { phone: phoneDigits(phone) } });
  }
});

test('request-otp: the 6th code in an hour is refused for minutes, not seconds', async () => {
  const phone = testPhone();
  try {
    await withServer(async (baseUrl) => {
      for (let i = 0; i < 5; i++) {
        assert.equal((await requestOtp(baseUrl, 'signup', phone)).status, 200, `code ${i + 1}`);
        await age(phone, 31_000); // step past the 30s resend window each time
      }
      const sixth = await requestOtp(baseUrl, 'signup', phone);
      assert.equal(sixth.status, 429);
      const retryAfter = Number(sixth.headers.get('retry-after'));
      // The oldest of the 5 is ~155s old, so ~3445s remain in its hour.
      assert.ok(retryAfter > 3300 && retryAfter <= 3600, `Retry-After ~57 min, got ${retryAfter}`);
      assert.match(((await sixth.json()) as { error: string }).error, /try again in \d+ minutes\./);
    });
  } finally {
    await prisma.otpCode.deleteMany({ where: { phone: phoneDigits(phone) } });
  }
});

test('request-otp: simultaneous requests for one number mint exactly one code (per-phone lock)', async () => {
  const phone = testPhone();
  try {
    await withServer(async (baseUrl) => {
      const statuses = (await Promise.all(Array.from({ length: 5 }, () => requestOtp(baseUrl, 'signup', phone)))).map((r) => r.status);
      assert.deepEqual([...statuses].sort(), [200, 429, 429, 429, 429]);
      assert.equal(await prisma.otpCode.count({ where: { phone: phoneDigits(phone) } }), 1);
    });
  } finally {
    await prisma.otpCode.deleteMany({ where: { phone: phoneDigits(phone) } });
  }
});

test('otpClientKey: keys on the (Railway X-Real-IP, X-Vercel-Forwarded-For) pair; loopback with no proxy is not limited', () => {
  const req = (headers: Record<string, string>, remote = '::ffff:100.64.0.3') =>
    ({ get: (h: string) => headers[h.toLowerCase()], socket: { remoteAddress: remote } }) as unknown as import('express').Request;
  // Through Vercel: connecting address is Vercel's, the client is in X-Vercel-Forwarded-For.
  assert.equal(otpClientKey(req({ 'x-real-ip': '65.2.151.184', 'x-vercel-forwarded-for': '2.50.43.13' })), '65.2.151.184|2.50.43.13');
  // Direct to Railway: just the (unforgeable) connecting address.
  assert.equal(otpClientKey(req({ 'x-real-ip': '2.50.43.13' })), '2.50.43.13');
  // A forged list keeps only its first entry; the real connecting half is untouched.
  assert.equal(otpClientKey(req({ 'x-real-ip': '2.50.43.13', 'x-vercel-forwarded-for': '9.9.9.9, 8.8.8.8' })), '2.50.43.13|9.9.9.9');
  // IPv6 clients are bucketed by subnet, like the rest of this codebase's limiters.
  assert.ok(otpClientKey(req({ 'x-real-ip': '2001:db8:1:2:3:4:5:6' }))!.includes('2001:db8:1'));
  assert.equal(otpClientKey(req({}, '::1')), null, 'local dev/e2e: no proxy, not limited');
  assert.equal(otpClientKey(req({}, '::ffff:127.0.0.1')), null);
  assert.equal(otpClientKey(req({}, '::ffff:10.0.0.5')), '10.0.0.5', 'no X-Real-IP but not loopback: still limited by socket address');
});

test('request-otp per-client cap: the 11th request in 15 min from one client is a 429; other clients behind the same Vercel address are unaffected', async () => {
  const vercelEgress = `203.0.113.${Math.floor(Math.random() * 250) + 1}`; // TEST-NET-3, unique per run
  const client = (n: number) => ({ 'x-real-ip': vercelEgress, 'x-vercel-forwarded-for': `198.51.100.${n}` });
  const phones: string[] = [];
  const ask = (route: 'signup' | 'join', headers: Record<string, string>, baseUrl: string) => {
    const phone = testPhone(); // a fresh number each time, so only the per-client cap is in play
    phones.push(phone);
    return fetch(`${baseUrl}/api/${route}/request-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ phone }),
    });
  };
  try {
    await withServer(async (baseUrl) => {
      for (let i = 0; i < 10; i++) {
        // Alternating routes: the cap is shared across login/join/signup.
        assert.equal((await ask(i % 2 ? 'join' : 'signup', client(1), baseUrl)).status, 200, `request ${i + 1}`);
      }
      const eleventh = await ask('signup', client(1), baseUrl);
      assert.equal(eleventh.status, 429);
      assert.ok(Number(eleventh.headers.get('retry-after')) > 0, 'Retry-After set');
      assert.equal((await ask('signup', client(2), baseUrl)).status, 200, 'another client behind the same Vercel address has its own bucket');
    });
  } finally {
    await prisma.otpCode.deleteMany({ where: { phone: { in: phones.map(phoneDigits) } } });
  }
});
