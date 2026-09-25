import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:https';
import { createECDH, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { cleanupTestOrgs, continueThroughVenue, prisma, signupNewVenue, testVenueName } from './helpers';

/**
 * The golden path, end to end, on a phone-sized frame (380×822), with two
 * real sessions against the real API and database:
 *
 *   1. manager builds next week's rota (shifts + a leave chip)
 *   2. manager publishes (existing digest path)
 *   3. staff sees the shifts on Personal Rota and /my-shifts, and a push is delivered
 *   4. manager edits one shift by voice (EDIT_SHIFT)
 *   5. staff sees the change without a reload, and a push is delivered
 *
 * Only two things are intercepted, both at the network layer:
 *  - push DELIVERY: the staff member's PushSubscription points at an HTTPS
 *    receiver this spec runs on localhost (headless Chromium has no real
 *    push service). Everything up to the HTTP POST — Notification row,
 *    VAPID signing, payload encryption — is the real server code.
 *  - voice /transcribe and /parse-intent (Gemini) are faked in the browser;
 *    /execute runs for real. golden-path.live.spec.ts (@live) covers real
 *    Gemini and is excluded from the regular gate.
 *
 * Needs, besides the usual e2e setup:
 *  - VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in .env (`npx web-push generate-vapid-keys`)
 *  - the push receiver's certificate trusted by the API server, via the TEST
 *    COMMAND's env only (see scripts/e2e-push-sink-cert.mjs):
 *      node scripts/e2e-push-sink-cert.mjs
 *      NODE_EXTRA_CA_CERTS="<cert path>" npm run test:e2e -- golden-path --grep-invert @live
 */

const PUSH_SINK_DIR = join(tmpdir(), 'shiftsync-e2e-push-sink');
const API = 'http://localhost:4000';
const PHONE = { width: 380, height: 822 };

// Mic for the voice keystone: Chromium's fake device + auto-accepted prompt.
test.use({ launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] } });
test.describe.configure({ mode: 'serial' });

interface PushHit {
  path: string;
  authorization: string;
  encoding: string;
  bytes: number;
}

function startPushSink(): Promise<{ server: Server; port: number; hits: PushHit[] }> {
  const certPath = join(PUSH_SINK_DIR, 'cert.pem');
  const keyPath = join(PUSH_SINK_DIR, 'key.pem');
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    throw new Error('Push receiver certificate missing — run `node scripts/e2e-push-sink-cert.mjs` first (see this spec\'s header).');
  }
  const hits: PushHit[] = [];
  const server = createServer({ cert: readFileSync(certPath), key: readFileSync(keyPath) }, (req, res) => {
    let bytes = 0;
    req.on('data', (c: Buffer) => (bytes += c.length));
    req.on('end', () => {
      hits.push({
        path: req.url ?? '',
        authorization: String(req.headers.authorization ?? ''),
        encoding: String(req.headers['content-encoding'] ?? ''),
        bytes,
      });
      res.writeHead(201).end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port, hits })));
}

async function phoneContext(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true, permissions: ['microphone'] });
  return ctx;
}

function collectErrors(page: Page, into: string[]) {
  page.on('pageerror', (e) => into.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) into.push(m.text());
  });
}

/** The page never scrolls sideways on a phone — only designated inner scrollers may. */
async function expectNoHorizontalPageScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);
}

