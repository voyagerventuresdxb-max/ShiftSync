import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { PrismaClient, type User } from '@prisma/client';
import { createApp } from '../app.js';
import { createOtpCode, issueSession } from '../lib/identity.js';
import { consumeInviteUse, generateInviteToken, INVITE_REJECTION_MESSAGES } from '../lib/inviteLinks.js';

const prisma = new PrismaClient();
const TAG = '__invite-links-test__';
const DAY = 24 * 60 * 60 * 1000;

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

async function call(baseUrl: string, method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A throwaway venue with an OWNER and a session for them; deleting it cascades to links, requests and users. */
async function makeVenue(name: string) {
  const seed = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seed, 'seed data (a location) must exist to run this test');
  const location = await prisma.location.create({ data: { organizationId: seed!.organizationId, name: `${TAG} ${name}`, timezone: 'Asia/Dubai' } });
  const owner = await prisma.user.create({ data: { locationId: location.id, fullName: `${TAG} Owner`, systemRole: 'OWNER' } });
  const { plainToken } = await issueSession(owner.id);
  return { location, owner, ownerToken: plainToken };
}

async function makeLink(locationId: string, data: { expiresAt?: Date; revokedAt?: Date | null; maxUses?: number | null; useCount?: number } = {}) {
  return prisma.inviteLink.create({
    data: { locationId, token: generateInviteToken(), expiresAt: data.expiresAt ?? new Date(Date.now() + 30 * DAY), revokedAt: data.revokedAt ?? null, maxUses: data.maxUses ?? null, useCount: data.useCount ?? 0 },
  });
}

async function cleanup(locationIds: string[], phones: string[]) {
  await prisma.otpCode.deleteMany({ where: { phone: { in: phones } } });
  await prisma.session.deleteMany({ where: { user: { locationId: { in: locationIds } } } });
  await prisma.auditLog.deleteMany({ where: { locationId: { in: locationIds } } }).catch(() => {});
  await prisma.location.deleteMany({ where: { id: { in: locationIds } } });
}

async function join(baseUrl: string, body: { inviteToken?: string; locationId?: string }, p: string, fullName?: string) {
  const { plainCode } = await createOtpCode(p, 'JOIN');
  return call(baseUrl, 'POST', '/api/join/verify-otp', { ...body, phone: p, code: plainCode, fullName });
}

test('generateInviteToken: 43 base64url chars (32 random bytes), never repeated', () => {
  const tokens = Array.from({ length: 500 }, generateInviteToken);
  for (const t of tokens) {
    assert.match(t, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(t, 'base64url').length, 32);
  }
  assert.equal(new Set(tokens).size, tokens.length);
});

test('manager API: GET is null until a link exists; regenerate revokes the previous link; revoke leaves none; every change is audited without the token', async () => {
  const { location, owner, ownerToken } = await makeVenue('manager api');
  try {
    await withServer(async (baseUrl) => {
      const base = `/api/invites/${location.id}`;
      assert.deepEqual((await call(baseUrl, 'GET', base, undefined, ownerToken)).body, { active: null });

      const first = await call(baseUrl, 'POST', `${base}/regenerate`, { expiresInDays: 7, maxUses: 10 }, ownerToken);
      assert.equal(first.status, 201);
      const a = first.body.active as Record<string, unknown>;
      assert.match(String(a.inviteUrl), /^http:\/\/localhost:5173\/join\?invite=[A-Za-z0-9_-]{43}$/);
      assert.equal(a.maxUses, 10);
      assert.equal(a.useCount, 0);
      assert.ok(Math.abs(new Date(String(a.expiresAt)).getTime() - (Date.now() + 7 * DAY)) < 60_000);
      assert.ok(String(a.qrDataUrl).startsWith('data:image/'));
      assert.ok(String(a.whatsappUrl).includes(encodeURIComponent(String(a.inviteUrl))));
      assert.deepEqual((await call(baseUrl, 'GET', base, undefined, ownerToken)).body.active, a, 'GET returns the same active link');

      const second = await call(baseUrl, 'POST', `${base}/regenerate`, {}, ownerToken);
      assert.equal(second.status, 201);
      const b = second.body.active as Record<string, unknown>;
      assert.notEqual(b.inviteUrl, a.inviteUrl);
      assert.equal(b.maxUses, null);
      assert.ok(Math.abs(new Date(String(b.expiresAt)).getTime() - (Date.now() + 30 * DAY)) < 60_000, 'default expiry is 30 days');

      const links = await prisma.inviteLink.findMany({ where: { locationId: location.id }, orderBy: { createdAt: 'asc' } });
      assert.equal(links.length, 2);
      assert.ok(links[0]!.revokedAt, 'regenerate revoked the previous link');
      assert.equal(links[1]!.revokedAt, null);
      assert.equal(links[1]!.createdById, owner.id);

      const revoked = await call(baseUrl, 'POST', `${base}/revoke`, undefined, ownerToken);
      assert.deepEqual(revoked.body, { active: null, revoked: 1 });
      assert.deepEqual((await call(baseUrl, 'GET', base, undefined, ownerToken)).body, { active: null });
      assert.equal(await prisma.inviteLink.count({ where: { locationId: location.id, revokedAt: null } }), 0);

      const audit = await prisma.auditLog.findMany({ where: { locationId: location.id }, orderBy: { createdAt: 'asc' } });
      assert.deepEqual(
        audit.map((r) => r.action),
        ['INVITE_LINK_CREATED', 'INVITE_LINK_REVOKED', 'INVITE_LINK_CREATED', 'INVITE_LINK_REVOKED'],
      );
      assert.ok(audit.every((r) => r.actorId === owner.id && r.entityType === 'InviteLink'));
      for (const link of links) assert.ok(audit.every((r) => !(r.note ?? '').includes(link.token)), 'audit notes never carry the token');

      for (const bad of [{ expiresInDays: 0 }, { expiresInDays: 91 }, { expiresInDays: 2.5 }, { expiresInDays: '7' }, { maxUses: 0 }, { maxUses: 1001 }, { maxUses: 'lots' }]) {
        const res = await call(baseUrl, 'POST', `${base}/regenerate`, bad, ownerToken);
        assert.equal(res.status, 400, JSON.stringify(bad));
      }
      assert.equal(await prisma.inviteLink.count({ where: { locationId: location.id } }), 2, 'a rejected body creates nothing');
    });
  } finally {
    await cleanup([location.id], []);
  }
});

