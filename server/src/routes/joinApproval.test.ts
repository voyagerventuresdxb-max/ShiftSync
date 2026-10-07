import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { PrismaClient, type User } from '@prisma/client';
import { createApp } from '../app.js';
import { createOtpCode, issueSession } from '../lib/identity.js';
import { generateInviteToken } from '../lib/inviteLinks.js';
import { joinDeclinedMessage, MAX_JOIN_ATTEMPTS } from '../lib/actions/joinActions.js';

const prisma = new PrismaClient();
const TAG = '__join-approval-test__';

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

/** A random valid UAE mobile in E.164. */
const phone = () => `+97150${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;

const send = (baseUrl: string, method: string, path: string, body: unknown, token?: string) =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

/** A throwaway venue; deleting it cascades to its users, requests and notifications. */
async function makeVenue(name: string, staff: { fullName: string; systemRole: 'OWNER' | 'MANAGER'; isActive?: boolean }[] = []) {
  const seed = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seed, 'seed data (a location) must exist to run this test');
  const location = await prisma.location.create({ data: { organizationId: seed!.organizationId, name: `${TAG} ${name}`, timezone: 'Asia/Dubai' } });
  const users: User[] = [];
  // Explicit, strictly increasing createdAt: "earliest" must not depend on millisecond ties.
  for (const [i, s] of staff.entries()) {
    users.push(await prisma.user.create({ data: { locationId: location.id, createdAt: new Date(Date.now() - (staff.length - i) * 1000), ...s } }));
  }
  return { location, users };
}

async function cleanup(locationIds: string[], phones: string[]) {
  await prisma.otpCode.deleteMany({ where: { phone: { in: phones } } });
  await prisma.auditLog.deleteMany({ where: { locationId: { in: locationIds } } }).catch(() => {});
  await prisma.location.deleteMany({ where: { id: { in: locationIds } } });
}

async function verifyLogin(baseUrl: string, p: string) {
  const { plainCode } = await createOtpCode(p, 'LOGIN');
  const res = await send(baseUrl, 'POST', '/api/identity/verify-otp', { phone: p, code: plainCode });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const inviteTokens = new Map<string, string>();

/** One live invite link per test venue, created on first use. */
async function inviteTokenFor(locationId: string): Promise<string> {
  let token = inviteTokens.get(locationId);
  if (!token) {
    token = generateInviteToken();
    await prisma.inviteLink.create({ data: { locationId, token, expiresAt: new Date(Date.now() + 86_400_000) } });
    inviteTokens.set(locationId, token);
  }
  return token;
}

async function verifyJoin(baseUrl: string, locationId: string, p: string, fullName?: string) {
  const { plainCode } = await createOtpCode(p, 'JOIN');
  const res = await send(baseUrl, 'POST', '/api/join/verify-otp', { inviteToken: await inviteTokenFor(locationId), phone: p, code: plainCode, fullName });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function poll<T>(read: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 50; i++) {
    const v = await read();
    if (done(v)) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  return read();
}

test('identity/request-otp: pending, declined and deactivated numbers get a code; an unknown number is still a 404 with no code', async () => {
  const { location } = await makeVenue('request-otp');
  const [pending, declined, deactivated, unknown] = [phone(), phone(), phone(), phone()];
  await prisma.joinRequest.create({ data: { locationId: location.id, phone: pending, fullName: `${TAG} pending`, status: 'PENDING' } });
  await prisma.joinRequest.create({ data: { locationId: location.id, phone: declined, fullName: `${TAG} declined`, status: 'DECLINED' } });
  await prisma.user.create({ data: { locationId: location.id, fullName: `${TAG} gone`, phone: deactivated, isActive: false } });
  try {
    await withServer(async (baseUrl) => {
      for (const p of [pending, declined, deactivated]) {
        const res = await send(baseUrl, 'POST', '/api/identity/request-otp', { phone: p });
        assert.equal(res.status, 200, `${p} must get a code`);
        const body = (await res.json()) as Record<string, unknown>;
        assert.deepEqual(Object.keys(body).filter((k) => k !== 'devCode'), ['expiresAt'], 'no status before the code is verified');
        assert.equal(await prisma.otpCode.count({ where: { phone: p, purpose: 'LOGIN' } }), 1);
      }
      const res = await send(baseUrl, 'POST', '/api/identity/request-otp', { phone: unknown });
      assert.equal(res.status, 404);
      assert.equal(((await res.json()) as { error: string }).error, 'No active account found with that phone number.');
      assert.equal(await prisma.otpCode.count({ where: { phone: unknown } }), 0);
    });
  } finally {
    await cleanup([location.id], [pending, declined, deactivated, unknown]);
  }
});

test('identity/verify-otp: active → session; pending → status with no token; declined/deactivated → 403 with a message; unknown → 404', async () => {
  const { location, users } = await makeVenue('verify-otp', [
    { fullName: `${TAG} Manager Early`, systemRole: 'MANAGER' },
    { fullName: `${TAG} Owner Late`, systemRole: 'OWNER' },
  ]);
  const [active, pending, declined, deactivated, unknown] = [phone(), phone(), phone(), phone(), phone()];
  const activeUser = await prisma.user.create({ data: { locationId: location.id, fullName: `${TAG} active`, phone: active } });
  const gone = await prisma.user.create({ data: { locationId: location.id, fullName: `${TAG} gone`, phone: deactivated, isActive: false } });
  await prisma.joinRequest.create({ data: { locationId: location.id, phone: pending, fullName: `${TAG} pending`, status: 'PENDING' } });
  await prisma.joinRequest.create({ data: { locationId: location.id, phone: declined, fullName: `${TAG} declined`, status: 'DECLINED' } });
  try {
    await withServer(async (baseUrl) => {
      const ok = await verifyLogin(baseUrl, active);
      assert.equal(ok.status, 200);
      assert.ok(typeof ok.body.token === 'string' && ok.body.token.length > 0);
      assert.equal((ok.body.user as { id: string }).id, activeUser.id);
      assert.equal(ok.body.pending, undefined, 'success shape unchanged');

      const waiting = await verifyLogin(baseUrl, pending);
      assert.equal(waiting.status, 200);
      // The OWNER is named even though a MANAGER was created first.
      assert.deepEqual(waiting.body, { pending: true, status: 'pending', venueName: location.name, managerName: users[1]!.fullName });

      const no = await verifyLogin(baseUrl, declined);
      assert.equal(no.status, 403);
      assert.equal(no.body.status, 'declined');
      assert.equal(no.body.venueName, location.name);
      assert.match(String(no.body.error), /declined/);
      assert.equal(no.body.token, undefined);

      const off = await verifyLogin(baseUrl, deactivated);
      assert.equal(off.status, 403);
      assert.equal(off.body.status, 'deactivated');
      assert.equal(off.body.venueName, location.name);
      assert.match(String(off.body.error), /deactivated/);
      assert.equal(off.body.token, undefined);

      const none = await verifyLogin(baseUrl, unknown);
      assert.equal(none.status, 404);
    });
    assert.equal(await prisma.session.count({ where: { userId: gone.id } }), 0, 'no session for a deactivated user');
    assert.equal(await prisma.session.count({ where: { userId: activeUser.id } }), 1);
  } finally {
    await prisma.session.deleteMany({ where: { userId: activeUser.id } });
    await cleanup([location.id], [active, pending, declined, deactivated, unknown]);
  }
});

test('identity/verify-otp: a wrong code reveals nothing about a pending applicant', async () => {
  const { location } = await makeVenue('wrong code');
  const p = phone();
  await prisma.joinRequest.create({ data: { locationId: location.id, phone: p, fullName: `${TAG} pending`, status: 'PENDING' } });
  try {
    await withServer(async (baseUrl) => {
      const { plainCode } = await createOtpCode(p, 'LOGIN');
      const res = await send(baseUrl, 'POST', '/api/identity/verify-otp', { phone: p, code: plainCode === '111111' ? '222222' : '111111' });
      assert.equal(res.status, 401);
      assert.deepEqual(Object.keys((await res.json()) as object), ['error']);
    });
  } finally {
    await cleanup([location.id], [p]);
  }
});

test('managerName: falls back to the earliest active MANAGER, and to null when the venue has none', async () => {
  const withManager = await makeVenue('manager only', [
    { fullName: `${TAG} Owner Off`, systemRole: 'OWNER', isActive: false },
    { fullName: `${TAG} Manager First`, systemRole: 'MANAGER' },
    { fullName: `${TAG} Manager Second`, systemRole: 'MANAGER' },
  ]);
  const empty = await makeVenue('nobody');
  const [a, b] = [phone(), phone()];
  try {
    await withServer(async (baseUrl) => {
      const first = await verifyJoin(baseUrl, withManager.location.id, a, `${TAG} A`);
      assert.equal(first.status, 201);
      assert.equal(first.body.managerName, `${TAG} Manager First`);
      assert.equal(first.body.venueName, withManager.location.name);

      const second = await verifyJoin(baseUrl, empty.location.id, b, `${TAG} B`);
      assert.equal(second.status, 201);
      assert.equal(second.body.managerName, null);
      // Let the fire-and-forget manager notices land before the venue is deleted.
      await poll(() => prisma.notification.count({ where: { user: { locationId: withManager.location.id } } }), (n) => n >= 2);
    });
  } finally {
    await cleanup([withManager.location.id, empty.location.id], [a, b]);
  }
});

test('join/verify-otp: re-verifying while PENDING returns the same request, files no duplicate and pings managers once', async () => {
  const { location, users } = await makeVenue('re-verify', [{ fullName: `${TAG} Owner`, systemRole: 'OWNER' }]);
  const owner = users[0]!;
  const p = phone();
  try {
    await withServer(async (baseUrl) => {
      const first = await verifyJoin(baseUrl, location.id, p, `${TAG} Applicant`);
      assert.equal(first.status, 201);
      assert.equal(first.body.pending, true);
      assert.equal(first.body.managerName, owner.fullName);
      await poll(() => prisma.notification.count({ where: { userId: owner.id } }), (n) => n >= 1);

      // Returning without a name is fine: the request already exists.
      const again = await verifyJoin(baseUrl, location.id, p);
      assert.equal(again.status, 200);
      assert.deepEqual(again.body, { pending: true, joinRequestId: first.body.joinRequestId, venueName: location.name, managerName: owner.fullName });

      await new Promise((r) => setTimeout(r, 300));
      assert.equal(await prisma.joinRequest.count({ where: { phone: p } }), 1, 'no duplicate request');
      assert.equal(await prisma.notification.count({ where: { userId: owner.id } }), 1, 'managers pinged once');
    });
  } finally {
    await cleanup([location.id], [p]);
  }
});

test('join/verify-otp: a declined applicant may re-apply up to the cap; the next attempt is refused, files nothing and uses no invite', async () => {
  const { location, users } = await makeVenue('re-apply', [{ fullName: `${TAG} Owner`, systemRole: 'OWNER' }]);
  const { plainToken } = await issueSession(users[0]!.id);
  const p = phone();
  const where = { locationId: location.id, phone: p };
  const uses = async () => (await prisma.inviteLink.findUniqueOrThrow({ where: { token: await inviteTokenFor(location.id) } })).useCount;
  try {
    await withServer(async (baseUrl) => {
      const decline = async (id: unknown) => assert.equal((await send(baseUrl, 'PATCH', `/api/join/${id}`, { decision: 'decline' }, plainToken)).status, 200);
      const first = await verifyJoin(baseUrl, location.id, p, `${TAG} Applicant`);
      assert.equal(first.status, 201);
      await decline(first.body.joinRequestId);

      // Re-applying needs a name, as a first request does; the answer says why.
      const nameless = await verifyJoin(baseUrl, location.id, p);
      assert.equal(nameless.status, 400);
      assert.equal(nameless.body.status, 'declined');
      assert.equal(nameless.body.error, joinDeclinedMessage(location.name, true));
      assert.equal(await prisma.joinRequest.count({ where }), 1);
      assert.equal(await uses(), 1);

      const second = await verifyJoin(baseUrl, location.id, p, `${TAG} Applicant`);
      assert.equal(second.status, 201);
      assert.notEqual(second.body.joinRequestId, first.body.joinRequestId);
      assert.equal(await uses(), 2);
      // Re-verifying while the new request is open still files no duplicate.
      const again = await verifyJoin(baseUrl, location.id, p);
      assert.equal(again.status, 200);
      assert.equal(again.body.joinRequestId, second.body.joinRequestId);
      assert.equal(await prisma.joinRequest.count({ where }), 2);
      await decline(second.body.joinRequestId);

      const third = await verifyJoin(baseUrl, location.id, p, `${TAG} Applicant`);
      assert.equal(third.status, 201);
      await decline(third.body.joinRequestId);

      const fourth = await verifyJoin(baseUrl, location.id, p, `${TAG} Applicant`);
      assert.equal(fourth.status, 403);
      assert.deepEqual(fourth.body, {
        status: 'attempts_exhausted',
        venueName: location.name,
        error: `You've already applied to ${location.name} 3 times. Ask a manager there to add you.`,
      });
      assert.equal(await prisma.joinRequest.count({ where }), MAX_JOIN_ATTEMPTS);
      assert.equal(await prisma.joinRequest.count({ where: { ...where, status: 'PENDING' } }), 0);
      assert.equal(await uses(), 3);

      // /login no longer offers another try.
      const login = await verifyLogin(baseUrl, p);
      assert.equal(login.status, 403);
      assert.equal(login.body.status, 'declined');
      assert.equal(login.body.error, joinDeclinedMessage(location.name, false));
      assert.doesNotMatch(String(login.body.error), /apply again/);
    });
  } finally {
    await prisma.session.deleteMany({ where: { userId: users[0]!.id } });
    await cleanup([location.id], [p]);
  }
});

