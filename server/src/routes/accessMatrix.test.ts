import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../app.js';
import { hashOtp, issueSession } from '../lib/identity.js';
import { uploadCache } from '../store/uploadCache.js';

/**
 * Cross-venue access matrix: every API route (and the two session-gated
 * upload paths) called by the people who must NOT get through, then by the
 * person who should — so a refusal can never be a validation error in disguise.
 *
 * Two venues in two organizations, A and B, each with an owner, a manager
 * and staff; plus a deactivated manager of A. Every target resource belongs
 * to venue A. Actors:
 *   anon          no session                                → 401
 *   deactivatedA  a session row for A's deactivated manager → 401
 *   staffA        staff of the same venue                   → 403 on manager routes
 *   staffB        staff of the other venue                  → 403 / 404
 *   managerB      manager of the other venue                → 403 / 404
 *   ownerB        owner of the other venue                  → 403 on owner-only routes
 *   managerA / staffA / ownerA  the positive control        → 2xx, run after every refusal
 *
 * Routes that are anonymous by documented decision (health, the VAPID public
 * key, sign-in config) are listed in PUBLIC_BY_DESIGN and asserted as such, so
 * a change to that decision is a visible test edit. The four kiosk reads
 * (rota, publish status, announcements, shoutouts) are ordinary cases here;
 * what the venue's kiosk token unlocks on them is covered by kiosk.test.ts.
 * Token-capability routes (invite peek, login-link peek/redeem, OTP routes)
 * are out of scope: the token, not the venue, is the credential.
 *
 * No network beyond 127.0.0.1; no external service is called.
 */
const prisma = new PrismaClient();
const TAG = '__access-matrix__';
const UPLOADS = join(import.meta.dirname, '..', '..', 'uploads');

type Actor = 'anon' | 'deactivatedA' | 'staffA' | 'managerA' | 'ownerA' | 'staffB' | 'managerB' | 'ownerB';
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface Fx {
  locA: string;
  locB: string;
  staffA: string;
  staffA2: string;
  managerA: string;
  ownerA: string;
  staffB: string;
  roleA: string;
  roleA2: string;
  roleDel: string;
  shiftA: string;
  shiftA2: string;
  shiftDel: string;
  annA: string;
  annDel: string;
  shoutDel: string;
  imgA: string;
  imgFile: string;
  secA: string;
  secDel: string;
  asgA: string;
  asgDel: string;
  docA: string;
  docFile: string;
  docDel: string;
  itemA: string;
  itemOnBehalf: string;
  fbA: string;
  markA: string;
  notifA: string;
  jrA: string;
  tplA: string;
  tplDel: string;
  swapA: string;
  linkA: string;
  batchA: string;
  pushEndpointA: string;
  ownerPhoneA: string;
  monday: string;
  tuesday: string;
}

let fx: Fx;
const tokens = {} as Record<Exclude<Actor, 'anon'>, string>;
let throwawayToken = '';
let baseUrl = '';
let server: Server;
let orgIds: string[] = [];
const filesWritten: string[] = [];