test('manager API: another venue’s manager and staff get 403 and change nothing; no session is a 401', async () => {
  const a = await makeVenue('tenant A');
  const b = await makeVenue('tenant B');
  const staff = await prisma.user.create({ data: { locationId: a.location.id, fullName: `${TAG} Staff`, systemRole: 'STAFF' } });
  const { plainToken: staffToken } = await issueSession(staff.id);
  const link = await makeLink(a.location.id);
  try {
    await withServer(async (baseUrl) => {
      const base = `/api/invites/${a.location.id}`;
      for (const token of [b.ownerToken, staffToken]) {
        const get = await call(baseUrl, 'GET', base, undefined, token);
        assert.equal(get.status, 403);
        assert.ok(!JSON.stringify(get.body).includes(link.token));
        assert.equal((await call(baseUrl, 'POST', `${base}/regenerate`, {}, token)).status, 403);
        assert.equal((await call(baseUrl, 'POST', `${base}/revoke`, undefined, token)).status, 403);
        assert.equal((await call(baseUrl, 'GET', `/api/onboarding/${a.location.id}/invite`, undefined, token)).status, 403);
      }
      assert.equal((await call(baseUrl, 'GET', base)).status, 401);
    });
    const after = await prisma.inviteLink.findMany({ where: { locationId: a.location.id } });
    assert.equal(after.length, 1);
    assert.equal(after[0]!.revokedAt, null);
  } finally {
    await cleanup([a.location.id, b.location.id], []);
  }
});

test('GET /api/join/invite/:token: venue name for a usable link; 410 with a reason and message otherwise', async () => {
  const { location } = await makeVenue('peek');
  const ok = await makeLink(location.id);
  const expired = await makeLink(location.id, { expiresAt: new Date(Date.now() - 1000) });
  const revoked = await makeLink(location.id, { revokedAt: new Date() });
  const usedUp = await makeLink(location.id, { maxUses: 2, useCount: 2 });
  try {
    await withServer(async (baseUrl) => {
      const good = await call(baseUrl, 'GET', `/api/join/invite/${ok.token}`);
      assert.deepEqual(good, { status: 200, body: { venueName: location.name, expiresAt: ok.expiresAt.toISOString() } });

      const cases: Array<[string, string]> = [
        [expired.token, 'expired'],
        [revoked.token, 'revoked'],
        [usedUp.token, 'used_up'],
        [generateInviteToken(), 'not_found'],
        ['short', 'not_found'],
      ];
      for (const [token, reason] of cases) {
        const res = await call(baseUrl, 'GET', `/api/join/invite/${token}`);
        assert.equal(res.status, 410, reason);
        assert.deepEqual(res.body, { reason, error: INVITE_REJECTION_MESSAGES[reason as keyof typeof INVITE_REJECTION_MESSAGES] });
        assert.ok(!JSON.stringify(res.body).includes(location.name), 'a dead link does not name the venue');
      }
      assert.equal(INVITE_REJECTION_MESSAGES.expired, 'This invite link has expired — ask your manager for a new one.');
    });
  } finally {
    await cleanup([location.id], []);
  }
});

