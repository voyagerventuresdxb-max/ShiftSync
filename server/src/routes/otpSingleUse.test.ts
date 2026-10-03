import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../app.js';
import { createOtpCode, OTP_ALREADY_USED_REASON, verifyOtpCode } from '../lib/identity.js';

const prisma = new PrismaClient();
const TAG = '__otp-single-use-test__';

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

const phone = () => `+97150${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;

async function makeStaff(p: string) {
  const seed = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seed, 'seed data (a location) must exist to run this test');
  const location = await prisma.location.create({ data: { organizationId: seed!.organizationId, name: `${TAG} venue`, timezone: 'Asia/Dubai' } });
  const user = await prisma.user.create({ data: { locationId: location.id, fullName: `${TAG} Staff`, systemRole: 'STAFF', phone: p } });
  return { location, user };
}

test('verifyOtpCode: a correct code verifies once; the same code again is refused as already used (single conditional update)', async () => {
  const p = phone();
  try {
    const { plainCode } = await createOtpCode(p, 'LOGIN');
    assert.deepEqual(await verifyOtpCode(p, 'LOGIN', plainCode), { ok: true });
    // No unconsumed row is left, so the replay is refused at the lookup already.
    const replay = await verifyOtpCode(p, 'LOGIN', plainCode);
    assert.equal(replay.ok, false);
    assert.equal(await prisma.otpCode.count({ where: { phone: p, consumedAt: null } }), 0);
  } finally {
    await prisma.otpCode.deleteMany({ where: { phone: p } });
  }
});

test('verifyOtpCode: eight concurrent verifications of one correct code succeed exactly once', async () => {
  for (let round = 0; round < 3; round++) {
    const p = phone();
    try {
      const { plainCode } = await createOtpCode(p, 'LOGIN');
      const results = await Promise.all(Array.from({ length: 8 }, () => verifyOtpCode(p, 'LOGIN', plainCode)));
      const okCount = results.filter((r) => r.ok).length;
      assert.equal(okCount, 1, `round ${round}: exactly one winner`);
      for (const loser of results.filter((r) => !r.ok)) {
        assert.ok(
          loser.reason === OTP_ALREADY_USED_REASON || loser.reason?.startsWith('No active code'),
          `round ${round}: losers are told the code is spent (${loser.reason})`,
        );
      }
    } finally {
      await prisma.otpCode.deleteMany({ where: { phone: p } });
    }
  }
});

test('POST /api/identity/verify-otp: concurrent submissions of one code issue exactly one session', async () => {
  const p = phone();
  const { location } = await makeStaff(p);
  try {
    await withServer(async (baseUrl) => {
      const { plainCode } = await createOtpCode(p, 'LOGIN');
      const responses = await Promise.all(
        Array.from({ length: 6 }, () =>
          fetch(`${baseUrl}/api/identity/verify-otp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: p, code: plainCode }),
          }),
        ),
      );
      const statuses = responses.map((r) => r.status).sort();
      assert.deepEqual(statuses, [200, 401, 401, 401, 401, 401]);
      const user = await prisma.user.findUniqueOrThrow({ where: { phone: p } });
      assert.equal(await prisma.session.count({ where: { userId: user.id } }), 1, 'one session for the one winner');
    });
  } finally {
    await prisma.otpCode.deleteMany({ where: { phone: p } });
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});
