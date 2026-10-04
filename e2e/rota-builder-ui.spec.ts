import { test, expect, type Browser, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { cleanupTestOrgs, nextEchoPhone, prisma, testVenueName } from './helpers';

/**
 * Rota builder features that had engine/API tests but nothing clicking them:
 * collapsible role sections, the per-shift briefing note (through to the
 * staff view), Copy last week, and Save as template → Apply.
 */
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
const weekRange = (monday: string) => ({ gte: new Date(`${monday}T00:00:00.000Z`), lt: new Date(`${addDays(monday, 7)}T00:00:00.000Z`) });

async function venue() {
  const venueName = testVenueName('rota-builder-ui');
  const org = await prisma.organization.create({ data: { name: venueName } });
  const location = await prisma.location.create({ data: { organizationId: org.id, name: venueName, timezone: 'Asia/Dubai' } });
  const owner = await prisma.user.create({ data: { locationId: location.id, systemRole: 'OWNER', fullName: 'E2E Builder Owner', phone: nextEchoPhone() } });
  const role = await prisma.role.create({ data: { locationId: location.id, name: 'Waiter' } });
  const lina = await prisma.user.create({ data: { locationId: location.id, systemRole: 'STAFF', fullName: 'Lina Waiter', roleId: role.id } });
  const monday = futureMonday();
  const tue = addDays(monday, 1);
  // 17:00–23:00 Dubai.
  await prisma.shift.create({ data: { locationId: location.id, roleId: role.id, userId: lina.id, date: new Date(`${tue}T00:00:00.000Z`), startTime: new Date(`${tue}T13:00:00.000Z`), endTime: new Date(`${tue}T19:00:00.000Z`) } });
  return { location, owner, lina, monday };
}

async function signIn(page: Page, user: { id: string; fullName: string; locationId: string; systemRole: string }, path: string) {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 86_400_000);
  await prisma.session.create({ data: { userId: user.id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt } });
  await page.goto('/login');
  await page.evaluate(
    (s) => localStorage.setItem('shiftsync.session', s),
    JSON.stringify({ token, expiresAt: expiresAt.toISOString(), user: { id: user.id, fullName: user.fullName, jobTitle: null, locationId: user.locationId, systemRole: user.systemRole } }),
  );
  await page.goto(path);
}

async function openBuilder(page: Page, browserUser: Parameters<typeof signIn>[1], monday: string) {
  await signIn(page, browserUser, `/scheduling?week=${monday}`);
  await page.waitForSelector('text=Weekly rota builder');
  await expect(page.getByRole('button', { name: '17:00–23:00' })).toHaveCount(1);
}

test.afterEach(async () => {
  await cleanupTestOrgs();
});

test('a role section collapses and expands, hiding and showing its people', async ({ page }) => {
  const { owner, monday } = await venue();
  await openBuilder(page, owner, monday);
  const toggle = page.getByRole('button', { name: /Waiter\s*1 · 1 shift$/i });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: '17:00–23:00' })).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: '17:00–23:00' })).toHaveCount(1);
});

test('a briefing note saved on a shift shows on its chip and, once published, to the staff member', async ({ page, browser }) => {
  const { owner, lina, location, monday } = await venue();
  await openBuilder(page, owner, monday);
  await page.getByRole('button', { name: '17:00–23:00' }).click();
  await page.getByPlaceholder('e.g. VIP table 12 · brief at 15:45').fill('Terrace VIP at 18:00');
  await page.getByRole('button', { name: 'Save shift' }).click();
  await expect(page.getByRole('button', { name: /17:00–23:00.*Terrace VIP at 18:00/ })).toBeVisible();
  await expect.poll(async () => (await prisma.shift.findFirstOrThrow({ where: { userId: lina.id } })).managerNotes).toBe('Terrace VIP at 18:00');

  const published = page.waitForResponse((r) => /\/api\/shifts\/[^/]+\/publish$/.test(r.url()));
  await page.getByRole('button', { name: /Publish & notify/ }).click();
  expect((await published).status()).toBe(200);

  const staffPage = await (browser as Browser).newPage();
  await signIn(staffPage, { ...lina, locationId: location.id }, `/scheduling?week=${monday}`);
  await expect(staffPage.getByText('Terrace VIP at 18:00')).toBeVisible();
  await staffPage.close();
});

test('Copy last week copies the shown week into the next as drafts', async ({ page }) => {
  const { owner, location, monday } = await venue();
  await openBuilder(page, owner, monday);
  await page.getByRole('button', { name: 'Next week' }).click();
  await expect(page.getByRole('button', { name: '17:00–23:00' })).toHaveCount(0);
  await page.getByRole('button', { name: /Copy last week/ }).click();
  await expect(page.getByText('Copied 1 shift from last week as drafts.')).toBeVisible();
  await expect(page.getByRole('button', { name: '17:00–23:00' })).toHaveCount(1);
  const copied = await prisma.shift.findMany({ where: { locationId: location.id, date: weekRange(addDays(monday, 7)) } });
  expect(copied.map((s) => s.status)).toEqual(['DRAFT']);
});

test('Save as template, then Apply it to a later week', async ({ page }) => {
  const { owner, location, monday } = await venue();
  await openBuilder(page, owner, monday);
  await page.getByRole('button', { name: /Save as template/ }).click();
  await page.getByPlaceholder('e.g. Standard weekend cover').fill('E2E standard week');
  await page.getByRole('button', { name: 'Save template' }).click();
  await expect(page.getByText('Saved "E2E standard week" — 1 shifts captured.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Templates \(1\)/ })).toBeVisible();

  await page.getByRole('button', { name: 'Next week' }).click();
  await page.getByRole('button', { name: 'Next week' }).click();
  await page.getByRole('button', { name: /Templates \(1\)/ }).click();
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('Applied "E2E standard week" — 1 shifts created.')).toBeVisible();
  expect(await prisma.shift.count({ where: { locationId: location.id, date: weekRange(addDays(monday, 14)) } })).toBe(1);
});