test('GET /api/join/:locationId/pending: previousDeclines and lastDeclinedAt count this venue only', async () => {
  const { location, users } = await makeVenue('pending history', [{ fullName: `${TAG} Owner`, systemRole: 'OWNER' }]);
  const elsewhere = await makeVenue('pending history elsewhere');
  const { plainToken } = await issueSession(users[0]!.id);
  const [returning, fresh] = [phone(), phone()];
  const declinedOn = (iso: string) => ({ status: 'DECLINED' as const, reviewedAt: new Date(iso), createdAt: new Date(iso) });
  await prisma.joinRequest.createMany({
    data: [
      { locationId: location.id, phone: returning, fullName: `${TAG} R`, ...declinedOn('2026-09-01T10:00:00.000Z') },
      { locationId: location.id, phone: returning, fullName: `${TAG} R`, ...declinedOn('2026-09-20T10:00:00.000Z') },
      { locationId: location.id, phone: returning, fullName: `${TAG} R`, status: 'PENDING' },
      // Declined elsewhere: none of this venue's business.
      { locationId: elsewhere.location.id, phone: returning, fullName: `${TAG} R`, ...declinedOn('2026-09-25T10:00:00.000Z') },
      { locationId: elsewhere.location.id, phone: fresh, fullName: `${TAG} F`, ...declinedOn('2026-09-25T10:00:00.000Z') },
      { locationId: location.id, phone: fresh, fullName: `${TAG} F`, status: 'PENDING' },
    ],
  });
  try {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/join/${location.id}/pending`, { headers: { Authorization: `Bearer ${plainToken}` } });
      assert.equal(res.status, 200);
      const { requests } = (await res.json()) as { requests: { phone: string; previousDeclines: number; lastDeclinedAt: string | null }[] };
      const byPhone = new Map(requests.map((r) => [r.phone, r]));
      assert.equal(requests.length, 2);
      assert.equal(byPhone.get(returning)!.previousDeclines, 2);
      assert.equal(byPhone.get(returning)!.lastDeclinedAt, '2026-09-20T10:00:00.000Z');
      assert.equal(byPhone.get(fresh)!.previousDeclines, 0);
      assert.equal(byPhone.get(fresh)!.lastDeclinedAt, null);
    });
  } finally {
    await prisma.session.deleteMany({ where: { userId: users[0]!.id } });
    await cleanup([location.id, elsewhere.location.id], [returning, fresh]);
  }
});

test('join/verify-otp: after a decline /login says they may apply again; another venue is unaffected', async () => {
  const declinedAt = await makeVenue('declined here');
  const elsewhere = await makeVenue('other venue', [{ fullName: `${TAG} Other Owner`, systemRole: 'OWNER' }]);
  const p = phone();
  await prisma.joinRequest.create({ data: { locationId: declinedAt.location.id, phone: p, fullName: `${TAG} declined`, status: 'DECLINED' } });
  try {
    await withServer(async (baseUrl) => {
      const declined = await verifyLogin(baseUrl, p);
      assert.equal(declined.status, 403);
      assert.equal(declined.body.status, 'declined');
      assert.equal(
        declined.body.error,
        `Your request to join ${declinedAt.location.name} was declined. You can apply again with your full name through ${declinedAt.location.name}'s invite link, or ask a manager there to add you to the staff list.`,
      );
      assert.equal(await prisma.joinRequest.count({ where: { phone: p } }), 1);

      // A different venue's link still files a request there, and says nothing about the first venue.
      const other = await verifyJoin(baseUrl, elsewhere.location.id, p, `${TAG} declined`);
      assert.equal(other.status, 201);
      assert.equal(other.body.venueName, elsewhere.location.name);
      assert.ok(!JSON.stringify(other.body).includes(declinedAt.location.name));
      await poll(() => prisma.notification.count({ where: { userId: elsewhere.users[0]!.id } }), (n) => n >= 1);

      // Login now reports the open request, not the old decline.
      const login = await verifyLogin(baseUrl, p);
      assert.equal(login.status, 200);
      assert.equal(login.body.venueName, elsewhere.location.name);
    });
  } finally {
    await cleanup([declinedAt.location.id, elsewhere.location.id], [p]);
  }
});

