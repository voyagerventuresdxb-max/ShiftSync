import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../app.js';
import { hashOtp } from '../lib/identity.js';
import { SMS_SEND_FAILED_ERROR } from '../lib/sms.js';

/**
 * SMS delivery through the three real request-otp routes, with the provider
 * mocked at `fetch` (only api.twilio.com calls are intercepted; nothing leaves
 * the machine). Fake credentials; random numbers generated per run.
 */
const prisma = new PrismaClient();
const ROUTES = ['identity', 'join', 'signup'] as const;
const SMS_ENV = { SMS_OTP_ENABLED: 'true', TWILIO_ACCOUNT_SID: 'ACfake-test-sid', TWILIO_AUTH_TOKEN: 'fake-test-token', SMS_SENDER_ID: 'ShiftSync' };
const localPhone = () => `050${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
const e164Of = (local: string) => `+971${local.slice(1)}`;

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const apply = (v: Record<string, string | undefined>) => {
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) delete process.env[k];
      else process.env[k] = val;
    }
  };
  apply(vars);
  try {
    return await fn();
  } finally {
    apply(previous);
  }
}

/** Starts the app; intercepts Twilio calls with `twilio`, passes every other fetch through. */
async function withServer(twilio: (body: URLSearchParams) => Response, fn: (baseUrl: string, sent: URLSearchParams[]) => Promise<void>) {
  const realFetch = globalThis.fetch;
  const sent: URLSearchParams[] = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith('https://api.twilio.com/')) {
      const body = new URLSearchParams(String(init?.body));
      sent.push(body);
      return twilio(body);
    }
    return realFetch(input, init);
  });
  const app = createApp();
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, sent);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fetchMock.mock.restore();
  }
}

async function requestOtp(baseUrl: string, route: (typeof ROUTES)[number], phone: string) {
  const res = await fetch(`${baseUrl}/api/${route}/request-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  });
  return { status: res.status, body: (await res.json()) as { devCode?: string; error?: string } };
}

/** One fresh number per route; the login route also needs a user on it. Cleans up after. */
async function withPhones(fn: (phones: Record<(typeof ROUTES)[number], string>) => Promise<void>) {
  const phones = { identity: localPhone(), join: localPhone(), signup: localPhone() };
  const seed = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seed, 'seed data (a location) must exist to run this test');
  const location = await prisma.location.create({ data: { organizationId: seed.organizationId, name: '__sms-otp-test__', timezone: 'Asia/Dubai' } });
  await prisma.user.create({ data: { locationId: location.id, fullName: '__sms-otp-test__ staff', systemRole: 'STAFF', phone: e164Of(phones.identity) } });
  try {
    await fn(phones);
  } finally {
    await prisma.otpCode.deleteMany({ where: { phone: { in: Object.values(phones).map(e164Of) } } });
    await prisma.user.deleteMany({ where: { locationId: location.id } });
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
}

test('SMS on: every request-otp route texts the code on file to the E.164 number, and echoes nothing', async () => {
  await withPhones(async (phones) => {
    await withEnv({ ...SMS_ENV, ALLOW_DEV_OTP_ECHO: undefined }, () =>
      withServer(
        () => new Response(JSON.stringify({ sid: 'SMfake' }), { status: 201 }),
        async (baseUrl, sent) => {
          for (const route of ROUTES) {
            const { status, body } = await requestOtp(baseUrl, route, phones[route]);
            assert.equal(status, 200, route);
            assert.equal(body.devCode, undefined, `${route}: no echo`);
            const message = sent.at(-1)!;
            assert.equal(message.get('To'), e164Of(phones[route]), route);
            const code = message.get('Body')!.match(/^(\d{6}) /)?.[1];
            assert.ok(code, `${route}: the text starts with the code`);
            const row = await prisma.otpCode.findFirstOrThrow({ where: { phone: e164Of(phones[route]), consumedAt: null }, orderBy: { createdAt: 'desc' } });
            assert.equal(row.codeHash, hashOtp(code), `${route}: the texted code is the one on file`);
          }
          assert.equal(sent.length, ROUTES.length);
        },
      ),
    );
  });
});

test('SMS on but the provider fails: 503 with a plain retry message, on all three routes', async () => {
  await withPhones(async (phones) => {
    await withEnv(SMS_ENV, () =>
      withServer(
        () => new Response(JSON.stringify({ code: 20003 }), { status: 401 }),
        async (baseUrl) => {
          const original = console.error;
          console.error = () => {};
          try {
            for (const route of ROUTES) {
              const { status, body } = await requestOtp(baseUrl, route, phones[route]);
              assert.equal(status, 503, route);
              assert.equal(body.error, SMS_SEND_FAILED_ERROR, route);
            }
          } finally {
            console.error = original;
          }
        },
      ),
    );
  });
});

test('SMS off (the default): no provider call, codes issued exactly as before', async () => {
  await withPhones(async (phones) => {
    for (const flag of [undefined, 'false']) {
      await withEnv({ ...SMS_ENV, SMS_OTP_ENABLED: flag }, () =>
        withServer(
          () => assert.fail('no SMS may be sent with the flag off'),
          async (baseUrl, sent) => {
            for (const route of ROUTES) {
              const { status } = await requestOtp(baseUrl, route, phones[route]);
              assert.equal(status, 200, `${route} (SMS_OTP_ENABLED=${flag})`);
            }
            assert.equal(sent.length, 0);
          },
        ),
      );
      // Clear the resend window before the next flag value reuses the same numbers.
      await prisma.otpCode.deleteMany({ where: { phone: { in: Object.values(phones).map(e164Of) } } });
    }
  });
});
