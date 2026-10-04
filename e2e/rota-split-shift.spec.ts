import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { cleanupTestOrgs, continueThroughVenue, nextEchoPhone, prisma, signupNewVenue, testVenueName } from './helpers';

/**
 * Split shifts, end to end on a phone-sized frame with two real sessions:
 * the manager builds a draft week and gives one person two segments on one
 * day through the real builder (11:00–15:00 and 18:00–23:00), the builder
 * sums them (day + week), an overlapping third segment is refused in the
 * sheet, the staff member sees nothing while it is a draft, and after
 * publish sees both segments on My Shifts and Personal Rota — with one
 * digest notification listing both. Real API and DB, no interception.
 */

const PHONE = { width: 380, height: 822 };
const phones: string[] = [];

test.describe.configure({ mode: 'serial' });

async function phoneContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true });
}

function collectErrors(page: Page, into: string[]) {
  page.on('pageerror', (e) => into.push(e.message));
  page.on('console', (m) => {
    // A refused save is a real 409 from the API — the browser logs the failed request itself.
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) into.push(m.text());
  });
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

async function addSegment(m: Page, row: ReturnType<typeof builderRow>, day: string, start: string, end: string) {
  await row.getByRole('button', { name: `Add shift on ${day}` }).click();
  await expect(m.getByRole('heading', { name: 'New shift' })).toBeVisible();
  await m.locator('input[type=time]').nth(0).fill(start);
  await m.locator('input[type=time]').nth(1).fill(end);
  await m.getByRole('button', { name: 'Add shift', exact: true }).click();
}

test.afterAll(async () => {
  await cleanupTestOrgs();
  await prisma.otpCode.deleteMany({ where: { phone: { in: phones } } });
});