async function openBuilder(page: Page) {
  const toggle = page.getByRole('button', { name: /Weekly rota builder/ });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

/** A person's row in the builder grid (the innermost element holding both their name and their add buttons). */
function builderRow(page: Page, name: string) {
  return page
    .locator('div')
    .filter({ has: page.getByText(name, { exact: true }) })
    .filter({ has: page.getByRole('button', { name: /^Add shift on / }) })
    .last();
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

test.afterAll(async () => {
  await cleanupTestOrgs();
});

test('golden path: build → publish → staff sees + push → voice edit → staff sees update + push', async ({ browser }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];

  // Preconditions that would otherwise surface as a confusing failure later.
  const vapid = (await (await fetch(`${API}/api/push/vapid-public-key`)).json()) as { publicKey?: string };
  expect(vapid.publicKey, 'VAPID keys must be set in .env for push delivery (see spec header)').toBeTruthy();
  const sink = await startPushSink();

  const managerCtx = await phoneContext(browser);
  const staffCtx = await phoneContext(browser);
  try {
    const m = await managerCtx.newPage();
    collectErrors(m, errors);

    // ---- setup: a fresh venue (owner = manager) and one staff member ----
    const venueName = testVenueName('golden-path');
    await signupNewVenue(m, venueName);
    await continueThroughVenue(m);
    await m.getByRole('button', { name: /Skip for now/ }).click();
    await m.waitForSelector('text=Venue join-link', { timeout: 15000 });
    await m.getByRole('button', { name: /Skip — invite later/ }).click();
    await m.getByRole('button', { name: 'Continue to Dashboard' }).click();
    await m.waitForURL(/\/$/, { timeout: 10000 });
    const location = (await prisma.location.findFirst({ where: { name: venueName } }))!;
    const manager = (await prisma.user.findFirst({ where: { locationId: location.id, systemRole: 'OWNER' } }))!;

    await m.goto('/people');
    const dirToggle = m.getByRole('button', { name: /Staff Directory/ });
    if ((await dirToggle.getAttribute('aria-expanded')) !== 'true') await dirToggle.click();
    await m.getByPlaceholder('Full name').fill('Sara Staff');
    await m.getByPlaceholder(/Job title/).fill('Bartender');
    await m.getByRole('button', { name: 'Add staff member' }).click();
    await expect(m.getByRole('cell', { name: 'Sara Staff' })).toBeVisible();
    const staffPhone = `+97155${Date.now().toString().slice(-7)}`;
    const phoneInput = m.getByRole('row', { name: /Sara Staff/ }).locator('input').nth(1);
    await phoneInput.fill(staffPhone);
    await phoneInput.blur();
    await m.getByRole('combobox', { name: 'Role for Sara Staff' }).selectOption({ label: 'Bartender' });
    await expect.poll(async () => (await prisma.user.findFirst({ where: { locationId: location.id, fullName: 'Sara Staff' }, include: { role: true } }))?.role?.name).toBe('Bartender');
    await expect.poll(async () => (await prisma.user.findFirst({ where: { locationId: location.id, fullName: 'Sara Staff' } }))?.phone).toBe(staffPhone);
    const sara = (await prisma.user.findFirst({ where: { locationId: location.id, fullName: 'Sara Staff' } }))!;
    await expectNoHorizontalPageScroll(m);

    // Staff member's device subscription → our HTTPS receiver (real P-256 keys, so the server's encryption really runs).
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    await prisma.pushSubscription.create({
      data: { userId: sara.id, endpoint: `https://localhost:${sink.port}/push/${sara.id}`, p256dh: ecdh.getPublicKey('base64url'), auth: randomBytes(16).toString('base64url') },
    });

    // ---- 1. manager builds NEXT week (future days, so /my-shifts lists them) ----
    await m.goto('/scheduling');
    await openBuilder(m);
    await expect(m).toHaveURL(/week=\d{4}-\d{2}-\d{2}/);
    const weekStart = addDays(new URL(m.url()).searchParams.get('week')!, 7);
    await m.getByRole('button', { name: 'Next week' }).click();
    await expect(m).toHaveURL(new RegExp(`week=${weekStart}`));
    const [tue, wed, fri, sat] = [1, 2, 4, 5].map((n) => addDays(weekStart, n));
    const row = builderRow(m, 'Sara Staff');

    for (const day of [tue, wed, fri]) {
      await row.getByRole('button', { name: `Add shift on ${day}` }).click();
      await expect(m.getByRole('heading', { name: 'New shift' })).toBeVisible();
      await expectNoHorizontalPageScroll(m);
      // Role is prefilled from the directory; set the times.
      await expect(m.locator('select').filter({ hasText: 'Select a role…' })).toHaveValue(sara.roleId!);
      await m.locator('input[type=time]').nth(0).fill('17:00');
      await m.locator('input[type=time]').nth(1).fill('23:00');
      await m.getByRole('button', { name: 'Add shift', exact: true }).click();
      await expect(m.getByRole('heading', { name: 'New shift' })).toHaveCount(0);
    }
    // Leave chip on Saturday: it replaces the "+" for that cell.
    await row.getByRole('button', { name: `Add shift on ${sat}` }).click();
    await m.getByRole('radio', { name: 'Annual Leave' }).click();
    await m.getByRole('button', { name: 'Mark Annual Leave' }).click();
    await expect(m.getByRole('button', { name: `Annual Leave on ${sat}` })).toBeVisible();
    await expect(row.getByRole('button', { name: `Add shift on ${sat}` })).toHaveCount(0);
    await expectNoHorizontalPageScroll(m);

    const drafts = await prisma.shift.findMany({ where: { locationId: location.id }, orderBy: { date: 'asc' } });
    expect(drafts.map((s) => [s.date.toISOString().slice(0, 10), s.status, s.userId])).toEqual([
      [tue, 'DRAFT', sara.id],
      [wed, 'DRAFT', sara.id],
      [fri, 'DRAFT', sara.id],
    ]);
    // 17:00 in Dubai (UTC+4) is 13:00Z.
    expect(drafts[0]!.startTime.toISOString()).toBe(`${tue}T13:00:00.000Z`);
    expect(await prisma.rotaLeave.count({ where: { userId: sara.id, date: new Date(`${sat}T00:00:00.000Z`), status: 'DRAFT' } })).toBe(1);

    // ---- staff logs in on their own phone; drafts are invisible to them ----
    const s = await staffCtx.newPage();
    collectErrors(s, errors);
    await s.goto('/join?mode=login');
    await s.getByPlaceholder('Phone number').fill(staffPhone);
    await s.getByRole('button', { name: 'Send code' }).click();
    const code = ((await s.getByText(/Dev mode — your code is/).innerText()).match(/\d{6}/) ?? [''])[0];
    await s.getByPlaceholder('6-digit code').fill(code);
    await s.getByRole('button', { name: 'Verify & log in' }).click();
    await s.waitForURL('**/my-shifts**', { timeout: 15000 });
    await expect(s.getByText('No upcoming shifts scheduled yet.')).toBeVisible();

    // ---- 2. publish ----
    const publishRes = m.waitForResponse((r) => /\/api\/shifts\/[^/]+\/publish$/.test(r.url()));
    await m.getByRole('button', { name: /Publish & notify/ }).click();
    const published = await publishRes;
    expect(published.status()).toBe(200);
    expect(await published.json()).toMatchObject({ notifiedCount: 1 });
    await expect(m.getByText('Rota published — 1 staff notified.')).toBeVisible();
    expect(new Set((await prisma.shift.findMany({ where: { locationId: location.id } })).map((x) => x.status))).toEqual(new Set(['PUBLISHED']));
    expect((await prisma.rotaLeave.findFirst({ where: { userId: sara.id } }))?.status).toBe('PUBLISHED');
    const rotaPublish = await prisma.rotaPublish.findFirst({ where: { locationId: location.id } });
    expect(rotaPublish?.publishedById, 'publisher is the signed-in manager, never the "Viewing" employee').toBe(manager.id);

    // ---- 3. staff: digest notification + push delivered; shifts visible ----
    await expect.poll(async () => (await prisma.notification.findMany({ where: { userId: sara.id } })).map((n) => n.title)).toEqual(['Schedule updated']);
    await expect.poll(() => sink.hits.length, { message: 'no push reached the receiver — was the API server started with NODE_EXTRA_CA_CERTS? (spec header)' }).toBe(1);
    expect(sink.hits[0]).toMatchObject({ path: `/push/${sara.id}`, encoding: 'aes128gcm' });
    expect(sink.hits[0]!.authorization).toMatch(/^vapid t=.+, k=.+/);

    // Coming back to the app (focus) refetches /my-shifts — no reload.
    await s.evaluate(() => window.dispatchEvent(new Event('focus')));
    const myShifts = s.locator('li', { hasText: 'Bartender' });
    await expect(myShifts).toHaveCount(3);
    await expect(myShifts.first()).toContainText(`${tue} · Bartender · 17:00–23:00`);

    await s.goto(`/scheduling?week=${weekStart}`);
    await expect(s.getByRole('heading', { name: 'Bartender' })).toHaveCount(3);
    await expect(s.getByRole('heading', { name: 'Annual Leave' })).toBeVisible();
    await expect(s.getByText('17:00 – 23:00')).toHaveCount(3);
    // Staff never see builder/upload controls.
    await expect(s.getByRole('button', { name: /Weekly rota builder/ })).toHaveCount(0);
    await expect(s.getByText('Upload Roster')).toHaveCount(0);
    await expectNoHorizontalPageScroll(s);

    // ---- 4. manager edits Tuesday's shift by voice ----
    const tuesday = drafts[0]!;
    const transcript = "Move Sara's Tuesday shift to six till half eleven";
    await m.route('**/api/voice/transcribe', (r) => r.fulfill({ json: { transcript } }));
    await m.route('**/api/voice/parse-intent', (r) =>
      r.fulfill({
        json: {
          transcript,
          intent: { intent: 'EDIT_SHIFT', shiftId: tuesday.id, start: '18:00', end: '23:30', confidence: 0.95, summary: `Move Sara Staff's ${tue} shift to 18:00–23:30` },
          voiceLogId: null,
          hasAdditionalRequest: false,
        },
      }),
    );
    await m.getByRole('button', { name: 'Start recording a voice command' }).click();
    // The recording button pulses (CSS animation), so Playwright never sees it "stable" — dispatch the tap.
    await m.getByRole('button', { name: 'Stop recording voice command' }).dispatchEvent('click');
    const confirm = m.getByRole('button', { name: 'Confirm', exact: true });
    await expect(confirm).toBeVisible();
    await expect(m.getByText(`Move Sara Staff's ${tue} shift to 18:00–23:30`)).toBeVisible();
    // The confirm sheet fits the phone (it used to be pushed half off-screen).
    const box = (await confirm.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
    const executed = m.waitForResponse((r) => r.url().endsWith('/api/voice/execute'));
    await confirm.click();
    expect((await executed).status()).toBe(200);

    const edited = (await prisma.shift.findUnique({ where: { id: tuesday.id } }))!;
    expect([edited.startTime.toISOString(), edited.endTime.toISOString(), edited.status]).toEqual([`${tue}T14:00:00.000Z`, `${tue}T19:30:00.000Z`, 'PUBLISHED']);
    const audit = await prisma.auditLog.findFirst({ where: { entityId: tuesday.id, action: 'SHIFT_UPDATED' } });
    expect(audit?.actorId).toBe(manager.id);
    expect(audit?.note).toContain('[voice]');

    // ---- 5. staff: change notification + push, and the new time without a reload ----
    await expect.poll(async () => (await prisma.notification.findMany({ where: { userId: sara.id }, orderBy: { createdAt: 'asc' } })).map((n) => n.title)).toEqual([
      'Schedule updated',
      'Shift changed',
    ]);
    const change = await prisma.notification.findFirst({ where: { userId: sara.id, title: 'Shift changed' } });
    expect(change?.body).toMatch(/17:00–23:00 is now .*18:00–23:30\.$/);
    await expect.poll(() => sink.hits.length).toBe(2);

    const urlBefore = s.url();
    await s.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(s.getByText('18:00 – 23:30')).toBeVisible();
    await expect(s.getByText('17:00 – 23:00')).toHaveCount(2);
    expect(s.url()).toBe(urlBefore);

    expect(errors, errors.join('\n')).toEqual([]);
  } finally {
    await managerCtx.close().catch(() => {});
    await staffCtx.close().catch(() => {});
    await new Promise<void>((r) => sink.server.close(() => r()));
  }
});
