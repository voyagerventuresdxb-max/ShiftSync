import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../app.js';
import { createOtpCode, issueSession } from '../lib/identity.js';
import { INVALID_PHONE_ERROR } from '../lib/phone.js';
import { generateInviteToken } from '../lib/inviteLinks.js';

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

const post = (baseUrl: string, path: string, body: unknown, token?: string) =>
  fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

async function makeLocation(name: string) {
  const seed = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seed, 'seed data (a location) must exist to run this test');
  return prisma.location.create({ data: { organizationId: seed!.organizationId, name: `__phone-e164-test__ ${name}`, timezone: 'Asia/Dubai' } });
}

test('request-otp on all three routes: a number that is not a valid mobile is a 400 with a clear message, and mints no code', async () => {
  await withServer(async (baseUrl) => {
    for (const route of ['identity', 'join', 'signup']) {
      for (const phone of ['04 345 6789', '12345', 'not a phone']) {
        const res = await post(baseUrl, `/api/${route}/request-otp`, { phone });
        assert.equal(res.status, 400, `${route} must reject ${phone}`);
        assert.equal(((await res.json()) as { error: string }).error, INVALID_PHONE_ERROR);
      }
    }
  });
  assert.equal(await prisma.otpCode.count({ where: { phone: { in: ['04 345 6789', '12345', 'not a phone', '+97143456789'] } } }), 0);
});

test('login: a user stored in E.164 signs in with the number written any common way', async () => {
  const location = await makeLocation('login');
  const local = localPhone();
  const user = await prisma.user.create({ data: { locationId: location.id, fullName: '__phone-e164-test__ staff', systemRole: 'STAFF', phone: e164Of(local) } });
  try {
    await withServer(async (baseUrl) => {
      const requested = await post(baseUrl, '/api/identity/request-otp', { phone: local });
      assert.equal(requested.status, 200);
      const row = await prisma.otpCode.findFirstOrThrow({ where: { phone: e164Of(local), purpose: 'LOGIN', consumedAt: null } });
      assert.ok(row, 'the code is keyed on the E.164 number');

      // Verify with the international spelling; the code itself comes from a fresh mint to read it in plain text.
      const { plainCode } = await createOtpCode(local, 'LOGIN');
      const verified = await post(baseUrl, '/api/identity/verify-otp', { phone: `+971 ${local.slice(1, 3)} ${local.slice(3)}`, code: plainCode });
      assert.equal(verified.status, 200);
      assert.equal(((await verified.json()) as { user: { id: string } }).user.id, user.id);
    });
  } finally {
    await prisma.otpCode.deleteMany({ where: { phone: e164Of(local) } });
    await prisma.session.deleteMany({ where: { userId: user.id } });
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});

test('join: stores E.164 on the request; a number held at another venue, or by a deactivated record here, is a 409 before anything is filed', async () => {
  const here = await makeLocation('join here');
  const elsewhere = await makeLocation('join elsewhere');
  const fresh = localPhone();
  const takenElsewhere = localPhone();
  const deactivated = localPhone();
  await prisma.user.create({ data: { locationId: elsewhere.id, fullName: '__phone-e164-test__ other venue', systemRole: 'STAFF', phone: e164Of(takenElsewhere) } });
  await prisma.user.create({
    data: { locationId: here.id, fullName: '__phone-e164-test__ left', systemRole: 'STAFF', phone: e164Of(deactivated), isActive: false },
  });
  const { token: inviteToken } = await prisma.inviteLink.create({ data: { locationId: here.id, token: generateInviteToken(), expiresAt: new Date(Date.now() + 86_400_000) } });
  try {
    await withServer(async (baseUrl) => {
      const join = async (phone: string) => {
        const { plainCode } = await createOtpCode(phone, 'JOIN');
        return post(baseUrl, '/api/join/verify-otp', { inviteToken, phone, code: plainCode, fullName: '__phone-e164-test__ applicant' });
      };
      const filed = await join(`050 ${fresh.slice(3)}`);
      assert.equal(filed.status, 201);
      const { joinRequestId } = (await filed.json()) as { joinRequestId: string };
      assert.equal((await prisma.joinRequest.findUniqueOrThrow({ where: { id: joinRequestId } })).phone, e164Of(fresh));

      const other = await join(takenElsewhere);
      assert.equal(other.status, 409);
      assert.match(((await other.json()) as { error: string }).error, /another venue/);

      const left = await join(deactivated);
      assert.equal(left.status, 409);
      assert.match(((await left.json()) as { error: string }).error, /deactivated/);

      assert.equal(await prisma.joinRequest.count({ where: { locationId: here.id } }), 1, 'only the valid request was filed');
    });
  } finally {
    await prisma.joinRequest.deleteMany({ where: { locationId: here.id } });
    await prisma.otpCode.deleteMany({ where: { phone: { in: [fresh, takenElsewhere, deactivated].map(e164Of) } } });
    await prisma.user.deleteMany({ where: { locationId: { in: [here.id, elsewhere.id] } } });
    await prisma.location.deleteMany({ where: { id: { in: [here.id, elsewhere.id] } } });
  }
});

test('staff directory: create stores E.164, rejects a non-mobile with 400, and a number already held (any format) is a 409, not a 500', async () => {
  const location = await makeLocation('staff');
  const manager = await prisma.user.create({ data: { locationId: location.id, fullName: '__phone-e164-test__ manager', systemRole: 'MANAGER' } });
  const { plainToken } = await issueSession(manager.id);
  const local = localPhone();
  try {
    await withServer(async (baseUrl) => {
      const created = await post(baseUrl, '/api/staff-directory', { fullName: '__phone-e164-test__ hire', phone: `050 ${local.slice(3)}` }, plainToken);
      assert.equal(created.status, 201);
      const { id } = (await created.json()) as { id: string };
      assert.equal((await prisma.user.findUniqueOrThrow({ where: { id } })).phone, e164Of(local));

      const landline = await post(baseUrl, '/api/staff-directory', { fullName: '__phone-e164-test__ landline', phone: '04 345 6789' }, plainToken);
      assert.equal(landline.status, 400);
      assert.equal(((await landline.json()) as { error: string }).error, INVALID_PHONE_ERROR);

      // Same number, different spelling: before E.164 this slipped past the unique index.
      const dup = await post(baseUrl, '/api/staff-directory', { fullName: '__phone-e164-test__ dup', phone: `+971${local.slice(1)}` }, plainToken);
      assert.equal(dup.status, 409);
    });
  } finally {
    await prisma.session.deleteMany({ where: { userId: manager.id } });
    await prisma.auditLog.deleteMany({ where: { locationId: location.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { locationId: location.id } });
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});
