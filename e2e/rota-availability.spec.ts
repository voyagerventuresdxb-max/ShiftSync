import { test, expect, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { cleanupTestOrgs, nextEchoPhone, prisma, testVenueName } from './helpers';

/**
 * Availability in the rota builder covers everyone at the venue, including
 * people with no shift yet — the moment a manager is deciding who to put on.
 * Screenshots (390 and 1280 wide) are written only when SCREENS_DIR is set.
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

test("a staff member with no shift yet shows their unavailable and preferred-off days, with the note, in the builder", async ({ page }) => {
  const venueName = testVenueName('rota-availability');
  const org = await prisma.organization.create({ data: { name: venueName } });
  const location = await prisma.location.create({ data: { organizationId: org.id, name: venueName, timezone: 'Asia/Dubai' } });
  const owner = await prisma.user.create({ data: { locationId: location.id, systemRole: 'OWNER', fullName: 'E2E Availability Owner', phone: nextEchoPhone() } });
  const role = await prisma.role.create({ data: { locationId: location.id, name: 'Bartender' } });
  const nadia = await prisma.user.create({ data: { locationId: location.id, systemRole: 'STAFF', fullName: 'Nadia Free', roleId: role.id } });
  const monday = futureMonday();
  await prisma.availabilityMark.createMany({
    data: [
      { userId: nadia.id, date: new Date(`${addDays(monday, 1)}T00:00:00.000Z`), type: 'UNAVAILABLE', note: 'exam' },
      { userId: nadia.id, date: new Date(`${addDays(monday, 4)}T00:00:00.000Z`), type: 'PREFERRED_OFF' },
    ],
  });
  expect(await prisma.shift.count({ where: { userId: nadia.id } })).toBe(0);

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

  await expect(page.getByLabel('Marked unavailable this day — exam')).toHaveCount(1);
  await expect(page.getByLabel('Marked preferred day off')).toHaveCount(1);
  await shot(page, 'f2-availability-no-shift');

  // Another week has none of these marks.
  await page.goto(`/scheduling?week=${addDays(monday, 7)}`);
  await page.waitForSelector('text=Weekly rota builder');
  await expect(page.getByLabel(/^Marked /)).toHaveCount(0);
});
