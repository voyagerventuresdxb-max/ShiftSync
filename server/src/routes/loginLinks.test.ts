import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { PrismaClient, type SystemRole } from '@prisma/client';
import { createApp } from '../app.js';
import { hashOtp, issueSession, resolveSession } from '../lib/identity.js';
import { loginLinkIssueRateLimiter } from '../middleware/rateLimit.js';

/**
 * Real app, real DB, real limiter singletons — no mocking (this codebase's
 * convention). Everything a login link can do, from every kind of issuer.
 */
const prisma = new PrismaClient();
const TAG = '__login-links-test__';

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

async function makeVenue(label: string, setUp = true) {
  const org = await prisma.organization.create({ data: { name: `${TAG} ${label} ${Date.now()}` } });
  const location = await prisma.location.create({
    data: { organizationId: org.id, name: `${label} venue`, emirate: setUp ? 'Dubai' : null, venueType: setUp ? 'Fine Dining' : null },
  });
  return { org, location };
}

async function makeUser(locationId: string, systemRole: SystemRole, fullName: string, extra: { isPlatformAdmin?: boolean; isActive?: boolean } = {}) {
  return prisma.user.create({ data: { locationId, systemRole, fullName: `${TAG} ${fullName}`, ...extra } });
}

async function sessionFor(userId: string): Promise<string> {
  return (await issueSession(userId)).plainToken;
}

async function issue(baseUrl: string, token: string | null, userId: string) {
  return fetch(`${baseUrl}/api/login-links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ userId }),
  });
}

/**
 * Issues and asserts 201. The real per-session limiter (10/hour, see
 * loginLinkRateLimit.test.ts for its own coverage) would trip partway
 * through this file since a handful of fixture issuers mint dozens of links
 * here, so each helper call clears that issuer's bucket first — the
 * limiter's public resetKey, no production seam.
 */
async function issueOk(baseUrl: string, token: string, userId: string) {
  const issuerId = (await resolveSession(token))!.id;
  await loginLinkIssueRateLimiter.resetKey(issuerId);
  const res = await issue(baseUrl, token, userId);
  const text = await res.text();
  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${text}`);
  return JSON.parse(text) as { id: string; url: string; expiresAt: string; shareText: string };
}

function tokenOf(url: string): string {
  return url.slice(url.indexOf('#') + 1);
}