test('split shift: two segments in the builder → summed hours → hidden from staff as a draft → published → staff sees both', async ({ browser }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  const managerCtx = await phoneContext(browser);
  const staffCtx = await phoneContext(browser);
  try {
    const m = await managerCtx.newPage();
    collectErrors(m, errors);

    // ---- setup: a fresh venue (owner = manager) and one staff member ----
    const venueName = testVenueName('split-shift');
    const { phone: ownerPhone } = await signupNewVenue(m, venueName);
    phones.push(ownerPhone);
    await continueThroughVenue(m);
    await m.getByRole('button', { name: /Skip for now/ }).click();
    await m.waitForSelector('text=Venue join-link', { timeout: 15000 });
    await m.getByRole('button', { name: /Skip — invite later/ }).click();
    await m.getByRole('button', { name: 'Continue to Dashboard' }).click();
    await m.waitForURL(/\/$/, { timeout: 10000 });
    const location = (await prisma.location.findFirst({ where: { name: venueName } }))!;

    await m.goto('/people');
    const dirToggle = m.getByRole('button', { name: /Staff Directory/ });
    if ((await dirToggle.getAttribute('aria-expanded')) !== 'true') await dirToggle.click();
    await m.getByPlaceholder('Full name').fill('Sara Split');
    await m.getByPlaceholder(/Job title/).fill('Bartender');
    await m.getByRole('button', { name: 'Add staff member' }).click();
    await expect(m.getByRole('cell', { name: 'Sara Split' })).toBeVisible();
    const staffPhone = nextEchoPhone();
    phones.push(staffPhone);
    const phoneInput = m.getByRole('row', { name: /Sara Split/ }).locator('input').nth(1);
    await phoneInput.fill(staffPhone);
    await phoneInput.blur();
    await m.getByRole('combobox', { name: 'Role for Sara Split' }).selectOption({ label: 'Bartender' });
    await expect.poll(async () => (await prisma.user.findFirst({ where: { locationId: location.id, fullName: 'Sara Split' }, include: { role: true } }))?.role?.name).toBe('Bartender');
    await expect.poll(async () => (await prisma.user.findFirst({ where: { locationId: location.id, fullName: 'Sara Split' } }))?.phone).toBe(staffPhone);
    const sara = (await prisma.user.findFirst({ where: { locationId: location.id, fullName: 'Sara Split' } }))!;

    // ---- manager: next week, two segments for Sara on Tuesday ----
    await m.goto('/scheduling');
    const toggle = m.getByRole('button', { name: /Weekly rota builder/ });
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    await expect(m).toHaveURL(/week=\d{4}-\d{2}-\d{2}/);
    const weekStart = addDays(new URL(m.url()).searchParams.get('week')!, 7);
    await m.getByRole('button', { name: 'Next week' }).click();
    await expect(m).toHaveURL(new RegExp(`week=${weekStart}`));
    const tue = addDays(weekStart, 1);
    const row = builderRow(m, 'Sara Split');

    await addSegment(m, row, tue, '11:00', '15:00');
    await expect(m.getByRole('heading', { name: 'New shift' })).toHaveCount(0);
    await expect(row.getByTitle('Hours this week')).toHaveText('4.0h');
    await expect(row.getByTitle('Hours this day')).toHaveCount(0);

    // The cell keeps its "+" with a shift in it: that's how a second segment is added.
    await addSegment(m, row, tue, '18:00', '23:00');
    await expect(m.getByRole('heading', { name: 'New shift' })).toHaveCount(0);
    await expect(row.getByRole('button', { name: '11:00–15:00' })).toBeVisible();
    await expect(row.getByRole('button', { name: '18:00–23:00' })).toBeVisible();
    await expect(row.getByTitle('Hours this day')).toHaveText('9.0h total');
    await expect(row.getByTitle('Hours this week')).toHaveText('9.0h');

    // A third segment overlapping the first is refused, and the reason shows inside the sheet.
    await addSegment(m, row, tue, '14:00', '16:00');
    await expect(m.getByRole('alert').filter({ hasText: 'already works' })).toHaveText(`Sara Split already works 11:00–15:00 on ${tue} — two shifts for one person can't overlap.`);
    await m.locator('header', { has: m.getByRole('heading', { name: 'New shift' }) }).getByRole('button', { name: 'Close' }).click();
    await expect(m.getByRole('heading', { name: 'New shift' })).toHaveCount(0);
    await expect(row.getByTitle('Hours this week')).toHaveText('9.0h');
    expect(await m.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);

    const drafts = await prisma.shift.findMany({ where: { locationId: location.id }, orderBy: { startTime: 'asc' } });
    expect(drafts.map((s) => [s.date.toISOString().slice(0, 10), s.status, s.userId])).toEqual([
      [tue, 'DRAFT', sara.id],
      [tue, 'DRAFT', sara.id],
    ]);
    // 11:00 and 18:00 in Dubai (UTC+4).
    expect(drafts.map((s) => s.startTime.toISOString())).toEqual([`${tue}T07:00:00.000Z`, `${tue}T14:00:00.000Z`]);

    // ---- staff signs in on their own phone (this base: /join?mode=login + dev echo); the draft is invisible ----
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
    await s.goto(`/scheduling?week=${weekStart}`);
    await expect(s.getByRole('button', { name: 'Personal Rota' })).toBeVisible();
    await expect(s.getByText(/11:00/)).toHaveCount(0);
    await expect(s.getByText(/18:00/)).toHaveCount(0);

    // ---- publish: one person notified, once ----
    const publishRes = m.waitForResponse((r) => /\/api\/shifts\/[^/]+\/publish$/.test(r.url()));
    await m.getByRole('button', { name: /Publish & notify/ }).click();
    const published = await publishRes;
    expect(published.status()).toBe(200);
    expect(await published.json()).toMatchObject({ notifiedCount: 1 });
    await expect(m.getByText('Rota published — 1 staff notified.')).toBeVisible();
    await expect.poll(async () => (await prisma.notification.findMany({ where: { userId: sara.id } })).length).toBe(1);
    await m.waitForTimeout(500);
    const digests = await prisma.notification.findMany({ where: { userId: sara.id } });
    expect(digests, 'one digest for the split day, not one per segment').toHaveLength(1);
    expect(digests[0]!.body).toMatch(new RegExp(`^Your schedule for the week of ${weekStart} is up: Tue \\d{1,2} \\w{3} 11:00–15:00 \\+ 18:00–23:00\\.$`));

    // ---- staff: both segments on My Shifts and on Personal Rota (one day card, hours summed) ----
    await s.goto('/my-shifts');
    const mine = s.locator('li', { hasText: 'Bartender' });
    await expect(mine).toHaveCount(2);
    await expect(mine.nth(0)).toContainText(new RegExp(`(${tue}|\\w{3},? \\d{1,2} \\w{3,4}) · Bartender · 11:00–15:00`));
    await expect(mine.nth(1)).toContainText(new RegExp(`(${tue}|\\w{3},? \\d{1,2} \\w{3,4}) · Bartender · 18:00–23:00`));

    await s.goto(`/scheduling?week=${weekStart}`);
    const card = s.locator('article', { has: s.getByRole('heading', { name: 'Bartender' }) });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('11:00 – 15:00 · 18:00 – 23:00');
    await expect(card).toContainText('9.0h');
    await expect(card).toContainText('Confirmed');
    expect(await s.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);

    expect(errors, errors.join('\n')).toEqual([]);
  } finally {
    await managerCtx.close().catch(() => {});
    await staffCtx.close().catch(() => {});
  }
});
