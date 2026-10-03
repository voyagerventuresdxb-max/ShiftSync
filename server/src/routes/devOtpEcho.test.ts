import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../app.js';
import { hashOtp } from '../lib/identity.js';

const prisma = new PrismaClient();

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

/** A random valid UAE mobile, local format (050 is an assigned range). */
const localPhone = () => `050${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
const e164Of = (local: string) => `+971${local.slice(1)}`;
/** "050 123 4567" — the way a person would type it into the env var. */
const spaced = (local: string) => `${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`;

const ROUTES = ['identity', 'join', 'signup'] as const;

/** Runs `fn` with these env vars set (undefined = unset), restoring the previous values after. */
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

/** Requests a code, capturing every console.log line the server writes while handling it. */
async function requestOtp(baseUrl: string, route: (typeof ROUTES)[number], phone: string) {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => void logs.push(args.map(String).join(' '));
  try {
    const res = await fetch(`${baseUrl}/api/${route}/request-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    });
    return { status: res.status, body: (await res.json()) as { devCode?: string }, logs };
  } finally {
    console.log = original;
  }
}

/**
 * One fresh phone per route; the login route also needs an active user on that number.
 * Hands `fn` the local-format numbers, then deletes everything it made.
 */
async function withPhones(fn: (phones: Record<(typeof ROUTES)[number], string>) => Promise<void>) {
  const phones = { identity: localPhone(), join: localPhone(), signup: localPhone() };
  const seed = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seed, 'seed data (a location) must exist to run this test');
  const location = await prisma.location.create({ data: { organizationId: seed.organizationId, name: '__dev-otp-echo-test__', timezone: 'Asia/Dubai' } });
  await prisma.user.create({ data: { locationId: location.id, fullName: '__dev-otp-echo-test__ staff', systemRole: 'STAFF', phone: e164Of(phones.identity) } });
  try {
    await fn(phones);
  } finally {
    await prisma.otpCode.deleteMany({ where: { phone: { in: Object.values(phones).map(e164Of) } } });
    await prisma.user.deleteMany({ where: { locationId: location.id } });
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
}

test('request-otp echoes the real code for a number on ECHO_ALLOWED_PHONES, on all three routes, whatever format either side uses', async () => {
  await withPhones(async (phones) => {
    // One entry per format: spaced local, E.164, and international with spaces; plus a junk entry that is ignored.
    const allowed = [spaced(phones.identity), e164Of(phones.join), `+971 ${phones.signup.slice(1)}`, 'not a phone'].join(', ');
    await withEnv({ ALLOW_DEV_OTP_ECHO: 'true', ECHO_ALLOWED_PHONES: allowed }, () =>
      withServer(async (baseUrl) => {
        for (const route of ROUTES) {
          // Requested in a different spelling than the one listed.
          const asTyped = route === 'join' ? spaced(phones.join) : e164Of(phones[route]);
          const { status, body, logs } = await requestOtp(baseUrl, route, asTyped);
          assert.equal(status, 200, route);
          assert.match(body.devCode ?? '', /^\d{6}$/, `${route} echoes a code`);
          const row = await prisma.otpCode.findFirstOrThrow({ where: { phone: e164Of(phones[route]), consumedAt: null }, orderBy: { createdAt: 'desc' } });
          assert.equal(row.codeHash, hashOtp(body.devCode!), `${route}: the echoed code is the one on file`);
          assert.equal(logs.filter((l) => l.includes(body.devCode!)).length, 1, `${route}: one plaintext log line`);
        }
      }),
    );
  });
});

test('request-otp never echoes or logs the code for a number that is not on ECHO_ALLOWED_PHONES', async () => {
  await withPhones(async (phones) => {
    await withEnv({ ALLOW_DEV_OTP_ECHO: 'true', ECHO_ALLOWED_PHONES: localPhone() }, () =>
      withServer(async (baseUrl) => {
        for (const route of ROUTES) {
          const { status, body, logs } = await requestOtp(baseUrl, route, phones[route]);
          assert.equal(status, 200, `${route} still issues a code`);
          assert.equal(body.devCode, undefined, `${route}: no devCode`);
          assert.deepEqual(logs.filter((l) => l.includes('OTP for')), [], `${route}: no plaintext log line`);
          assert.equal(await prisma.otpCode.count({ where: { phone: e164Of(phones[route]) } }), 1, `${route}: code minted`);
        }
      }),
    );
  });
});

test('with ALLOW_DEV_OTP_ECHO off, even a listed number gets no echo', async () => {
  await withPhones(async (phones) => {
    for (const flag of [undefined, 'false', '1']) {
      await withEnv({ ALLOW_DEV_OTP_ECHO: flag, ECHO_ALLOWED_PHONES: Object.values(phones).join(',') }, () =>
        withServer(async (baseUrl) => {
          for (const route of ROUTES) {
            const { status, body, logs } = await requestOtp(baseUrl, route, phones[route]);
            assert.equal(status, 200, `${route} (ALLOW_DEV_OTP_ECHO=${flag})`);
            assert.equal(body.devCode, undefined, `${route}: no devCode with ALLOW_DEV_OTP_ECHO=${flag}`);
            assert.deepEqual(logs.filter((l) => l.includes('OTP for')), []);
          }
        }),
      );
      // Clear the 30s resend window before the next flag value reuses the same numbers.
      await prisma.otpCode.deleteMany({ where: { phone: { in: Object.values(phones).map(e164Of) } } });
    }
  });
});