async function postToken(baseUrl: string, path: 'peek' | 'redeem', token: string) {
  return fetch(`${baseUrl}/api/login-links/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
}

async function body(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

// One fixture set for the whole file — two organizations, three locations.
const A = await makeVenue('OrgA-1');
const A2loc = await prisma.location.create({ data: { organizationId: A.org.id, name: 'OrgA-2 venue', emirate: 'Dubai', venueType: 'Bar / Lounge' } });
const B = await makeVenue('OrgB');
const ownerA = await makeUser(A.location.id, 'OWNER', 'Owner A');
const managerA1 = await makeUser(A.location.id, 'MANAGER', 'Manager A1');
const managerA1b = await makeUser(A.location.id, 'MANAGER', 'Manager A1 second');
const staffA1 = await makeUser(A.location.id, 'STAFF', 'Staff A1');
const staffA1inactive = await makeUser(A.location.id, 'STAFF', 'Staff A1 inactive', { isActive: false });
const managerA2 = await makeUser(A2loc.id, 'MANAGER', 'Manager A2');
const staffA2 = await makeUser(A2loc.id, 'STAFF', 'Staff A2');
const ownerB = await makeUser(B.location.id, 'OWNER', 'Owner B');
const managerB = await makeUser(B.location.id, 'MANAGER', 'Manager B');
const staffB = await makeUser(B.location.id, 'STAFF', 'Staff B');
// Platform admin deliberately has the lowest venue role: the flag, not the role, is what grants it.
const admin = await makeUser(B.location.id, 'STAFF', 'Platform Admin', { isPlatformAdmin: true });

const tokens = {
  ownerA: await sessionFor(ownerA.id),
  managerA1: await sessionFor(managerA1.id),
  managerB: await sessionFor(managerB.id),
  staffA1: await sessionFor(staffA1.id),
  admin: await sessionFor(admin.id),
};

after(async () => {
  await prisma.organization.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.$disconnect();
});

test('manager → own staff: 201 with a fragment URL, a 24h expiry, share text naming the venue, and an audit row', async () => {
  await withServer(async (baseUrl) => {
    const before = Date.now();
    const link = await issueOk(baseUrl, tokens.managerA1, staffA1.id);
    assert.match(link.url, /^http:\/\/localhost:5173\/login\/link#[A-Za-z0-9_-]{43}$/);
    const ttlMs = new Date(link.expiresAt).getTime() - before;
    assert.ok(ttlMs > 23.9 * 3600_000 && ttlMs < 24.1 * 3600_000, `expiry should be ~24h out, was ${ttlMs / 3600_000}h`);
    assert.match(link.shareText, /works once/);
    assert.match(link.shareText, /24 hours/);
    assert.match(link.shareText, /OrgA-1 venue/);
    const audit = await prisma.auditLog.findFirst({ where: { action: 'LOGIN_LINK_ISSUED', entityId: link.id } });
    assert.ok(audit, 'LOGIN_LINK_ISSUED must be audited');
    assert.equal(audit!.actorId, managerA1.id);
    assert.equal(audit!.locationId, A.location.id);
  });
});

test('manager scope: anyone but STAFF at their own location is a 404 (other location, any manager, owner, self, other org, inactive, unknown id)', async () => {
  await withServer(async (baseUrl) => {
    for (const [label, id] of [
      ['staff at another location of the same org', staffA2.id],
      ['a fellow manager at own location', managerA1b.id],
      ['a manager at another location', managerA2.id],
      ['the owner', ownerA.id],
      ['themselves', managerA1.id],
      ['staff in another organization', staffB.id],
      ['an inactive staff member', staffA1inactive.id],
      ['an unknown id', 'nope-not-a-user'],
    ] as const) {
      const res = await issue(baseUrl, tokens.managerA1, id);
      assert.equal(res.status, 404, `manager → ${label} must be 404`);
    }
  });
});

test('owner scope: managers and staff at any location of their own organization; nothing in another org, no other owners, not self', async () => {
  await withServer(async (baseUrl) => {
    await issueOk(baseUrl, tokens.ownerA, managerA1.id);
    await issueOk(baseUrl, tokens.ownerA, staffA2.id);
    await issueOk(baseUrl, tokens.ownerA, managerA2.id);
    for (const [label, id] of [
      ['staff in another org', staffB.id],
      ['a manager in another org', managerB.id],
      ['another owner', ownerB.id],
      ['themselves', ownerA.id],
    ] as const) {
      const res = await issue(baseUrl, tokens.ownerA, id);
      assert.equal(res.status, 404, `owner → ${label} must be 404`);
    }
  });
});

test('platform admin (flag on a STAFF-role user): owners and managers in any venue; never staff', async () => {
  await withServer(async (baseUrl) => {
    await issueOk(baseUrl, tokens.admin, ownerA.id);
    await issueOk(baseUrl, tokens.admin, managerB.id);
    await issueOk(baseUrl, tokens.admin, managerA2.id);
    assert.equal((await issue(baseUrl, tokens.admin, staffA1.id)).status, 404, 'admin → staff must be 404');
    assert.equal((await issue(baseUrl, tokens.admin, admin.id)).status, 404, 'admin → self must be 404');
  });
});

test('a plain STAFF session is refused outright (403); no session is 401; a blank userId is 400', async () => {
  await withServer(async (baseUrl) => {
    assert.equal((await issue(baseUrl, tokens.staffA1, managerA1.id)).status, 403);
    assert.equal((await issue(baseUrl, null, staffA1.id)).status, 401);
    assert.equal((await issue(baseUrl, tokens.managerA1, '')).status, 400);
  });
});

test('peek shows who the link is for and NEVER consumes it', async () => {
  await withServer(async (baseUrl) => {
    const link = await issueOk(baseUrl, tokens.managerA1, staffA1.id);
    const sessionsBefore = await prisma.session.count({ where: { userId: staffA1.id } });
    for (let i = 0; i < 3; i++) {
      const res = await postToken(baseUrl, 'peek', tokenOf(link.url));
      assert.equal(res.status, 200);
      const b = await body(res);
      assert.equal(b.fullName, `${TAG} Staff A1`);
      assert.equal(b.venueName, 'OrgA-1 venue');
    }
    const row = await prisma.loginLink.findUniqueOrThrow({ where: { id: link.id } });
    assert.equal(row.consumedAt, null, 'peek must not set consumedAt');
    assert.equal(await prisma.session.count({ where: { userId: staffA1.id } }), sessionsBefore, 'peek must not issue a session');
  });
});

test('redeem (the tap): issues a real session once, records ip + audit, then the link is dead for peek and redeem', async () => {
  await withServer(async (baseUrl) => {
    const link = await issueOk(baseUrl, tokens.managerA1, staffA1.id);
    const res = await postToken(baseUrl, 'redeem', tokenOf(link.url));
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const b = JSON.parse(text) as { token: string; user: { id: string; systemRole: string }; landing: string };
    assert.equal(b.user.id, staffA1.id);
    assert.equal(b.landing, '/my-shifts');
    const resolved = await resolveSession(b.token);
    assert.equal(resolved?.id, staffA1.id, 'the returned token must resolve to a real session for the target');

    const row = await prisma.loginLink.findUniqueOrThrow({ where: { id: link.id } });
    assert.ok(row.consumedAt, 'consumedAt set');
    assert.ok(row.redeemedIp, 'redeemedIp recorded');
    assert.ok(await prisma.auditLog.findFirst({ where: { action: 'LOGIN_LINK_REDEEMED', entityId: link.id, actorId: staffA1.id } }));

    const again = await postToken(baseUrl, 'redeem', tokenOf(link.url));
    assert.equal(again.status, 410);
    assert.equal((await body(again)).errorCode, 'link_used');
    assert.ok(await prisma.auditLog.findFirst({ where: { action: 'LOGIN_LINK_REJECTED', entityId: link.id } }), 'a refused redeem is audited');
    const peek = await postToken(baseUrl, 'peek', tokenOf(link.url));
    assert.equal(peek.status, 410);
  });
});

test('single use under concurrent redeem: six simultaneous taps, exactly one session', async () => {
  await withServer(async (baseUrl) => {
    const link = await issueOk(baseUrl, tokens.managerA1, staffA1.id);
    const results = await Promise.all(Array.from({ length: 6 }, () => postToken(baseUrl, 'redeem', tokenOf(link.url))));
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 410, 410, 410, 410, 410]);
    assert.equal(await prisma.auditLog.count({ where: { action: 'LOGIN_LINK_REDEEMED', entityId: link.id } }), 1);
  });
});

test('expiry: an expired link is 410 link_expired for peek and redeem; LOGIN_LINK_TTL_HOURS sets the window', async () => {
  const plain = randomBytes(32).toString('base64url');
  const expired = await prisma.loginLink.create({
    data: { tokenHash: hashOtp(plain), userId: staffA1.id, issuedById: managerA1.id, locationId: A.location.id, expiresAt: new Date(Date.now() - 1000) },
  });
  await withServer(async (baseUrl) => {
    const peek = await postToken(baseUrl, 'peek', plain);
    assert.equal(peek.status, 410);
    assert.equal((await body(peek)).errorCode, 'link_expired');
    const redeem = await postToken(baseUrl, 'redeem', plain);
    assert.equal(redeem.status, 410);
    assert.equal((await body(redeem)).errorCode, 'link_expired');
    assert.equal((await prisma.loginLink.findUniqueOrThrow({ where: { id: expired.id } })).consumedAt, null);

    const previous = process.env.LOGIN_LINK_TTL_HOURS;
    process.env.LOGIN_LINK_TTL_HOURS = '2';
    try {
      const before = Date.now();
      const link = await issueOk(baseUrl, tokens.managerA1, staffA1.id);
      const ttlMs = new Date(link.expiresAt).getTime() - before;
      assert.ok(ttlMs > 1.9 * 3600_000 && ttlMs < 2.1 * 3600_000, `expiry should follow LOGIN_LINK_TTL_HOURS=2, was ${ttlMs / 3600_000}h`);
      assert.match(link.shareText, /2 hours/);
    } finally {
      if (previous === undefined) delete process.env.LOGIN_LINK_TTL_HOURS;
      else process.env.LOGIN_LINK_TTL_HOURS = previous;
    }
  });
});

test('reissue revokes the earlier link for the same person (audited); only the newest works', async () => {
  await withServer(async (baseUrl) => {
    const first = await issueOk(baseUrl, tokens.managerA1, staffA1.id);
    const second = await issueOk(baseUrl, tokens.ownerA, staffA1.id);
    const firstRow = await prisma.loginLink.findUniqueOrThrow({ where: { id: first.id } });
    assert.ok(firstRow.revokedAt, 'the earlier link is revoked on reissue');
    const dead = await postToken(baseUrl, 'redeem', tokenOf(first.url));
    assert.equal(dead.status, 410);
    assert.equal((await body(dead)).errorCode, 'link_revoked');
    assert.ok(await prisma.auditLog.findFirst({ where: { action: 'LOGIN_LINK_REVOKED', entityId: staffA1.id, note: { contains: 'superseded' } } }));
    assert.equal((await postToken(baseUrl, 'redeem', tokenOf(second.url))).status, 200);
  });
});

test('DELETE revokes: by the issuer or anyone in scope; a manager from another org gets 404', async () => {
  await withServer(async (baseUrl) => {
    const link = await issueOk(baseUrl, tokens.managerA1, staffA1.id);
    const foreign = await fetch(`${baseUrl}/api/login-links/${link.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tokens.managerB}` } });
    assert.equal(foreign.status, 404, 'out-of-scope revoke must be 404');
    assert.equal((await postToken(baseUrl, 'peek', tokenOf(link.url))).status, 200, 'still live after the refused revoke');

    const own = await fetch(`${baseUrl}/api/login-links/${link.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tokens.ownerA}` } });
    assert.equal(own.status, 204, 'the owner (in scope for this staff member) may revoke');
    const dead = await postToken(baseUrl, 'redeem', tokenOf(link.url));
    assert.equal(dead.status, 410);
    assert.equal((await body(dead)).errorCode, 'link_revoked');
    assert.equal((await fetch(`${baseUrl}/api/login-links/does-not-exist`, { method: 'DELETE', headers: { Authorization: `Bearer ${tokens.ownerA}` } })).status, 404);
  });
});

test('landing: an owner of a bare venue shell lands in the wizard at Venue; everyone else on /my-shifts', async () => {
  const shell = await makeVenue('Shell', false);
  const shellOwner = await makeUser(shell.location.id, 'OWNER', 'Shell Owner');
  await withServer(async (baseUrl) => {
    const link = await issueOk(baseUrl, tokens.admin, shellOwner.id);
    const res = await postToken(baseUrl, 'redeem', tokenOf(link.url));
    assert.equal(res.status, 200);
    assert.equal((await body(res)).landing, '/onboarding/venue');

    const setUpLink = await issueOk(baseUrl, tokens.admin, ownerA.id);
    const setUp = await postToken(baseUrl, 'redeem', tokenOf(setUpLink.url));
    assert.equal((await body(setUp)).landing, '/my-shifts', 'an owner whose venue is set up does not re-enter the wizard');
  });
});

test('a link for someone deactivated after it was issued cannot be redeemed', async () => {
  const leaver = await makeUser(A.location.id, 'STAFF', 'Leaver');
  await withServer(async (baseUrl) => {
    const link = await issueOk(baseUrl, tokens.managerA1, leaver.id);
    await prisma.user.update({ where: { id: leaver.id }, data: { isActive: false } });
    const res = await postToken(baseUrl, 'redeem', tokenOf(link.url));
    assert.equal(res.status, 410);
    assert.equal((await body(res)).errorCode, 'link_inactive');
  });
});

test('malformed and unknown tokens: 400 for junk, 404 link_unknown for a well-formed token nobody minted', async () => {
  await withServer(async (baseUrl) => {
    assert.equal((await postToken(baseUrl, 'redeem', 'nope')).status, 400);
    assert.equal((await postToken(baseUrl, 'peek', '')).status, 400);
    const ghost = await postToken(baseUrl, 'redeem', randomBytes(32).toString('base64url'));
    assert.equal(ghost.status, 404);
    assert.equal((await body(ghost)).errorCode, 'link_unknown');
    // A pasted full URL is accepted too — the route extracts the fragment.
    const link = await issueOk(baseUrl, tokens.managerA1, staffA1.id);
    assert.equal((await postToken(baseUrl, 'peek', link.url)).status, 200);
  });
});

test('LOGIN_METHODS: links-only (default) closes the phone-code routes with 403 otp_disabled; otp reopens them', async () => {
  const previous = process.env.LOGIN_METHODS;
  await withServer(async (baseUrl) => {
    try {
      delete process.env.LOGIN_METHODS;
      for (const path of ['/api/identity/request-otp', '/api/join/request-otp', '/api/signup/request-otp', '/api/identity/verify-otp']) {
        const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '0501234567', code: '000000' }) });
        assert.equal(res.status, 403, `${path} must be closed in links mode`);
        assert.equal((await body(res)).errorCode, 'otp_disabled');
      }
      const config = await fetch(`${baseUrl}/api/identity/config`);
      assert.deepEqual(await config.json(), { loginMethods: 'links' });

      process.env.LOGIN_METHODS = 'otp';
      const reopened = await fetch(`${baseUrl}/api/identity/request-otp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '0500000000' }) });
      assert.notEqual(reopened.status, 403);
      assert.deepEqual(await (await fetch(`${baseUrl}/api/identity/config`)).json(), { loginMethods: 'otp' });
    } finally {
      if (previous === undefined) delete process.env.LOGIN_METHODS;
      else process.env.LOGIN_METHODS = previous;
    }
  });
});
