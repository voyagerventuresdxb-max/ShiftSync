import { test, expect, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { cleanupTestOrgs, nextEchoPhone, prisma, testVenueName } from './helpers';

/**
 * Uncovered-shift flags in the rota builder: shifts with nobody assigned are
 * counted in the header and per day, and publishing a week that still has
 * them takes a second, explicit tap. Screenshots (390 and 1280 wide) are
 * written only when SCREENS_DIR is set.
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

async function shot(page: Page, name: string) {
  const dir = process.env.SCREENS_DIR;
  if (!dir) return;
  for (const [width, height] of [
    [390, 844],
    [1280, 800],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(dir, `${name}-${width}.png`), fullPage: true });
  }
}

test.afterEach(async () => {
  await cleanupTestOrgs();
});

test('uncovered shifts are flagged in the header and per day, and publishing them needs a second tap', async ({ page }) => {
  const venueName = testVenueName('rota-uncovered');
  const org = await prisma.organization.create({ data: { name: venueName } });
  const location = await prisma.location.create({ data: { organizationId: org.id, name: venueName, timezone: 'Asia/Dubai' } });
  const owner = await prisma.user.create({ data: { locationId: location.id, systemRole: 'OWNER', fullName: 'E2E Uncovered Owner', phone: nextEchoPhone() } });
  const staff = await prisma.user.create({ data: { locationId: location.id, systemRole: 'STAFF', fullName: 'Sami Cover' } });
  const role = await prisma.role.create({ data: { locationId: location.id, name: 'Bartender' } });
  const monday = futureMonday();
  const tue = addDays(monday, 1);
  const wed = addDays(monday, 2);
  const mk = (date: string, userId: string | null) =>
    prisma.shift.create({ data: { locationId: location.id, roleId: role.id, userId, date: new Date(`${date}T00:00:00.000Z`), startTime: new Date(`${date}T13:00:00.000Z`), endTime: new Date(`${date}T19:00:00.000Z`) } });
  const open = await mk(tue, null);
  await mk(wed, staff.id);

  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 86_400_000);
  await prisma.session.create({ data: { userId: owner.id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt } });
  await page.goto('/login');
  await page.evaluate(
    (s) => localStorage.setItem('shiftsync.session', s),
    JSON.stringify({ token, expiresAt: expiresAt.toISOString(), user: { id: owner.id, fullName: owner.fullName, jobTitle: null, locationId: location.id, systemRole: 'OWNER' } }),
  );
  await page.goto(`/scheduling?week=${monday}`);
  await page.waitForSelector('text=Weekly rota builder');

  await expect(page.getByTestId('uncovered-badge')).toHaveText('1 uncovered shift');
  await expect(page.getByTestId(`uncovered-day-${tue}`)).toHaveText('1 open');
  await expect(page.getByTestId(`uncovered-day-${wed}`)).toHaveCount(0);
  await shot(page, 'f1-uncovered-badge');

  // First tap only warns; nothing is published.
  await page.getByRole('button', { name: /Publish & notify/ }).click();
  await expect(page.getByRole('button', { name: 'Publish with 1 uncovered shift?' })).toBeVisible();
  await expect(page.getByText('1 uncovered shift this week — nobody is assigned. Tap publish again to publish anyway.')).toBeVisible();
  await shot(page, 'f1-publish-confirm');
  expect(await prisma.rotaPublish.count({ where: { locationId: location.id } })).toBe(0);

  // Second tap publishes.
  const published = page.waitForResponse((r) => /\/api\/shifts\/[^/]+\/publish$/.test(r.url()));
  await page.getByRole('button', { name: 'Publish with 1 uncovered shift?' }).click();
  expect((await published).status()).toBe(200);
  await expect.poll(async () => (await prisma.shift.findUniqueOrThrow({ where: { id: open.id } })).status).toBe('PUBLISHED');

  // Covering it clears every flag.
  await prisma.shift.update({ where: { id: open.id }, data: { userId: staff.id } });
  await page.goto(`/scheduling?week=${monday}`);
  await page.waitForSelector('text=Weekly rota builder');
  await expect(page.getByTestId('uncovered-badge')).toHaveCount(0);
  await expect(page.getByTestId(`uncovered-day-${tue}`)).toHaveCount(0);
});
