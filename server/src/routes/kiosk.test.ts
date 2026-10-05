import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../app.js';
import { hashOtp, issueSession } from '../lib/identity.js';

/**
 * Kiosk links over real HTTP: the manager API (status, regenerate, revoke) and
 * the four venue reads a kiosk screen makes with `X-Kiosk-Token` — what the
 * current token gets (the published rota only, names but no phones, notes or
 * user ids), that every other token and a venue id alone get the same 401,
 * that sessions keep their own venue (and only theirs), and the per-client
 * limit on refused attempts. Two venues in two organizations; every row this
 * file creates hangs off them and goes with them in `after`.
 */
const prisma = new PrismaClient();
const TAG = '__kiosk-test__';

let server: Server;
let baseUrl = '';
let orgIds: string[] = [];
const fx = {} as {
  locA: string;
  locB: string;
  monday: string;
  staffA: string;
  staffAName: string;
  staffAPhone: string;
  managerA: string;
  publishedShift: string;
  draftShift: string;
  briefing: string;
  sidework: string;
  announcement: string;
  shoutoutNote: string;
};
const sessions = {} as Record<'ownerA' | 'managerA' | 'staffA' | 'managerB' | 'staffB', string>;

/** YYYY-MM-DD of the Monday two weeks from now (UTC). */
function futureMonday(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 14);
  return d.toISOString().slice(0, 10);
}
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const randomPhone = () => `+97150${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;

before(async () => {
  const monday = futureMonday();
  const tuesday = addDays(monday, 1);
  const wednesday = addDays(monday, 2);
  const [orgA, orgB] = await Promise.all([
    prisma.organization.create({ data: { name: `${TAG} org A` } }),
    prisma.organization.create({ data: { name: `${TAG} org B` } }),
  ]);
  orgIds = [orgA.id, orgB.id];
  const locA = await prisma.location.create({ data: { organizationId: orgA.id, name: `${TAG} venue A`, timezone: 'Asia/Dubai' } });
  const locB = await prisma.location.create({ data: { organizationId: orgB.id, name: `${TAG} venue B`, timezone: 'Asia/Dubai' } });
  const user = (locationId: string, systemRole: 'OWNER' | 'MANAGER' | 'STAFF', label: string) =>
    prisma.user.create({ data: { locationId, systemRole, fullName: `${TAG} ${label}`, phone: randomPhone() } });
  const ownerA = await user(locA.id, 'OWNER', 'owner A');
  const managerA = await user(locA.id, 'MANAGER', 'manager A');
  const staffA = await user(locA.id, 'STAFF', 'staff A');
  const managerB = await user(locB.id, 'MANAGER', 'manager B');
  const staffB = await user(locB.id, 'STAFF', 'staff B');
  for (const [key, id] of [['ownerA', ownerA.id], ['managerA', managerA.id], ['staffA', staffA.id], ['managerB', managerB.id], ['staffB', staffB.id]] as const) {
    sessions[key] = (await issueSession(id)).plainToken;
  }

  const role = await prisma.role.create({ data: { locationId: locA.id, name: `${TAG} Bartender` } });
  const briefing = `${TAG} briefing: VIP table at nine`;
  const sidework = `${TAG} polish glassware`;
  const shift = (date: string, status: 'DRAFT' | 'PUBLISHED') =>
    prisma.shift.create({
      data: {
        locationId: locA.id, roleId: role.id, userId: staffA.id, date: new Date(`${date}T00:00:00.000Z`),
        startTime: new Date(`${date}T10:00:00+04:00`), endTime: new Date(`${date}T18:00:00+04:00`),
        status, managerNotes: briefing, sidework: [sidework],
      },
    });
  const publishedShift = await shift(tuesday, 'PUBLISHED');
  const draftShift = await shift(wednesday, 'DRAFT');
  await prisma.rotaPublish.create({ data: { locationId: locA.id, weekStart: new Date(`${monday}T00:00:00.000Z`), publishedAt: new Date(), publishedById: managerA.id, notifiedCount: 1 } });
  const announcement = `${TAG} staff meeting moved to Thursday`;
  await prisma.announcement.create({ data: { locationId: locA.id, authorId: managerA.id, body: announcement } });
  const shoutoutNote = `${TAG} brilliant close`;
  await prisma.shoutout.create({ data: { locationId: locA.id, employeeId: staffA.id, authorId: managerA.id, note: shoutoutNote } });

  Object.assign(fx, {
    locA: locA.id, locB: locB.id, monday, staffA: staffA.id, staffAName: staffA.fullName, staffAPhone: staffA.phone!, managerA: managerA.id,
    publishedShift: publishedShift.id, draftShift: draftShift.id, briefing, sidework, announcement, shoutoutNote,
  });

  server = await new Promise<Server>((resolve) => {
    const s = createApp().listen(0, () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.$disconnect();
});

type Headers = Record<string, string>;
const bearer = (token: string): Headers => ({ Authorization: `Bearer ${token}` });
const kiosk = (token: string): Headers => ({ 'X-Kiosk-Token': token });

async function call(method: 'GET' | 'POST', path: string, headers: Headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, { method, headers });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
}

/** The four venue reads a kiosk screen makes. */
const reads = (locationId: string) => [
  `/api/shifts/${locationId}?weekStart=${fx.monday}`,
  `/api/shifts/${locationId}/publish-status?weekStart=${fx.monday}`,
  `/api/announcements/${locationId}`,
  `/api/shoutouts/${locationId}`,
];

/** Regenerates venue A's kiosk link as its manager; returns the link and the token in its fragment. */
async function regenerate(): Promise<{ url: string; token: string }> {
  const res = await call('POST', `/api/kiosk/${fx.locA}/regenerate`, bearer(sessions.managerA));
  assert.equal(res.status, 201, res.text);
  const url = String(res.body.url);
  return { url, token: new URL(url).hash.replace(/^#k=/, '') };
}

test('regenerate returns the link once and stores only its sha256; the status read never includes it', async () => {
  assert.deepEqual((await call('GET', `/api/kiosk/${fx.locA}`, bearer(sessions.managerA))).body, { active: null });

  const { url, token } = await regenerate();
  const link = new URL(url);
  assert.equal(link.pathname, '/kiosk');
  assert.equal(link.searchParams.get('venue'), fx.locA);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);

  const venue = await prisma.location.findUniqueOrThrow({ where: { id: fx.locA } });
  assert.notEqual(venue.kioskTokenHash, token);
  assert.equal(venue.kioskTokenHash, hashOtp(token));
  assert.ok(venue.kioskTokenCreatedAt);

  const status = await call('GET', `/api/kiosk/${fx.locA}`, bearer(sessions.managerA));
  assert.equal(status.status, 200);
  assert.deepEqual(status.body, { active: { createdAt: venue.kioskTokenCreatedAt!.toISOString() } });
  assert.ok(!status.text.includes(token), 'the status read never includes the token');
});

test('the current token reads all four routes: the published rota only, with names but no phones, notes or user ids', async () => {
  const { token } = await regenerate();
  const [shifts, publish, announcements, shoutouts] = await Promise.all(reads(fx.locA).map((path) => call('GET', path, kiosk(token))));
  for (const res of [shifts, publish, announcements, shoutouts]) assert.equal(res.status, 200, res.text);

  const rows = shifts.body.shifts as Record<string, unknown>[];
  assert.deepEqual(rows.map((s) => s.id), [fx.publishedShift], 'drafts are never shown');
  assert.deepEqual(Object.keys(rows[0]!).sort(), ['date', 'employeeName', 'end', 'id', 'roleName', 'start', 'status']);
  assert.deepEqual(rows[0], {
    id: fx.publishedShift, employeeName: fx.staffAName, roleName: `${TAG} Bartender`, date: addDays(fx.monday, 1), start: '10:00', end: '18:00', status: 'published',
  });
  assert.ok(publish.body.publishedAt, 'publish status is readable');

  const annRows = announcements.body.announcements as Record<string, unknown>[];
  assert.deepEqual(annRows.map((a) => a.body), [fx.announcement]);
  assert.ok(!('authorId' in annRows[0]!));
  const shoutRows = shoutouts.body.shoutouts as Record<string, unknown>[];
  assert.deepEqual(shoutRows.map((s) => [s.employeeName, s.note]), [[fx.staffAName, fx.shoutoutNote]]);
  assert.ok(!('employeeId' in shoutRows[0]!) && !('authorId' in shoutRows[0]!));

  for (const res of [shifts, publish, announcements, shoutouts]) {
    for (const secret of [fx.staffAPhone, fx.staffAPhone.slice(1), fx.briefing, fx.sidework, fx.staffA, fx.managerA, fx.draftShift]) {
      assert.ok(!res.text.includes(secret), `a kiosk read must not include ${secret === fx.draftShift ? 'the draft shift' : 'private details'}`);
    }
  }
});

test('a venue id alone, an old, a revoked, a foreign or a made-up token all get the same 401 — and no log line carries a token', async () => {
  const logged: string[] = [];
  const originals = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const name of Object.keys(originals) as (keyof typeof originals)[]) {
    console[name] = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
      originals[name](...args);
    };
  }
  try {
    const old = await regenerate();
    const current = await regenerate();
    const refusal = await call('GET', reads(fx.locA)[0]!);
    assert.equal(refusal.status, 401);
    assert.equal(refusal.body.errorCode, 'kiosk_link_required');

    const refusedWith = async (headers: Headers, locationId = fx.locA) => {
      for (const path of reads(locationId)) {
        const res = await call('GET', path, headers);
        assert.equal(res.status, 401, `${path} with ${Object.keys(headers).join(',') || 'nothing'}`);
        assert.deepEqual(res.body, refusal.body, 'the same answer whatever the token was');
      }
    };
    await refusedWith({});
    await refusedWith(kiosk(old.token));
    await refusedWith(kiosk(randomBytes(32).toString('base64url')));
    await refusedWith(kiosk('not-a-token'));
    await refusedWith(kiosk(current.token), fx.locB);
    for (const path of reads(fx.locA)) assert.equal((await call('GET', path, kiosk(current.token))).status, 200);

    const revoked = await call('POST', `/api/kiosk/${fx.locA}/revoke`, bearer(sessions.managerA));
    assert.deepEqual([revoked.status, revoked.body], [200, { active: null }]);
    await refusedWith(kiosk(current.token));
    assert.deepEqual((await call('GET', `/api/kiosk/${fx.locA}`, bearer(sessions.managerA))).body, { active: null });
    const venue = await prisma.location.findUniqueOrThrow({ where: { id: fx.locA } });
    assert.deepEqual([venue.kioskTokenHash, venue.kioskTokenCreatedAt], [null, null]);

    for (const token of [old.token, current.token]) assert.ok(!logged.some((line) => line.includes(token)), 'no log line carries a kiosk token');
  } finally {
    Object.assign(console, originals);
  }
});

test("a signed-in user keeps their own venue's reads without a token; another venue's session is refused, token or not", async () => {
  const { token } = await regenerate();
  for (const path of reads(fx.locA)) assert.equal((await call('GET', path, bearer(sessions.staffA))).status, 200, path);
  const ownView = await call('GET', reads(fx.locA)[0]!, bearer(sessions.managerA));
  assert.ok(ownView.text.includes(fx.draftShift), "the venue's own sessions still see drafts");

  for (const actor of ['staffB', 'managerB'] as const) {
    for (const path of reads(fx.locA)) {
      assert.equal((await call('GET', path, bearer(sessions[actor]))).status, 403, `${actor} ${path}`);
      assert.equal((await call('GET', path, { ...bearer(sessions[actor]), ...kiosk(token) })).status, 403, `${actor} ${path} + kiosk token`);
    }
  }
});

test('only an owner or manager of the venue can see, regenerate or revoke its kiosk link', async () => {
  await regenerate();
  const before = (await prisma.location.findUniqueOrThrow({ where: { id: fx.locA } })).kioskTokenHash;
  const routes: ['GET' | 'POST', string][] = [
    ['GET', `/api/kiosk/${fx.locA}`],
    ['POST', `/api/kiosk/${fx.locA}/regenerate`],
    ['POST', `/api/kiosk/${fx.locA}/revoke`],
  ];
  for (const [method, path] of routes) {
    assert.equal((await call(method, path)).status, 401, `anonymous ${method} ${path}`);
    for (const actor of ['staffA', 'staffB', 'managerB'] as const) {
      assert.equal((await call(method, path, bearer(sessions[actor]))).status, 403, `${actor} ${method} ${path}`);
    }
  }
  assert.equal((await prisma.location.findUniqueOrThrow({ where: { id: fx.locA } })).kioskTokenHash, before, 'nothing changed');

  const byOwner = await call('POST', `/api/kiosk/${fx.locA}/regenerate`, bearer(sessions.ownerA));
  assert.equal(byOwner.status, 201);
  assert.equal((await call('POST', `/api/kiosk/${fx.locA}/revoke`, bearer(sessions.ownerA))).status, 200);
});

test('the kiosk token opens no other route', async () => {
  const { token } = await regenerate();
  const others: ['GET' | 'POST', string][] = [
    ['GET', `/api/staff-directory/${fx.locA}`],
    ['GET', `/api/locations/${fx.locA}`],
    ['GET', `/api/kiosk/${fx.locA}`],
    ['GET', `/api/swap-requests/${fx.locA}`],
    ['GET', `/api/eighty-six/${fx.locA}`],
    ['GET', '/api/my-shifts'],
    ['POST', '/api/announcements'],
    ['POST', `/api/kiosk/${fx.locA}/regenerate`],
  ];
  for (const [method, path] of others) assert.equal((await call(method, path, kiosk(token))).status, 401, `${method} ${path}`);
});

test('refused kiosk reads are limited per client (429 after 20); the current token and a session are still served', async () => {
  const { token } = await regenerate();
  // X-Real-IP is how the API identifies a client behind Railway (otpClientKey); a bare loopback request is never limited.
  const client = { 'X-Real-IP': `198.51.100.${1 + Math.floor(Math.random() * 254)}` };
  const paths = reads(fx.locA);
  for (let i = 0; i < 20; i++) {
    assert.equal((await call('GET', paths[i % paths.length]!, { ...client, ...kiosk(`${randomBytes(32).toString('base64url')}`) })).status, 401, `attempt #${i + 1}`);
  }
  const limited = await call('GET', paths[0]!, { ...client, ...kiosk(randomBytes(32).toString('base64url')) });
  assert.equal(limited.status, 429);
  assert.match(String(limited.body.error), /too many/i);
  assert.equal((await call('GET', paths[0]!, client)).status, 429, 'no token counts as a refusal too');

  for (const path of paths) {
    assert.equal((await call('GET', path, { ...client, ...kiosk(token) })).status, 200, `current token from the limited client: ${path}`);
    assert.equal((await call('GET', path, { ...client, ...bearer(sessions.staffA) })).status, 200, `session from the limited client: ${path}`);
  }
  assert.equal((await call('GET', paths[0]!, { 'X-Real-IP': '198.51.100.255' })).status, 401, 'another client has its own count');
  for (let i = 0; i < 25; i++) assert.equal((await call('GET', paths[0]!)).status, 401, 'loopback with no proxy headers (local dev, e2e) is never limited');
});
