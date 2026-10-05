import { test, expect, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { cleanupTestOrgs, nextEchoPhone, prisma, testVenueName } from './helpers';

/**
 * Offline-friendly staff schedule (no service worker: the app is already
 * open when the network drops). My Shifts, the Home next-shift card and the
 * staff rota week fall back to the person's saved copy, always labelled
 * "Offline — last updated …", never as live; the copy is wiped on sign-out
 * and on a dead session.
 */
const OFFLINE_PREFIX = 'shiftsync.offline.';

function dubaiDate(offsetDays: number): string {
  const d = new Date(Date.now() + 4 * 3600_000);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
function mondayOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function setUp() {
  const venueName = testVenueName('offline-schedule');
  const org = await prisma.organization.create({ data: { name: venueName } });
  const location = await prisma.location.create({ data: { organizationId: org.id, name: venueName, timezone: 'Asia/Dubai' } });
  const staff = await prisma.user.create({ data: { locationId: location.id, systemRole: 'STAFF', fullName: 'E2E Offline Staff', phone: nextEchoPhone() } });
  const role = await prisma.role.create({ data: { locationId: location.id, name: 'Bartender' } });
  // Dubai wall clock 17:00–23:00 is 13:00–19:00Z; 10:00–14:00 is 06:00–10:00Z.
  const shift = (date: string, startZ: string, endZ: string) =>
    prisma.shift.create({
      data: { locationId: location.id, roleId: role.id, userId: staff.id, status: 'PUBLISHED', date: new Date(`${date}T00:00:00.000Z`), startTime: new Date(`${date}T${startZ}:00.000Z`), endTime: new Date(`${date}T${endZ}:00.000Z`) },
    });
  const first = dubaiDate(1);
  await shift(first, '13:00', '19:00');
  await shift(addDays(first, 7), '06:00', '10:00');
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 86_400_000);
  await prisma.session.create({ data: { userId: staff.id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt } });
  const stored = JSON.stringify({ token, expiresAt: expiresAt.toISOString(), user: { id: staff.id, fullName: staff.fullName, jobTitle: null, locationId: location.id, systemRole: 'STAFF' } });
  return { stored, token, week: mondayOf(first), nextWeek: addDays(mondayOf(first), 7) };
}

async function signIn(page: Page, stored: string, path: string) {
  await page.goto('/login');
  await page.evaluate((s) => localStorage.setItem('shiftsync.session', s), stored);
  await page.goto(path);
}

const offlineKeys = (page: Page) => page.evaluate((p) => Object.keys(localStorage).filter((k) => k.startsWith(p)).length, OFFLINE_PREFIX);

/** In-app navigation (what a tap on a link does), which works offline because the app is already loaded. */
async function navigateInApp(page: Page, path: string) {
  await page.evaluate((to) => {
    history.pushState({}, '', to);
    dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

test.afterEach(async () => {
  await cleanupTestOrgs();
});

test('My Shifts and the Home next-shift card show the saved copy, labelled, when the network drops; live again once back online', async ({ page, context }) => {
  const { stored } = await setUp();
  await signIn(page, stored, '/my-shifts');
  await expect(page.getByTestId('my-shift-time').first()).toHaveText('17:00–23:00');
  await expect(page.getByTestId('offline-label')).toHaveCount(0);
  await navigateInApp(page, '/');
  await expect(page.getByTestId('next-shift-time')).toHaveText('17:00–23:00');
  await expect(page.getByTestId('offline-label')).toHaveCount(0);

  await context.setOffline(true);
  await page.getByRole('link', { name: 'All my shifts' }).click();
  await expect(page.getByTestId('offline-label')).toHaveText(/^Offline — last updated \d{2}:\d{2}$/);
  await expect(page.getByTestId('my-shift-time')).toHaveText(['17:00–23:00', '10:00–14:00']);
  await page.evaluate(() => history.back());
  await expect(page.getByTestId('next-shift-card').getByTestId('offline-label')).toBeVisible();
  await expect(page.getByTestId('next-shift-time')).toHaveText('17:00–23:00');

  await context.setOffline(false);
  await expect(page.getByTestId('offline-label')).toHaveCount(0);
  await expect(page.getByTestId('next-shift-time')).toHaveText('17:00–23:00');
});

test("a staff member's published week is shown from the saved copy, labelled, when it can't be fetched; an unseen week is not invented", async ({ page, context }) => {
  const { stored, week, nextWeek } = await setUp();
  await signIn(page, stored, `/scheduling?week=${week}`);
  await expect(page.getByText(/17:00\s*[–-]\s*23:00/).first()).toBeVisible();
  await navigateInApp(page, `/scheduling?week=${nextWeek}`);
  await expect(page.getByText(/10:00\s*[–-]\s*14:00/).first()).toBeVisible();

  await context.setOffline(true);
  await navigateInApp(page, `/scheduling?week=${week}`);
  await expect(page.getByTestId('offline-label')).toContainText(/Offline — last updated .* the published rota as you last saw it/);
  await expect(page.getByText(/17:00\s*[–-]\s*23:00/).first()).toBeVisible();
  // Back online: the live week replaces the saved copy, and the label goes.
  await context.setOffline(false);
  await expect(page.getByTestId('offline-label')).toHaveCount(0);
  await expect(page.getByText(/17:00\s*[–-]\s*23:00/).first()).toBeVisible();
  await context.setOffline(true);

  await navigateInApp(page, `/scheduling?week=${addDays(week, 21)}`);
  await expect(page.getByTestId('offline-label')).toHaveCount(0);
  await expect(page.getByText(/17:00\s*[–-]\s*23:00/)).toHaveCount(0);
  await context.setOffline(false);
});

test('signing out wipes the saved copy', async ({ page }) => {
  const { stored } = await setUp();
  await signIn(page, stored, '/my-shifts');
  await expect(page.getByTestId('my-shift-time').first()).toBeVisible();
  await expect.poll(() => offlineKeys(page)).toBeGreaterThan(0);
  await page.goto('/profile');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect.poll(() => offlineKeys(page)).toBe(0);
});

test('a dead session (revoked or deactivated) wipes the saved copy', async ({ page }) => {
  const { stored, token } = await setUp();
  await signIn(page, stored, '/my-shifts');
  await expect(page.getByTestId('my-shift-time').first()).toBeVisible();
  await expect.poll(() => offlineKeys(page)).toBeGreaterThan(0);
  await prisma.session.deleteMany({ where: { tokenHash: createHash('sha256').update(token).digest('hex') } });
  await navigateInApp(page, '/');
  await page.waitForURL((u) => u.pathname === '/login');
  await expect.poll(() => offlineKeys(page)).toBe(0);
});