test('PATCH /api/join/:id approve: a phone already held by a user is a 409 (not a 500) and the request stays PENDING; a clean approve leaves the new user a notice and lets them sign in', async () => {
  const { location, users } = await makeVenue('approve', [{ fullName: `${TAG} Owner`, systemRole: 'OWNER' }]);
  const elsewhere = await makeVenue('holds the number');
  const owner = users[0]!;
  const { plainToken } = await issueSession(owner.id);
  const [taken, fresh] = [phone(), phone()];
  await prisma.user.create({ data: { locationId: elsewhere.location.id, fullName: `${TAG} holder`, phone: taken, isActive: false } });
  const blocked = await prisma.joinRequest.create({ data: { locationId: location.id, phone: taken, fullName: `${TAG} blocked`, status: 'PENDING' } });
  const clean = await prisma.joinRequest.create({ data: { locationId: location.id, phone: fresh, fullName: `${TAG} clean`, status: 'PENDING' } });
  try {
    await withServer(async (baseUrl) => {
      const res = await send(baseUrl, 'PATCH', `/api/join/${blocked.id}`, { decision: 'approve' }, plainToken);
      assert.equal(res.status, 409);
      assert.match(((await res.json()) as { error: string }).error, /already belongs to another staff account/);
      assert.equal((await prisma.joinRequest.findUniqueOrThrow({ where: { id: blocked.id } })).status, 'PENDING');

      const ok = await send(baseUrl, 'PATCH', `/api/join/${clean.id}`, { decision: 'approve' }, plainToken);
      assert.equal(ok.status, 200);
      const { userId } = (await ok.json()) as { userId: string };
      const notices = await poll(() => prisma.notification.findMany({ where: { userId } }), (n) => n.length > 0);
      assert.equal(notices.length, 1);
      assert.equal(notices[0]!.title, "You're in");
      assert.equal(notices[0]!.body, `${location.name} approved your request — welcome!`);
      assert.equal(notices[0]!.url, '/my-shifts');

      const login = await verifyLogin(baseUrl, fresh);
      assert.equal(login.status, 200);
      assert.equal((login.body.user as { id: string }).id, userId);
    });
  } finally {
    await prisma.session.deleteMany({ where: { user: { locationId: location.id } } });
    await cleanup([location.id, elsewhere.location.id], [taken, fresh]);
  }
});

