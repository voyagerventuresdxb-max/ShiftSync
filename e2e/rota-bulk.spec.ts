import { test, expect, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { cleanupTestOrgs, nextEchoPhone, prisma, testVenueName } from './helpers';

/**
 * Bulk actions in the rota builder: select several shifts, then assign them
 * to one person or delete them (delete takes a second tap). Each shift is
 * written on its own, so a refusal (overlap) is reported while the rest go
 * through. Screenshots (390 and 1280 wide) only when SCREENS_DIR is set.
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

async function setUp(page: Page) {
  const venueName = testVenueName('rota-bulk');
  const org = await prisma.organization.create({ data: { name: venueName } });
  const location = await prisma.location.create({ data: { organizationId: org.id, name: venueName, timezone: 'Asia/Dubai' } });
  const owner = await prisma.user.create({ data: { locationId: location.id, systemRole: 'OWNER', fullName: 'E2E Bulk Owner', phone: nextEchoPhone() } });
  const role = await prisma.role.create({ data: { locationId: location.id, name: 'Bartender' } });
  const lina = await prisma.user.create({ data: { locationId: location.id, systemRole: 'STAFF', fullName: 'Lina Bulk', roleId: role.id } });
  const omar = await prisma.user.create({ data: { locationId: location.id, systemRole: 'STAFF', fullName: 'Omar Bulk', roleId: role.id } });
  const monday = futureMonday();
  // Dubai wall clock = UTC + 4.
  const mk = (day: number, userId: string | null, startZ: string, endZ: string) => {
    const date = addDays(monday, day);
    return prisma.shift.create({ data: { locationId: location.id, roleId: role.id, userId, date: new Date(`${date}T00:00:00.000Z`), startTime: new Date(`${date}T${startZ}:00.000Z`), endTime: new Date(`${date}T${endZ}:00.000Z`) } });
  };
  const tueOpen = await mk(1, null, '05:00', '09:00'); // 09:00–13:00
  const wedOpen = await mk(2, null, '06:00', '10:00'); // 10:00–14:00
  const thuLina = await mk(3, lina.id, '13:00', '19:00'); // 17:00–23:00
  await mk(3, omar.id, '14:00', '16:00'); // 18:00–20:00, so Lina's Thursday can't move to Omar

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
  return { location, omar, lina, tueOpen, wedOpen, thuLina };
}

test.afterEach(async () => {
  await cleanupTestOrgs();
});

test('assign a selection to one person; a shift that would overlap is refused and reported, the rest go through', async ({ page }) => {
  const { omar, lina, tueOpen, wedOpen, thuLina } = await setUp(page);
  await page.getByRole('button', { name: /Select shifts/ }).click();
  await expect(page.getByTestId('bulk-bar')).toContainText('0 selected');
  for (const time of ['09:00–13:00', '10:00–14:00', '17:00–23:00']) await page.getByRole('button', { name: time }).click();
  await expect(page.getByRole('button', { name: '09:00–13:00' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('bulk-bar')).toContainText('3 selected');
  await page.getByLabel('Assign selected shifts to').selectOption({ label: 'Omar Bulk' });
  await shot(page, 'f4-bulk-selection');

  await page.getByRole('button', { name: 'Assign', exact: true }).click();
  await expect(page.getByText(/^Assigned 2 shifts; 1 refused — .*can.t overlap/)).toBeVisible();
  const owner = async (id: string) => (await prisma.shift.findUniqueOrThrow({ where: { id } })).userId;
  expect([await owner(tueOpen.id), await owner(wedOpen.id), await owner(thuLina.id)]).toEqual([omar.id, omar.id, lina.id]);
  await expect(page.getByTestId('bulk-bar')).toContainText('0 selected');

  // Leaving select mode: a tap opens the shift again.
  await page.getByRole('button', { name: /Done selecting/ }).click();
  await expect(page.getByTestId('bulk-bar')).toHaveCount(0);
  await page.getByRole('button', { name: '17:00–23:00' }).click();
  await expect(page.getByRole('button', { name: 'Save shift' })).toBeVisible();
});

test('delete a selection: the first tap only asks, the second deletes', async ({ page }) => {
  const { location, tueOpen, wedOpen } = await setUp(page);
  await page.getByRole('button', { name: /Select shifts/ }).click();
  await page.getByRole('button', { name: '09:00–13:00' }).click();
  await page.getByRole('button', { name: '10:00–14:00' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Delete 2 shifts?' })).toBeVisible();
  await shot(page, 'f4-bulk-delete-confirm');
  expect(await prisma.shift.count({ where: { id: { in: [tueOpen.id, wedOpen.id] } } })).toBe(2);
  await page.getByRole('button', { name: 'Delete 2 shifts?' }).click();
  await expect(page.getByText('Deleted 2 shifts.')).toBeVisible();
  expect(await prisma.shift.count({ where: { id: { in: [tueOpen.id, wedOpen.id] } } })).toBe(0);
  expect(await prisma.shift.count({ where: { locationId: location.id } })).toBe(2);
});