test('GET /api/join/invite/:token is rate limited per client (60 per 15 minutes)', async () => {
  await withServer(async (baseUrl) => {
    const headers = { 'X-Real-IP': `198.51.100.${Math.floor(Math.random() * 250)}`, 'X-Vercel-Forwarded-For': `203.0.113.${Math.floor(Math.random() * 250)}` };
    for (let i = 0; i < 60; i++) assert.equal((await call(baseUrl, 'GET', '/api/join/invite/nope', undefined, undefined, headers)).status, 410);
    assert.equal((await call(baseUrl, 'GET', '/api/join/invite/nope', undefined, undefined, headers)).status, 429);
  });
});

test('join via token: files a request and counts one use; re-verifying while pending counts nothing; a dead link files nothing', async () => {
  const { location } = await makeVenue('join token');
  const link = await makeLink(location.id, { maxUses: 5 });
  const expired = await makeLink(location.id, { expiresAt: new Date(Date.now() - 1000) });
  const revoked = await makeLink(location.id, { revokedAt: new Date() });
  const [p, q, r] = [phone(), phone(), phone()];
  try {
    await withServer(async (baseUrl) => {
      const first = await join(baseUrl, { inviteToken: link.token }, p, `${TAG} P`);
      assert.equal(first.status, 201);
      assert.equal(first.body.venueName, location.name);
      assert.equal((await prisma.inviteLink.findUniqueOrThrow({ where: { id: link.id } })).useCount, 1);

      const again = await join(baseUrl, { inviteToken: link.token }, p);
      assert.equal(again.status, 200);
      assert.equal(again.body.joinRequestId, first.body.joinRequestId);
      assert.equal((await prisma.inviteLink.findUniqueOrThrow({ where: { id: link.id } })).useCount, 1, 'a returning applicant does not use the link again');

      for (const [token, reason] of [
        [expired.token, 'expired'],
        [revoked.token, 'revoked'],
        [generateInviteToken(), 'not_found'],
      ] as const) {
        const res = await join(baseUrl, { inviteToken: token }, q, `${TAG} Q`);
        assert.equal(res.status, 410, reason);
        assert.deepEqual(res.body, { reason, error: INVITE_REJECTION_MESSAGES[reason] });
      }
      // The token wins over a locationId sent alongside it.
      const both = await join(baseUrl, { inviteToken: expired.token, locationId: location.id }, r, `${TAG} R`);
      assert.equal(both.status, 410);
      assert.equal(await prisma.joinRequest.count({ where: { phone: { in: [q, r] } } }), 0);
      assert.equal((await call(baseUrl, 'POST', '/api/join/verify-otp', { phone: q, code: '123456' })).status, 400);
    });
  } finally {
    await cleanup([location.id], [p, q, r]);
  }
});

test('join via token: maxUses is enforced, and two concurrent joins on the last use leave exactly one request', async () => {
  const { location } = await makeVenue('max uses');
  const link = await makeLink(location.id, { maxUses: 1 });
  const [p, q, r] = [phone(), phone(), phone()];
  try {
    await withServer(async (baseUrl) => {
      const results = await Promise.all([join(baseUrl, { inviteToken: link.token }, p, `${TAG} P`), join(baseUrl, { inviteToken: link.token }, q, `${TAG} Q`)]);
      assert.deepEqual(results.map((x) => x.status).sort(), [201, 410]);
      assert.equal(results.find((x) => x.status === 410)!.body.reason, 'used_up');
      assert.equal(await prisma.joinRequest.count({ where: { locationId: location.id } }), 1);
      assert.equal((await prisma.inviteLink.findUniqueOrThrow({ where: { id: link.id } })).useCount, 1);

      const late = await join(baseUrl, { inviteToken: link.token }, r, `${TAG} R`);
      assert.equal(late.status, 410);
      assert.equal(late.body.error, INVITE_REJECTION_MESSAGES.used_up);
    });
  } finally {
    await cleanup([location.id], [p, q, r]);
  }
});