/** YYYY-MM-DD of the Monday two weeks from now (UTC): a future week, so the cover-request window is open. */
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
const at = (iso: string, hhmm: string) => new Date(`${iso}T${hhmm}:00.000Z`);
/** A random valid-shaped UAE mobile in E.164, generated per run. */
const randomPhone = () => `+97150${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;

before(async () => {
  const monday = futureMonday();
  const tuesday = addDays(monday, 1);
  const [orgA, orgB] = await Promise.all([
    prisma.organization.create({ data: { name: `${TAG} org A` } }),
    prisma.organization.create({ data: { name: `${TAG} org B` } }),
  ]);
  orgIds = [orgA.id, orgB.id];
  const locA = await prisma.location.create({ data: { organizationId: orgA.id, name: `${TAG} venue A`, timezone: 'Asia/Dubai' } });
  const locB = await prisma.location.create({ data: { organizationId: orgB.id, name: `${TAG} venue B`, timezone: 'Asia/Dubai' } });

  const user = (locationId: string, systemRole: 'OWNER' | 'MANAGER' | 'STAFF', label: string, extra: object = {}) =>
    prisma.user.create({ data: { locationId, systemRole, fullName: `${TAG} ${label}`, phone: randomPhone(), ...extra } });
  const ownerA = await user(locA.id, 'OWNER', 'owner A');
  const managerA = await user(locA.id, 'MANAGER', 'manager A');
  const staffA = await user(locA.id, 'STAFF', 'staff A');
  const staffA2 = await user(locA.id, 'STAFF', 'staff A2');
  const deactivatedA = await user(locA.id, 'MANAGER', 'deactivated manager A', { isActive: false });
  const ownerB = await user(locB.id, 'OWNER', 'owner B');
  const managerB = await user(locB.id, 'MANAGER', 'manager B');
  const staffB = await user(locB.id, 'STAFF', 'staff B');

  for (const [actor, id] of [
    ['deactivatedA', deactivatedA.id],
    ['staffA', staffA.id],
    ['managerA', managerA.id],
    ['ownerA', ownerA.id],
    ['staffB', staffB.id],
    ['managerB', managerB.id],
    ['ownerB', ownerB.id],
  ] as const) {
    tokens[actor] = (await issueSession(id)).plainToken;
  }
  throwawayToken = (await issueSession(staffA.id)).plainToken;

  const roleA = await prisma.role.create({ data: { locationId: locA.id, name: `${TAG} Bartender` } });
  const roleA2 = await prisma.role.create({ data: { locationId: locA.id, name: `${TAG} Runner` } });
  const roleDel = await prisma.role.create({ data: { locationId: locA.id, name: `${TAG} Host` } });
  const shift = (userId: string | null, date: string) =>
    prisma.shift.create({ data: { locationId: locA.id, roleId: roleA.id, userId, date: new Date(`${date}T00:00:00.000Z`), startTime: at(date, '13:00'), endTime: at(date, '19:00') } });
  const shiftA = await shift(staffA.id, tuesday);
  const shiftA2 = await shift(staffA.id, addDays(monday, 3));
  const shiftDel = await shift(null, addDays(monday, 4));

  const annA = await prisma.announcement.create({ data: { locationId: locA.id, body: `${TAG} announcement` } });
  const annDel = await prisma.announcement.create({ data: { locationId: locA.id, body: `${TAG} announcement to delete` } });
  const shoutDel = await prisma.shoutout.create({ data: { locationId: locA.id, employeeId: staffA.id, note: `${TAG} shoutout` } });

  mkdirSync(join(UPLOADS, 'floor-plans'), { recursive: true });
  mkdirSync(join(UPLOADS, 'policy-documents'), { recursive: true });
  const imgFile = `${randomUUID()}.png`;
  writeFileSync(join(UPLOADS, 'floor-plans', imgFile), 'matrix-floor-plan');
  filesWritten.push(join(UPLOADS, 'floor-plans', imgFile));
  const docFile = `${randomUUID()}.pdf`;
  writeFileSync(join(UPLOADS, 'policy-documents', docFile), 'matrix-policy');
  filesWritten.push(join(UPLOADS, 'policy-documents', docFile));
  const imgA = await prisma.floorPlanImage.create({ data: { locationId: locA.id, fileUrl: `/uploads/floor-plans/${imgFile}`, mimeType: 'image/png' } });
  const section = (label: string) =>
    prisma.floorSection.create({ data: { locationId: locA.id, floorPlanImageId: imgA.id, label, paxCapacity: 4, pinX: 0.5, pinY: 0.5 } });
  const secA = await section(`${TAG} Terrace`);
  const secDel = await section(`${TAG} Bar`);
  const asgA = await prisma.sectionAssignment.create({ data: { sectionId: secA.id, staffId: staffA.id, shiftDate: new Date(`${tuesday}T00:00:00.000Z`), period: 'AM' } });
  const asgDel = await prisma.sectionAssignment.create({ data: { sectionId: secDel.id, staffId: staffA.id, shiftDate: new Date(`${tuesday}T00:00:00.000Z`), period: 'AM' } });
  const doc = (title: string, file: string) =>
    prisma.policyDocument.create({ data: { locationId: locA.id, category: 'HR', title, fileUrl: `/uploads/policy-documents/${file}`, mimeType: 'application/pdf' } });
  const docA = await doc(`${TAG} handbook`, docFile);
  const docDel = await doc(`${TAG} old handbook`, `${randomUUID()}.pdf`);

  const itemA = await prisma.eightySixItem.create({ data: { locationId: locA.id, itemName: `${TAG} lime`, station: 'Bar' } });
  const itemOnBehalf = await prisma.eightySixItem.create({ data: { locationId: locA.id, itemName: `${TAG} mint`, station: 'Bar' } });
  const fbA = await prisma.floorFeedback.create({ data: { locationId: locA.id, userId: staffA.id, content: `${TAG} feedback` } });
  const markA = await prisma.availabilityMark.create({ data: { userId: staffA.id, date: new Date(`${tuesday}T00:00:00.000Z`), type: 'UNAVAILABLE' } });
  const notifA = await prisma.notification.create({ data: { userId: staffA.id, title: `${TAG} title`, body: `${TAG} body` } });
  const jrA = await prisma.joinRequest.create({ data: { locationId: locA.id, phone: randomPhone(), fullName: `${TAG} applicant` } });
  const entries = [{ dayOffset: 1, roleId: roleA.id, userId: staffA2.id, start: '09:00', end: '12:00' }];
  const tplA = await prisma.rotaTemplate.create({ data: { locationId: locA.id, name: `${TAG} template`, entries } });
  const tplDel = await prisma.rotaTemplate.create({ data: { locationId: locA.id, name: `${TAG} template to delete`, entries } });
  const swapA = await prisma.shiftSwapRequest.create({ data: { shiftId: shiftA.id, requestedById: staffA.id, targetUserId: managerA.id, expiresAt: at(addDays(monday, 2), '13:00') } });
  const linkA = await prisma.loginLink.create({
    data: { tokenHash: hashOtp(randomBytes(32).toString('base64url')), userId: staffA.id, locationId: locA.id, expiresAt: new Date(Date.now() + 86_400_000) },
  });
  await prisma.inviteLink.create({ data: { locationId: locA.id, token: randomBytes(32).toString('base64url'), expiresAt: new Date(Date.now() + 86_400_000) } });
  const pushEndpointA = `https://push.invalid/${TAG}/${randomUUID()}`;
  await prisma.pushSubscription.create({ data: { userId: staffA.id, endpoint: pushEndpointA, p256dh: 'test-key', auth: 'test-auth' } });
  const batchA = uploadCache.put(locA.id, null, []);

  fx = {
    locA: locA.id, locB: locB.id, staffA: staffA.id, staffA2: staffA2.id, managerA: managerA.id, ownerA: ownerA.id, staffB: staffB.id,
    roleA: roleA.id, roleA2: roleA2.id, roleDel: roleDel.id, shiftA: shiftA.id, shiftA2: shiftA2.id, shiftDel: shiftDel.id,
    annA: annA.id, annDel: annDel.id, shoutDel: shoutDel.id, imgA: imgA.id, imgFile, secA: secA.id, secDel: secDel.id,
    asgA: asgA.id, asgDel: asgDel.id, docA: docA.id, docFile, docDel: docDel.id, itemA: itemA.id, itemOnBehalf: itemOnBehalf.id,
    fbA: fbA.id, markA: markA.id, notifA: notifA.id, jrA: jrA.id, tplA: tplA.id, tplDel: tplDel.id, swapA: swapA.id,
    linkA: linkA.id, batchA, pushEndpointA, ownerPhoneA: ownerA.phone!, monday, tuesday,
  };

  server = await new Promise<Server>((resolve) => {
    const s = createApp().listen(0, () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  if (fx) uploadCache.delete(fx.batchA);
  // Files this suite wrote, plus anything a positive control uploaded for venue A.
  const uploaded = await prisma.floorPlanImage.findMany({ where: { location: { organizationId: { in: orgIds } } }, select: { fileUrl: true } });
  const docs = await prisma.policyDocument.findMany({ where: { location: { organizationId: { in: orgIds } } }, select: { fileUrl: true } });
  for (const { fileUrl } of [...uploaded, ...docs]) rmSync(join(UPLOADS, fileUrl.replace(/^\/uploads\//, '')), { force: true });
  for (const f of filesWritten) rmSync(f, { force: true });
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.$disconnect();
});

type Body = Record<string, unknown> | FormData;
interface Call {
  method: Method;
  path: (f: Fx) => string;
  body?: (f: Fx) => Body;
}

async function call(actor: Actor, c: Call): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = {};
  if (actor !== 'anon') headers.Authorization = `Bearer ${tokens[actor]}`;
  const body = c.body?.(fx);
  let payload: RequestInit['body'];
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${c.path(fx)}`, { method: c.method, headers, body: payload });
  return { status: res.status, text: await res.text() };
}

/** anon and the deactivated user must get 401; everyone else refused must get 403 or 404 — never 2xx. */
function assertRefused(actor: Actor, status: number, label: string) {
  if (actor === 'anon' || actor === 'deactivatedA') assert.equal(status, 401, `${label}: ${actor} must get 401, got ${status}`);
  else assert.ok(status === 403 || status === 404, `${label}: ${actor} must be refused (403/404), got ${status}`);
}

const OUTSIDERS: Actor[] = ['anon', 'deactivatedA', 'staffB', 'managerB'];
const NOT_MANAGERS_OF_A: Actor[] = [...OUTSIDERS, 'staffA'];

/** A tiny file for multipart uploads (contents are never parsed on a refused request). */
function form(fields: Record<string, string>, file: { name: string; type: string }): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append(file.name === 'audio' ? 'audio' : 'file', new Blob([`${TAG}`], { type: file.type }), file.name === 'audio' ? 'a.webm' : `x.${file.type.split('/')[1]}`);
  return fd;
}

interface Case extends Call {
  name: string;
  refuse: Actor[];
}

/** Every route that touches venue A's data, with everyone who must be refused. */
const CASES: Case[] = [
  // AI spend cap (owner only)
  { name: 'GET /api/ai/usage', method: 'GET', path: (f) => `/api/ai/usage?locationId=${f.locA}`, refuse: ['anon', 'deactivatedA', 'staffA', 'managerA', 'staffB', 'managerB', 'ownerB'] },
  // announcements
  { name: 'GET /api/announcements/:locationId', method: 'GET', path: (f) => `/api/announcements/${f.locA}`, refuse: OUTSIDERS },
  { name: 'POST /api/announcements', method: 'POST', path: () => '/api/announcements', body: () => ({ body: `${TAG} new` }), refuse: ['anon', 'deactivatedA'] },
  { name: 'PATCH /api/announcements/:id', method: 'PATCH', path: (f) => `/api/announcements/${f.annA}`, body: () => ({ body: 'tampered' }), refuse: NOT_MANAGERS_OF_A },
  { name: 'DELETE /api/announcements/:id', method: 'DELETE', path: (f) => `/api/announcements/${f.annDel}`, refuse: NOT_MANAGERS_OF_A },
  // attendance
  { name: 'POST /api/attendance/clock-in', method: 'POST', path: () => '/api/attendance/clock-in', body: () => ({}), refuse: ['anon', 'deactivatedA'] },
  { name: 'POST /api/attendance/clock-in (another venue\'s person)', method: 'POST', path: () => '/api/attendance/clock-in', body: (f) => ({ userId: f.staffA }), refuse: ['managerB'] },
  { name: 'POST /api/attendance/clock-in (another venue\'s shift)', method: 'POST', path: () => '/api/attendance/clock-in', body: (f) => ({ shiftId: f.shiftA }), refuse: ['staffB', 'managerB'] },
  { name: 'POST /api/attendance/clock-out', method: 'POST', path: () => '/api/attendance/clock-out', body: (f) => ({ userId: f.staffA }), refuse: ['anon', 'deactivatedA', 'managerB'] },
  { name: 'GET /api/attendance/:locationId/weekly-hours', method: 'GET', path: (f) => `/api/attendance/${f.locA}/weekly-hours?weekStart=${f.monday}`, refuse: OUTSIDERS },
  // availability
  { name: 'GET /api/availability/:userId', method: 'GET', path: (f) => `/api/availability/${f.staffA}?weekStart=${f.monday}`, refuse: OUTSIDERS },
  { name: 'POST /api/availability', method: 'POST', path: () => '/api/availability', body: (f) => ({ date: f.tuesday, type: 'PREFERRED_OFF' }), refuse: ['anon', 'deactivatedA'] },
  { name: 'DELETE /api/availability/:id', method: 'DELETE', path: (f) => `/api/availability/${f.markA}`, refuse: [...OUTSIDERS, 'managerA'] },
  // eighty-six
  { name: 'GET /api/eighty-six/:locationId', method: 'GET', path: (f) => `/api/eighty-six/${f.locA}`, refuse: OUTSIDERS },
  { name: 'POST /api/eighty-six', method: 'POST', path: () => '/api/eighty-six', body: () => ({ itemName: `${TAG} olive`, station: 'Bar' }), refuse: ['anon', 'deactivatedA'] },
  { name: 'POST /api/eighty-six (attributed to another venue\'s person)', method: 'POST', path: () => '/api/eighty-six', body: (f) => ({ itemName: `${TAG} salt`, station: 'Bar', createdById: f.staffB }), refuse: ['managerA'] },
  { name: 'PATCH /api/eighty-six/:itemId/back-on', method: 'PATCH', path: (f) => `/api/eighty-six/${f.itemA}/back-on`, body: () => ({}), refuse: OUTSIDERS },
  { name: 'PATCH /api/eighty-six/:itemId/back-on (attributed to another venue\'s person)', method: 'PATCH', path: (f) => `/api/eighty-six/${f.itemOnBehalf}/back-on`, body: (f) => ({ actorId: f.staffB }), refuse: ['managerA'] },
  // floor feedback
  { name: 'POST /api/floor-feedback', method: 'POST', path: () => '/api/floor-feedback', body: () => ({ content: `${TAG} more` }), refuse: ['anon', 'deactivatedA'] },
  { name: 'GET /api/floor-feedback', method: 'GET', path: () => '/api/floor-feedback', refuse: ['anon', 'deactivatedA', 'staffA', 'staffB'] },
  { name: 'PATCH /api/floor-feedback/:id', method: 'PATCH', path: (f) => `/api/floor-feedback/${f.fbA}`, body: () => ({ status: 'flagged' }), refuse: NOT_MANAGERS_OF_A },
  // floor plan
  { name: 'GET /uploads/floor-plans/:filename', method: 'GET', path: (f) => `/uploads/floor-plans/${f.imgFile}`, refuse: OUTSIDERS },
  { name: 'POST /api/floor-plan/upload', method: 'POST', path: () => '/api/floor-plan/upload', body: (f) => form({ locationId: f.locA }, { name: 'file', type: 'image/png' }), refuse: NOT_MANAGERS_OF_A },
  {
    name: 'POST /api/floor-plan/sections',
    method: 'POST',
    path: () => '/api/floor-plan/sections',
    body: (f) => ({ locationId: f.locA, floorPlanImageId: f.imgA, label: `${TAG} Patio`, pinX: 0.2, pinY: 0.2, paxCapacity: 2 }),
    refuse: NOT_MANAGERS_OF_A,
  },
  { name: 'PATCH /api/floor-plan/sections/:sectionId', method: 'PATCH', path: (f) => `/api/floor-plan/sections/${f.secA}`, body: () => ({ label: 'tampered' }), refuse: NOT_MANAGERS_OF_A },
  { name: 'DELETE /api/floor-plan/sections/:sectionId', method: 'DELETE', path: (f) => `/api/floor-plan/sections/${f.secDel}`, refuse: NOT_MANAGERS_OF_A },
  { name: 'GET /api/floor-plan/:locationId', method: 'GET', path: (f) => `/api/floor-plan/${f.locA}`, refuse: OUTSIDERS },
  { name: 'GET /api/floor-plan/:locationId/assignments', method: 'GET', path: (f) => `/api/floor-plan/${f.locA}/assignments?date=${f.tuesday}&period=AM`, refuse: OUTSIDERS },
  {
    name: 'GET /api/floor-plan/:locationId/my-assignments',
    method: 'GET',
    path: (f) => `/api/floor-plan/${f.locA}/my-assignments?staffId=${f.staffA}&startDate=${f.monday}&endDate=${addDays(f.monday, 6)}`,
    refuse: OUTSIDERS,
  },
  {
    name: 'POST /api/floor-plan/assignments',
    method: 'POST',
    path: () => '/api/floor-plan/assignments',
    body: (f) => ({ sectionId: f.secA, staffId: f.staffA2, shiftDate: f.tuesday, period: 'PM' }),
    refuse: NOT_MANAGERS_OF_A,
  },
  {
    name: 'POST /api/floor-plan/assignments (another venue\'s person)',
    method: 'POST',
    path: () => '/api/floor-plan/assignments',
    body: (f) => ({ sectionId: f.secA, staffId: f.staffB, shiftDate: f.tuesday, period: 'PM' }),
    refuse: ['managerA'],
  },
  { name: 'DELETE /api/floor-plan/assignments/:assignmentId', method: 'DELETE', path: (f) => `/api/floor-plan/assignments/${f.asgDel}`, refuse: NOT_MANAGERS_OF_A },
  { name: 'PATCH /api/floor-plan/assignments/:assignmentId/notify', method: 'PATCH', path: (f) => `/api/floor-plan/assignments/${f.asgA}/notify`, refuse: NOT_MANAGERS_OF_A },
  { name: 'POST /api/floor-plan/:locationId/publish', method: 'POST', path: (f) => `/api/floor-plan/${f.locA}/publish`, body: (f) => ({ shiftDate: f.tuesday, period: 'AM' }), refuse: NOT_MANAGERS_OF_A },
  // identity (self only)
  { name: 'DELETE /api/identity/session', method: 'DELETE', path: () => '/api/identity/session', refuse: ['anon', 'deactivatedA'] },
  { name: 'DELETE /api/identity/account', method: 'DELETE', path: () => '/api/identity/account', body: () => ({ confirm: true }), refuse: ['anon', 'deactivatedA'] },
  // invites + onboarding
  { name: 'GET /api/invites/:locationId', method: 'GET', path: (f) => `/api/invites/${f.locA}`, refuse: NOT_MANAGERS_OF_A },
  { name: 'POST /api/invites/:locationId/regenerate', method: 'POST', path: (f) => `/api/invites/${f.locA}/regenerate`, body: () => ({}), refuse: NOT_MANAGERS_OF_A },
  { name: 'POST /api/invites/:locationId/revoke', method: 'POST', path: (f) => `/api/invites/${f.locA}/revoke`, refuse: NOT_MANAGERS_OF_A },
  { name: 'GET /api/onboarding/:locationId/invite', method: 'GET', path: (f) => `/api/onboarding/${f.locA}/invite`, refuse: NOT_MANAGERS_OF_A },
  // kiosk link
  { name: 'GET /api/kiosk/:locationId', method: 'GET', path: (f) => `/api/kiosk/${f.locA}`, refuse: NOT_MANAGERS_OF_A },
  { name: 'POST /api/kiosk/:locationId/regenerate', method: 'POST', path: (f) => `/api/kiosk/${f.locA}/regenerate`, refuse: NOT_MANAGERS_OF_A },
  { name: 'POST /api/kiosk/:locationId/revoke', method: 'POST', path: (f) => `/api/kiosk/${f.locA}/revoke`, refuse: NOT_MANAGERS_OF_A },
  // join approvals
  { name: 'GET /api/join/:locationId/pending', method: 'GET', path: (f) => `/api/join/${f.locA}/pending`, refuse: NOT_MANAGERS_OF_A },
  { name: 'PATCH /api/join/:requestId', method: 'PATCH', path: (f) => `/api/join/${f.jrA}`, body: () => ({ decision: 'decline' }), refuse: NOT_MANAGERS_OF_A },
  // locations
  { name: 'GET /api/locations/:id', method: 'GET', path: (f) => `/api/locations/${f.locA}`, refuse: OUTSIDERS },
  { name: 'PATCH /api/locations/:id', method: 'PATCH', path: (f) => `/api/locations/${f.locA}`, body: () => ({ name: 'tampered' }), refuse: NOT_MANAGERS_OF_A },
  // login links
  { name: 'POST /api/login-links', method: 'POST', path: () => '/api/login-links', body: (f) => ({ userId: f.staffA }), refuse: NOT_MANAGERS_OF_A },
  { name: 'DELETE /api/login-links/:id', method: 'DELETE', path: (f) => `/api/login-links/${f.linkA}`, refuse: NOT_MANAGERS_OF_A },
  // self-scoped reads/writes
  { name: 'GET /api/my-shifts', method: 'GET', path: () => '/api/my-shifts', refuse: ['anon', 'deactivatedA'] },
  { name: 'GET /api/notifications', method: 'GET', path: () => '/api/notifications', refuse: ['anon', 'deactivatedA'] },
  { name: 'PATCH /api/notifications/:id/read', method: 'PATCH', path: (f) => `/api/notifications/${f.notifA}/read`, refuse: [...OUTSIDERS, 'managerA'] },
  { name: 'POST /api/notifications/read-all', method: 'POST', path: () => '/api/notifications/read-all', refuse: ['anon', 'deactivatedA'] },
  // policy documents
  { name: 'GET /uploads/policy-documents/:filename', method: 'GET', path: (f) => `/uploads/policy-documents/${f.docFile}`, refuse: OUTSIDERS },
  { name: 'GET /api/policy-documents/:locationId', method: 'GET', path: (f) => `/api/policy-documents/${f.locA}`, refuse: OUTSIDERS },
  {
    name: 'POST /api/policy-documents/upload',
    method: 'POST',
    path: () => '/api/policy-documents/upload',
    body: () => form({ category: 'HR', title: `${TAG} upload` }, { name: 'file', type: 'application/pdf' }),
    refuse: ['anon', 'deactivatedA', 'staffA', 'staffB'],
  },
  {
    name: 'POST /api/policy-documents/upload (attributed to another venue\'s person)',
    method: 'POST',
    path: () => '/api/policy-documents/upload',
    body: (f) => form({ category: 'HR', title: `${TAG} upload`, uploadedById: f.staffB }, { name: 'file', type: 'application/pdf' }),
    refuse: ['managerA'],
  },
  { name: 'DELETE /api/policy-documents/:id', method: 'DELETE', path: (f) => `/api/policy-documents/${f.docDel}`, refuse: NOT_MANAGERS_OF_A },
  // push
  { name: 'POST /api/push/subscribe', method: 'POST', path: () => '/api/push/subscribe', body: () => ({ endpoint: `https://push.invalid/${TAG}/${randomUUID()}`, keys: { p256dh: 'k', auth: 'a' } }), refuse: ['anon', 'deactivatedA'] },
  { name: 'DELETE /api/push/subscribe', method: 'DELETE', path: () => '/api/push/subscribe', body: (f) => ({ endpoint: f.pushEndpointA }), refuse: ['anon', 'deactivatedA'] },
  // roles
  { name: 'GET /api/roles', method: 'GET', path: () => '/api/roles', refuse: ['anon', 'deactivatedA'] },
  { name: 'POST /api/roles', method: 'POST', path: () => '/api/roles', body: () => ({ name: `${TAG} Barback` }), refuse: ['anon', 'deactivatedA', 'staffA', 'staffB'] },
  { name: 'PATCH /api/roles/:id', method: 'PATCH', path: (f) => `/api/roles/${f.roleA2}`, body: () => ({ name: `${TAG} tampered` }), refuse: NOT_MANAGERS_OF_A },
  { name: 'DELETE /api/roles/:id', method: 'DELETE', path: (f) => `/api/roles/${f.roleDel}`, refuse: NOT_MANAGERS_OF_A },
  // rota templates
  { name: 'GET /api/rota-templates/:locationId', method: 'GET', path: (f) => `/api/rota-templates/${f.locA}`, refuse: OUTSIDERS },
  {
    name: 'POST /api/rota-templates',
    method: 'POST',
    path: () => '/api/rota-templates',
    body: (f) => ({ name: `${TAG} new template`, entries: [{ dayOffset: 0, roleId: f.roleA, userId: f.staffA, start: '09:00', end: '12:00' }] }),
    refuse: ['anon', 'deactivatedA', 'staffA', 'staffB'],
  },
  { name: 'DELETE /api/rota-templates/:id', method: 'DELETE', path: (f) => `/api/rota-templates/${f.tplDel}`, refuse: NOT_MANAGERS_OF_A },
  { name: 'POST /api/rota-templates/:id/apply', method: 'POST', path: (f) => `/api/rota-templates/${f.tplA}/apply`, body: (f) => ({ weekStart: addDays(f.monday, 7) }), refuse: NOT_MANAGERS_OF_A },
  // roster upload
  {
    name: 'POST /api/schedules/upload',
    method: 'POST',
    path: () => '/api/schedules/upload',
    body: () => form({}, { name: 'file', type: 'text/csv' }),
    refuse: ['anon', 'deactivatedA', 'staffA', 'staffB'],
  },
  { name: 'POST /api/schedules/upload/:batchId/confirm', method: 'POST', path: (f) => `/api/schedules/upload/${f.batchA}/confirm`, body: () => ({}), refuse: NOT_MANAGERS_OF_A },
  // shifts
  { name: 'GET /api/shifts/:locationId', method: 'GET', path: (f) => `/api/shifts/${f.locA}?weekStart=${f.monday}`, refuse: OUTSIDERS },
  { name: 'GET /api/shifts/:locationId/publish-status', method: 'GET', path: (f) => `/api/shifts/${f.locA}/publish-status?weekStart=${f.monday}`, refuse: OUTSIDERS },
  {
    name: 'POST /api/shifts',
    method: 'POST',
    path: () => '/api/shifts',
    body: (f) => ({ roleId: f.roleA, userId: f.staffA, date: addDays(f.monday, 5), start: '09:00', end: '12:00' }),
    refuse: NOT_MANAGERS_OF_A,
  },
  {
    name: 'POST /api/shifts (attributed to another venue\'s person)',
    method: 'POST',
    path: () => '/api/shifts',
    body: (f) => ({ roleId: f.roleA, userId: f.staffA, date: addDays(f.monday, 5), start: '13:00', end: '14:00', createdById: f.staffB }),
    refuse: ['managerA'],
  },
  { name: 'PATCH /api/shifts/:id', method: 'PATCH', path: (f) => `/api/shifts/${f.shiftA}`, body: () => ({ start: '10:00' }), refuse: NOT_MANAGERS_OF_A },
  { name: 'PATCH /api/shifts/:id (attributed to another venue\'s person)', method: 'PATCH', path: (f) => `/api/shifts/${f.shiftA2}`, body: (f) => ({ breakMinutes: 15, actorId: f.staffB }), refuse: ['managerA'] },
  { name: 'DELETE /api/shifts/:id', method: 'DELETE', path: (f) => `/api/shifts/${f.shiftDel}`, refuse: NOT_MANAGERS_OF_A },
  {
    name: 'POST /api/shifts/bulk',
    method: 'POST',
    path: () => '/api/shifts/bulk',
    body: (f) => ({ shifts: [{ roleId: f.roleA, userId: f.staffA, date: addDays(f.monday, 6), start: '09:00', end: '11:00' }] }),
    refuse: NOT_MANAGERS_OF_A,
  },
  {
    name: 'POST /api/shifts/bulk (attributed to another venue\'s person)',
    method: 'POST',
    path: () => '/api/shifts/bulk',
    body: (f) => ({ shifts: [{ roleId: f.roleA, userId: f.staffA, date: addDays(f.monday, 6), start: '15:00', end: '16:00' }], createdById: f.staffB }),
    refuse: ['managerA'],
  },
  { name: 'POST /api/shifts/:locationId/publish', method: 'POST', path: (f) => `/api/shifts/${f.locA}/publish`, body: (f) => ({ weekStart: f.monday }), refuse: NOT_MANAGERS_OF_A },
  {
    name: 'POST /api/shifts/:locationId/publish (attributed to another venue\'s person)',
    method: 'POST',
    path: (f) => `/api/shifts/${f.locA}/publish`,
    body: (f) => ({ weekStart: f.monday, publishedById: f.staffB }),
    refuse: ['managerA'],
  },
  // shoutouts
  { name: 'GET /api/shoutouts/:locationId', method: 'GET', path: (f) => `/api/shoutouts/${f.locA}`, refuse: OUTSIDERS },
  { name: 'POST /api/shoutouts', method: 'POST', path: () => '/api/shoutouts', body: (f) => ({ employeeId: f.staffA2, note: `${TAG} nice` }), refuse: ['anon', 'deactivatedA', 'staffB', 'managerB'] },
  { name: 'DELETE /api/shoutouts/:id', method: 'DELETE', path: (f) => `/api/shoutouts/${f.shoutDel}`, refuse: NOT_MANAGERS_OF_A },
  // staff directory
  { name: 'GET /api/staff-directory/:locationId', method: 'GET', path: (f) => `/api/staff-directory/${f.locA}`, refuse: OUTSIDERS },
  { name: 'POST /api/staff-directory', method: 'POST', path: () => '/api/staff-directory', body: () => ({ fullName: `${TAG} new hire` }), refuse: ['anon', 'deactivatedA', 'staffA', 'staffB'] },
  { name: 'PATCH /api/staff-directory/:userId', method: 'PATCH', path: (f) => `/api/staff-directory/${f.staffA}`, body: () => ({ jobTitle: 'tampered' }), refuse: NOT_MANAGERS_OF_A },
  { name: "PATCH /api/staff-directory/:userId (a manager editing the owner's sign-in phone)", method: 'PATCH', path: (f) => `/api/staff-directory/${f.ownerA}`, body: () => ({ phone: randomPhone() }), refuse: ['managerA'] },
  // swap requests
  { name: 'GET /api/swap-requests/:locationId', method: 'GET', path: (f) => `/api/swap-requests/${f.locA}`, refuse: OUTSIDERS },
  { name: 'POST /api/swap-requests', method: 'POST', path: () => '/api/swap-requests', body: (f) => ({ shiftId: f.shiftA2, targetUserId: f.staffA2 }), refuse: OUTSIDERS },
  { name: 'PATCH /api/swap-requests/:id', method: 'PATCH', path: (f) => `/api/swap-requests/${f.swapA}`, body: () => ({ decision: 'denied' }), refuse: NOT_MANAGERS_OF_A },
  // voice
  { name: 'POST /api/voice/transcribe', method: 'POST', path: () => '/api/voice/transcribe', body: () => form({}, { name: 'audio', type: 'audio/webm' }), refuse: ['anon', 'deactivatedA'] },
  { name: 'POST /api/voice/parse-intent', method: 'POST', path: () => '/api/voice/parse-intent', body: () => ({ transcript: 'hello' }), refuse: ['anon', 'deactivatedA'] },
  { name: 'GET /api/voice/interactions', method: 'GET', path: () => '/api/voice/interactions', refuse: ['anon', 'deactivatedA', 'staffA', 'staffB'] },
  ...(
    [
      ['EDIT_SHIFT', (f: Fx) => ({ intent: 'EDIT_SHIFT', shiftId: f.shiftA, start: '11:00' })],
      ['CREATE_SHIFT', (f: Fx) => ({ intent: 'CREATE_SHIFT', roleId: f.roleA, userId: null, date: addDays(f.monday, 2), start: '09:00', end: '10:00' })],
      ['APPROVE_SWAP', (f: Fx) => ({ intent: 'APPROVE_SWAP', swapRequestId: f.swapA })],
      ['APPROVE_JOIN', (f: Fx) => ({ intent: 'APPROVE_JOIN', joinRequestId: f.jrA })],
      ['ASSIGN_SECTION', (f: Fx) => ({ intent: 'ASSIGN_SECTION', sectionId: f.secA, staffId: f.staffA, shiftDate: f.tuesday, period: 'PM' })],
      ['APPLY_ROTA_TEMPLATE', (f: Fx) => ({ intent: 'APPLY_ROTA_TEMPLATE', templateId: f.tplA, weekStart: addDays(f.monday, 14) })],
      ['POST_SHOUTOUT', (f: Fx) => ({ intent: 'POST_SHOUTOUT', targetUserId: f.staffA, content: `${TAG} via voice` })],
      ['REQUEST_SWAP', (f: Fx) => ({ intent: 'REQUEST_SWAP', shiftId: f.shiftA2, targetUserId: f.staffA2 })],
    ] as const
  ).map(([intent, build]): Case => ({
    name: `POST /api/voice/execute ${intent} on venue A's records`,
    method: 'POST',
    path: () => '/api/voice/execute',
    body: (f) => ({ intent: build(f) }),
    refuse: intent === 'REQUEST_SWAP' ? OUTSIDERS : NOT_MANAGERS_OF_A,
  })),
];

for (const c of CASES) {
  test(`refused: ${c.name}`, async () => {
    for (const actor of c.refuse) {
      const { status } = await call(actor, c);
      assertRefused(actor, status, c.name);
    }
  });
}

/** Anonymous by documented decision (health, public config). */
const PUBLIC_BY_DESIGN: Call[] = [
  { method: 'GET', path: () => '/api/health' },
  { method: 'GET', path: () => '/api/health/ready' },
  { method: 'GET', path: () => '/api/identity/config' },
  { method: 'GET', path: () => '/api/push/vapid-public-key' },
];

test('public by design: these answer an anonymous caller (a change here is a product decision, not a refactor)', async () => {
  for (const c of PUBLIC_BY_DESIGN) {
    const { status } = await call('anon', c);
    assert.equal(status, 200, c.path(fx));
  }
});

test('the session gate on uploaded files cannot be stepped around by spelling the path differently', async () => {
  const variants = (dir: string, file: string) => [
    `/uploads/${dir}%2F${file}`,
    `/uploads/${dir}%2f${file}`,
    `/uploads/${dir}%5C${file}`,
    `/uploads/${dir}%5c${file}`,
    `/uploads/./${dir}/${file}`,
    `/uploads//${dir}/${file}`,
  ];
  for (const path of [...variants('floor-plans', fx.imgFile), ...variants('policy-documents', fx.docFile)]) {
    for (const actor of ['anon', 'staffB'] as const) {
      const { status, text } = await call(actor, { method: 'GET', path: () => path });
      assert.ok(status !== 200 && !text.includes('matrix-'), `${actor} ${path.replace(/[0-9a-f-]{36}/, '<file>')} must not serve the file (got ${status})`);
    }
  }
});

test('self-scoped lists never include the other venue\'s records', async () => {
  const lists: [Actor, Call, string[]][] = [
    ['staffB', { method: 'GET', path: () => '/api/my-shifts' }, [fx.shiftA]],
    ['staffB', { method: 'GET', path: () => '/api/notifications' }, [fx.notifA]],
    ['managerB', { method: 'GET', path: () => '/api/roles' }, [fx.roleA]],
    ['managerB', { method: 'GET', path: () => '/api/floor-feedback' }, [fx.fbA]],
    ['managerB', { method: 'GET', path: () => '/api/voice/interactions' }, [fx.locA]],
  ];
  for (const [actor, c, mustNotContain] of lists) {
    const { status, text } = await call(actor, c);
    assert.equal(status, 200, c.path(fx));
    for (const id of mustNotContain) assert.ok(!text.includes(id), `${actor} ${c.path(fx)} must not include venue A's records`);
  }
});

test("nothing of venue A's changed after every refused request", async () => {
  const [ann, fb, jr, shift, staff, owner, notif, sub, loc, role, swap, mark, item, itemOB, sec, tpl, link] = await Promise.all([
    prisma.announcement.findUnique({ where: { id: fx.annA } }),
    prisma.floorFeedback.findUnique({ where: { id: fx.fbA } }),
    prisma.joinRequest.findUnique({ where: { id: fx.jrA } }),
    prisma.shift.findUnique({ where: { id: fx.shiftA } }),
    prisma.user.findUnique({ where: { id: fx.staffA } }),
    prisma.user.findUnique({ where: { id: fx.ownerA } }),
    prisma.notification.findUnique({ where: { id: fx.notifA } }),
    prisma.pushSubscription.findUnique({ where: { endpoint: fx.pushEndpointA } }),
    prisma.location.findUnique({ where: { id: fx.locA } }),
    prisma.role.findUnique({ where: { id: fx.roleA2 } }),
    prisma.shiftSwapRequest.findUnique({ where: { id: fx.swapA } }),
    prisma.availabilityMark.findUnique({ where: { id: fx.markA } }),
    prisma.eightySixItem.findUnique({ where: { id: fx.itemA } }),
    prisma.eightySixItem.findUnique({ where: { id: fx.itemOnBehalf } }),
    prisma.floorSection.findUnique({ where: { id: fx.secA } }),
    prisma.rotaTemplate.findUnique({ where: { id: fx.tplA } }),
    prisma.loginLink.findUnique({ where: { id: fx.linkA } }),
  ]);
  assert.equal(ann?.body, `${TAG} announcement`);
  assert.equal(fb?.status, 'OPEN');
  assert.equal(jr?.status, 'PENDING');
  assert.equal(shift?.startTime.toISOString(), at(fx.tuesday, '13:00').toISOString());
  assert.equal(staff?.jobTitle, null);
  assert.equal(owner?.phone, fx.ownerPhoneA, "the owner's sign-in phone is unchanged");
  assert.equal(notif?.readAt, null);
  assert.equal(sub?.userId, fx.staffA, "another user's DELETE left this device's subscription alone");
  assert.equal(loc?.name, `${TAG} venue A`);
  assert.equal(role?.name, `${TAG} Runner`);
  assert.equal(swap?.status, 'PENDING');
  assert.ok(mark, 'availability mark still there');
  assert.equal(item?.status, 'EIGHTY_SIXED');
  assert.equal(itemOB?.status, 'EIGHTY_SIXED');
  assert.equal(sec?.label, `${TAG} Terrace`);
  assert.ok(tpl, 'template still there');
  assert.equal(link?.revokedAt, null);
  assert.equal(await prisma.announcement.count({ where: { id: fx.annDel } }), 1);
  assert.equal(await prisma.shift.count({ where: { id: fx.shiftDel } }), 1);
  assert.equal(await prisma.shoutout.count({ where: { locationId: fx.locA, note: { contains: 'via voice' } } }), 0);
});

/**
 * Positive controls: the right person gets through with the very same request
 * (so the refusals above are about who asked, not a malformed request). Run
 * after every refusal; order matters only where a control consumes a fixture.
 */
const CONTROLS: [Actor, string][] = [
  ['staffA', 'GET /api/announcements/:locationId'],
  ['ownerA', 'GET /api/ai/usage'],
  ['staffA', 'POST /api/announcements'],
  ['managerA', 'PATCH /api/announcements/:id'],
  ['managerA', 'DELETE /api/announcements/:id'],
  ['staffA', 'POST /api/attendance/clock-in'],
  ['managerA', 'POST /api/attendance/clock-out'],
  ['staffA', 'GET /api/attendance/:locationId/weekly-hours'],
  ['staffA', 'GET /api/availability/:userId'],
  ['staffA', 'POST /api/availability'],
  ['staffA', 'DELETE /api/availability/:id'],
  ['staffA', 'GET /api/eighty-six/:locationId'],
  ['staffA', 'POST /api/eighty-six'],
  ['staffA', 'PATCH /api/eighty-six/:itemId/back-on'],
  ['staffA', 'POST /api/floor-feedback'],
  ['managerA', 'GET /api/floor-feedback'],
  ['managerA', 'PATCH /api/floor-feedback/:id'],
  ['staffA', 'GET /uploads/floor-plans/:filename'],
  ['managerA', 'POST /api/floor-plan/upload'],
  ['managerA', 'POST /api/floor-plan/sections'],
  ['managerA', 'PATCH /api/floor-plan/sections/:sectionId'],
  ['staffA', 'GET /api/floor-plan/:locationId'],
  ['staffA', 'GET /api/floor-plan/:locationId/assignments'],
  ['staffA', 'GET /api/floor-plan/:locationId/my-assignments'],
  ['managerA', 'POST /api/floor-plan/assignments'],
  ['managerA', 'PATCH /api/floor-plan/assignments/:assignmentId/notify'],
  ['managerA', 'DELETE /api/floor-plan/assignments/:assignmentId'],
  ['managerA', 'DELETE /api/floor-plan/sections/:sectionId'],
  ['managerA', 'POST /api/floor-plan/:locationId/publish'],
  ['managerA', 'GET /api/invites/:locationId'],
  ['managerA', 'POST /api/invites/:locationId/regenerate'],
  ['managerA', 'GET /api/onboarding/:locationId/invite'],
  ['managerA', 'POST /api/invites/:locationId/revoke'],
  ['managerA', 'GET /api/kiosk/:locationId'],
  ['managerA', 'POST /api/kiosk/:locationId/regenerate'],
  ['managerA', 'POST /api/kiosk/:locationId/revoke'],
  ['managerA', 'GET /api/join/:locationId/pending'],
  ['managerA', 'PATCH /api/join/:requestId'],
  ['staffA', 'GET /api/locations/:id'],
  ['managerA', 'PATCH /api/locations/:id'],
  ['managerA', 'POST /api/login-links'],
  ['managerA', 'DELETE /api/login-links/:id'],
  ['staffA', 'GET /api/my-shifts'],
  ['staffA', 'GET /api/notifications'],
  ['staffA', 'PATCH /api/notifications/:id/read'],
  ['staffA', 'POST /api/notifications/read-all'],
  ['staffA', 'GET /uploads/policy-documents/:filename'],
  ['staffA', 'GET /api/policy-documents/:locationId'],
  ['managerA', 'POST /api/policy-documents/upload'],
  ['managerA', 'DELETE /api/policy-documents/:id'],
  ['staffA', 'POST /api/push/subscribe'],
  ['staffA', 'DELETE /api/push/subscribe'],
  ['staffA', 'GET /api/roles'],
  ['managerA', 'POST /api/roles'],
  ['managerA', 'PATCH /api/roles/:id'],
  ['managerA', 'DELETE /api/roles/:id'],
  ['staffA', 'GET /api/rota-templates/:locationId'],
  ['managerA', 'POST /api/rota-templates'],
  ['managerA', 'POST /api/rota-templates/:id/apply'],
  ['managerA', 'DELETE /api/rota-templates/:id'],
  ['staffA', 'GET /api/shifts/:locationId'],
  ['staffA', 'GET /api/shifts/:locationId/publish-status'],
  ['managerA', 'POST /api/shifts'],
  ['managerA', 'PATCH /api/shifts/:id'],
  ['managerA', 'DELETE /api/shifts/:id'],
  ['managerA', 'POST /api/shifts/bulk'],
  ['managerA', 'POST /api/shifts/:locationId/publish'],
  ['staffA', 'GET /api/shoutouts/:locationId'],
  ['staffA', 'POST /api/shoutouts'],
  ['managerA', 'DELETE /api/shoutouts/:id'],
  ['staffA', 'GET /api/staff-directory/:locationId'],
  ['managerA', 'POST /api/staff-directory'],
  ['managerA', 'PATCH /api/staff-directory/:userId'],
  ['staffA', 'GET /api/swap-requests/:locationId'],
  ['staffA', 'POST /api/swap-requests'],
  ['managerA', 'PATCH /api/swap-requests/:id'],
  ['managerA', 'GET /api/voice/interactions'],
  ['managerA', "POST /api/voice/execute EDIT_SHIFT on venue A's records"],
  ['managerA', "POST /api/voice/execute ASSIGN_SECTION on venue A's records"],
  ['managerA', "POST /api/voice/execute POST_SHOUTOUT on venue A's records"],
];

test('positive controls: the right person gets through with the same request', async () => {
  for (const [actor, name] of CONTROLS) {
    const c = CASES.find((x) => x.name === name);
    assert.ok(c, `no case named ${name}`);
    const { status, text } = await call(actor, c);
    assert.ok(status >= 200 && status < 300, `${name}: ${actor} should get through, got ${status} ${text.slice(0, 160)}`);
  }
  // Signing out ends only that session.
  const signOut = await fetch(`${baseUrl}/api/identity/session`, { method: 'DELETE', headers: { Authorization: `Bearer ${throwawayToken}` } });
  assert.equal(signOut.status, 204);
});

test('every route the API mounts is covered by this matrix (or listed as public / token-capability)', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = import.meta.dirname;
  const TOKEN_CAPABILITY = new Set([
    'GET /api/join/invite/:token',
    'POST /api/join/request-otp',
    'POST /api/join/verify-otp',
    'POST /api/identity/request-otp',
    'POST /api/identity/verify-otp',
    'POST /api/signup/request-otp',
    'POST /api/signup/verify-otp',
    'POST /api/login-links/peek',
    'POST /api/login-links/redeem',
  ]);
  const PUBLIC = new Set(['GET /api/identity/config', 'GET /api/push/vapid-public-key']);
  const mounts = new Map<string, string>();
  for (const m of readFileSync(join(dir, '..', 'app.ts'), 'utf8').matchAll(/app\.use\('([^']+)', (\w+)\)/g)) mounts.set(m[2]!, m[1]!);
  const covered = new Set(CASES.map((c) => c.name.replace(/ \(.*\)$/, '').replace(/^(POST \/api\/voice\/execute).*/, '$1')));
  const missing: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
    for (const m of readFileSync(join(dir, file), 'utf8').matchAll(/^(\w+Router)\.(get|post|patch|put|delete)\('([^']*)'/gm)) {
      const prefix = mounts.get(m[1]!);
      if (!prefix) continue;
      const route = `${m[2]!.toUpperCase()} ${prefix}${m[3] === '/' ? '' : m[3]}`;
      if (!covered.has(route) && !PUBLIC.has(route) && !TOKEN_CAPABILITY.has(route)) missing.push(route);
    }
  }
  assert.deepEqual(missing, [], 'add new routes to the access matrix');
});