test('PATCH /api/join/:id approve: a request that could be more than one imported person needs the manager\'s choice (409 with candidates); the choice links exactly that record; another venue\'s record is a 400; staff are refused', async () => {
  const { location, users } = await makeVenue('link choice', [{ fullName: `${TAG} Owner`, systemRole: 'OWNER' }]);
  const elsewhere = await makeVenue('link choice elsewhere');
  const { plainToken } = await issueSession(users[0]!.id);
  const [applicantPhone, staffPhone] = [phone(), phone()];
  const staff = await prisma.user.create({ data: { locationId: location.id, fullName: `${TAG} staff`, systemRole: 'STAFF', phone: staffPhone } });
  const staffToken = (await issueSession(staff.id)).plainToken;
  // Made-up names: two people imported from a roster share the applicant's first name.
  const halloumi = await prisma.user.create({ data: { locationId: location.id, fullName: 'Tarek Halloumi', systemRole: 'STAFF' } });
  const benali = await prisma.user.create({ data: { locationId: location.id, fullName: 'Tarek Benali', systemRole: 'STAFF' } });
  const foreign = await prisma.user.create({ data: { locationId: elsewhere.location.id, fullName: 'Tarek Halloumi', systemRole: 'STAFF' } });
  const jr = await prisma.joinRequest.create({ data: { locationId: location.id, phone: applicantPhone, fullName: 'Tarek', status: 'PENDING' } });
  try {
    await withServer(async (baseUrl) => {
      const approve = (body: Record<string, unknown>, token = plainToken) => send(baseUrl, 'PATCH', `/api/join/${jr.id}`, { decision: 'approve', ...body }, token);
      // The pending list already says what approving will need.
      const list = await fetch(`${baseUrl}/api/join/${location.id}/pending`, { headers: { Authorization: `Bearer ${plainToken}` } });
      const { requests } = (await list.json()) as { requests: { id: string; link: { kind: string; candidates?: { fullName: string; match: string }[] } }[] };
      const listed = requests.find((r) => r.id === jr.id)!;
      assert.equal(listed.link.kind, 'choose');
      assert.deepEqual(listed.link.candidates!.map((c) => `${c.fullName}:${c.match}`), ['Tarek Benali:close', 'Tarek Halloumi:close']);

      assert.equal((await approve({ linkTo: halloumi.id }, staffToken)).status, 403, 'staff cannot approve');

      const noChoice = await approve({});
      assert.equal(noChoice.status, 409);
      const refused = (await noChoice.json()) as { errorCode: string; error: string; candidates: { userId: string }[] };
      assert.equal(refused.errorCode, 'link_choice_required');
      assert.match(refused.error, /Choose who they are/);
      assert.deepEqual(refused.candidates.map((c) => c.userId).sort(), [benali.id, halloumi.id].sort());

      assert.equal((await approve({ linkTo: 42 })).status, 400);
      const crossVenue = await approve({ linkTo: foreign.id });
      assert.equal(crossVenue.status, 400);
      assert.equal(((await crossVenue.json()) as { errorCode: string }).errorCode, 'link_target_invalid');
      assert.equal((await prisma.joinRequest.findUniqueOrThrow({ where: { id: jr.id } })).status, 'PENDING');
      assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: foreign.id } })).phone, null);

      const ok = await approve({ linkTo: halloumi.id });
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { status: 'APPROVED', userId: halloumi.id, linked: true });
      assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: halloumi.id } })).phone, applicantPhone);
      assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: benali.id } })).phone, null, 'the other Tarek is untouched');

      // They sign in as the record they were linked to (and its shifts).
      const login = await verifyLogin(baseUrl, applicantPhone);
      assert.equal(login.status, 200);
      assert.equal((login.body.user as { id: string }).id, halloumi.id);
    });
  } finally {
    await prisma.session.deleteMany({ where: { user: { locationId: location.id } } });
    await cleanup([location.id, elsewhere.location.id], [applicantPhone, staffPhone]);
  }
});