test('consumeInviteUse is one atomic UPDATE: two transactions racing for the last use, on separate connections, get exactly one', async () => {
  const { location } = await makeVenue('atomic');
  const link = await makeLink(location.id, { maxUses: 1 });
  const other = new PrismaClient();
  try {
    const attempt = (client: PrismaClient, holdMs: number) =>
      client.$transaction(async (tx) => {
        const ok = await consumeInviteUse(tx, link.id);
        await tx.$queryRaw`SELECT pg_sleep(${holdMs / 1000})::text`;
        return ok;
      });
    const outcomes = await Promise.all([attempt(prisma, 300), attempt(other, 0)]);
    assert.deepEqual(outcomes.sort(), [false, true]);
    assert.equal((await prisma.inviteLink.findUniqueOrThrow({ where: { id: link.id } })).useCount, 1);
  } finally {
    await other.$disconnect();
    await cleanup([location.id], []);
  }
});

test('join via token: an existing active staff member gets a session and uses the link; a dead link gives no session', async () => {
  const { location } = await makeVenue('auto claim');
  const link = await makeLink(location.id, { maxUses: 3 });
  const dead = await makeLink(location.id, { revokedAt: new Date() });
  const p = phone();
  const staff: User = await prisma.user.create({ data: { locationId: location.id, fullName: `${TAG} Staff`, phone: p } });
  try {
    await withServer(async (baseUrl) => {
      const refused = await join(baseUrl, { inviteToken: dead.token }, p);
      assert.equal(refused.status, 410);
      assert.equal(refused.body.token, undefined);
      assert.equal(await prisma.session.count({ where: { userId: staff.id } }), 0);

      const ok = await join(baseUrl, { inviteToken: link.token }, p);
      assert.equal(ok.status, 200);
      assert.equal(ok.body.pending, false);
      assert.equal((ok.body.user as { id: string }).id, staff.id);
      assert.equal((await prisma.inviteLink.findUniqueOrThrow({ where: { id: link.id } })).useCount, 1);
    });
  } finally {
    await cleanup([location.id], [p]);
  }
});

test('legacy ?location= joins: accepted while legacyJoinLinksUntil is in the future, 410 legacy_expired once it passes or when unset', async () => {
  const { location } = await makeVenue('legacy');
  const [p, q, r] = [phone(), phone(), phone()];
  try {
    await withServer(async (baseUrl) => {
      await prisma.location.update({ where: { id: location.id }, data: { legacyJoinLinksUntil: new Date(Date.now() + DAY) } });
      const inside = await join(baseUrl, { locationId: location.id }, p, `${TAG} P`);
      assert.equal(inside.status, 201);

      await prisma.location.update({ where: { id: location.id }, data: { legacyJoinLinksUntil: new Date(Date.now() - 1000) } });
      const after = await join(baseUrl, { locationId: location.id }, q, `${TAG} Q`);
      assert.deepEqual(after, { status: 410, body: { reason: 'legacy_expired', error: 'This invite link has expired — ask your manager for a new one.' } });

      await prisma.location.update({ where: { id: location.id }, data: { legacyJoinLinksUntil: null } });
      assert.equal((await join(baseUrl, { locationId: location.id }, r, `${TAG} R`)).status, 410);
      assert.equal(await prisma.joinRequest.count({ where: { phone: { in: [q, r] } } }), 0);

      assert.equal((await join(baseUrl, { locationId: 'no-such-location' }, r, `${TAG} R`)).status, 404);
    });
  } finally {
    await cleanup([location.id], [p, q, r]);
  }
});

test('GET /api/onboarding/:locationId/invite: the same active link on repeat (and concurrent) calls; a new one only once it is revoked', async () => {
  const { location, ownerToken } = await makeVenue('onboarding');
  try {
    await withServer(async (baseUrl) => {
      const path = `/api/onboarding/${location.id}/invite`;
      const [a, b] = await Promise.all([call(baseUrl, 'GET', path, undefined, ownerToken), call(baseUrl, 'GET', path, undefined, ownerToken)]);
      assert.equal(a.status, 200);
      assert.equal(a.body.inviteUrl, b.body.inviteUrl);
      assert.equal(a.body.maxUses, null);
      assert.equal(a.body.useCount, 0);
      assert.equal(typeof a.body.expiresAt, 'string');
      const c = await call(baseUrl, 'GET', path, undefined, ownerToken);
      assert.equal(c.body.inviteUrl, a.body.inviteUrl);
      assert.equal(await prisma.inviteLink.count({ where: { locationId: location.id } }), 1);

      await call(baseUrl, 'POST', `/api/invites/${location.id}/revoke`, undefined, ownerToken);
      const d = await call(baseUrl, 'GET', path, undefined, ownerToken);
      assert.notEqual(d.body.inviteUrl, a.body.inviteUrl);
      assert.equal(await prisma.inviteLink.count({ where: { locationId: location.id, revokedAt: null } }), 1);
    });
  } finally {
    await cleanup([location.id], []);
  }
});
