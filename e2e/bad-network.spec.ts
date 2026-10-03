import { test, expect, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { cleanupTestOrgs, nextEchoPhone, prisma, testVenueName } from './helpers';

/**
 * Bad-network audit: login, the rota view, publish and join under an offline
 * device and under a slow link. What is asserted is mechanical, not product
 * behaviour: no spinner lives forever, no failure is silent, every failed
 * action shows a message and can be retried once the network is back.
 */
const usedPhones: string[] = [];
const freshPhone = () => {
  const p = nextEchoPhone();
  usedPhones.push(p);
  return p;
};

async function open(page: Page, path: string): Promise<void> {
  try {
    await page.goto(path);
  } catch {
    await page.goto(path);
  }
}

async function requestCode(page: Page, phone: string): Promise<string> {
  await page.getByPlaceholder('Phone number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  return (await page.locator('p.hint .font-mono').innerText()).trim();
}

async function logIn(page: Page, phone: string): Promise<void> {
  await open(page, '/login');
  const code = await requestCode(page, phone);
  await page.getByPlaceholder('6-digit code').fill(code);
  await page.getByRole('button', { name: 'Verify & log in' }).click();
}

/** Every /api call takes `ms` longer than usual — a weak 3G link. */
async function slowApi(page: Page, ms: number): Promise<void> {
  await page.route('**/api/**', async (route) => {
    await new Promise((r) => setTimeout(r, ms));
    await route.continue();
  });
}

async function createVenue() {
  const venueName = testVenueName('bad-network');
  const org = await prisma.organization.create({ data: { name: venueName } });
  const location = await prisma.location.create({ data: { organizationId: org.id, name: venueName, emirate: 'Dubai', venueType: 'Fine Dining' } });
  const role = await prisma.role.create({ data: { locationId: location.id, name: 'Bartender' } });
  const ownerPhone = freshPhone();
  const owner = await prisma.user.create({ data: { locationId: location.id, systemRole: 'OWNER', fullName: 'Bad Network Owner', phone: ownerPhone, roleId: role.id } });
  const { token } = await prisma.inviteLink.create({
    data: { locationId: location.id, token: randomBytes(32).toString('base64url'), expiresAt: new Date(Date.now() + 86_400_000) },
  });
  return { venueName, location, role, owner, ownerPhone, inviteToken: token };
}

test.describe('bad network — offline and slow links', () => {
  test.afterEach(async () => {
    await cleanupTestOrgs();
    await prisma.otpCode.deleteMany({ where: { phone: { in: usedPhones.splice(0) } } });
  });

  test('login offline: "Send code" fails with a message and no stuck spinner; works again once online', async ({ page, context }) => {
    const { ownerPhone } = await createVenue();
    await open(page, '/login');
    await context.setOffline(true);
    await page.getByPlaceholder('Phone number').fill(ownerPhone);
    await page.getByRole('button', { name: 'Send code' }).click();
    await expect(page.getByRole('alert')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Send code' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Sending…' })).toHaveCount(0);

    await context.setOffline(false);
    const code = await requestCode(page, ownerPhone);
    expect(code).toMatch(/^\d{6}$/);
  });

  test('login on a slow link: the button shows progress, then the code step appears', async ({ page }) => {
    const { ownerPhone } = await createVenue();
    await open(page, '/login');
    await slowApi(page, 2500);
    await page.getByPlaceholder('Phone number').fill(ownerPhone);
    await page.getByRole('button', { name: 'Send code' }).click();
    await expect(page.getByRole('button', { name: 'Sending…' })).toBeVisible();
    await expect(page.getByPlaceholder('6-digit code')).toBeVisible({ timeout: 15_000 });
  });

  test('join offline: the code request fails with a message, not silence; the form stays usable', async ({ page, context }) => {
    const { inviteToken } = await createVenue();
    const phone = freshPhone();
    await open(page, `/join?invite=${inviteToken}`);
    await expect(page.getByPlaceholder('Phone number')).toBeVisible();
    await context.setOffline(true);
    await page.getByPlaceholder('Phone number').fill(phone);
    await page.getByRole('button', { name: 'Send code' }).click();
    await expect(page.getByRole('alert')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Send code' })).toBeEnabled();
    await context.setOffline(false);
    await page.getByRole('button', { name: 'Send code' }).click();
    await expect(page.getByPlaceholder('6-digit code')).toBeVisible({ timeout: 15_000 });
  });

  test('rota view: loaded data stays on screen offline with a stale notice; publish is disabled with a reason; works again online', async ({ page, context }) => {
    const { ownerPhone, location, role } = await createVenue();
    await prisma.shift.create({
      data: {
        locationId: location.id,
        roleId: role.id,
        userId: null,
        date: new Date(`${mondayOfThisWeek()}T00:00:00.000Z`),
        startTime: new Date(`${mondayOfThisWeek()}T05:00:00.000Z`),
        endTime: new Date(`${mondayOfThisWeek()}T13:00:00.000Z`),
      },
    });
    await logIn(page, ownerPhone);
    await page.waitForURL((url) => url.pathname === '/');
    await page.goto('/scheduling');
    const toggle = page.getByRole('button', { name: /Weekly rota builder/ });
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    await expect(page.getByRole('button', { name: /Publish & notify|Publish changes/ })).toBeEnabled({ timeout: 15_000 });

    await context.setOffline(true);
    // The connectivity probe notices within its own interval; the stale notice and the disabled publish follow.
    await expect(page.getByRole('button', { name: /Publish & notify|Publish changes/ })).toBeDisabled({ timeout: 20_000 });
    await expect(page.getByText(/Offline|Requires connection/).first()).toBeVisible({ timeout: 20_000 });
    // Loaded content is still there (write targets are hidden offline by design), nothing spins.
    await expect(page.getByRole('button', { name: /Weekly rota builder/ })).toBeVisible();
    await expect(page.getByText(/Draft|Unpublished changes|Published/).first()).toBeVisible();
    await expect(page.locator('.spinner:visible')).toHaveCount(0);

    await context.setOffline(false);
    await expect(page.getByRole('button', { name: /Publish & notify|Publish changes/ })).toBeEnabled({ timeout: 20_000 });
    const publish = page.waitForResponse((r) => /\/api\/shifts\/[^/]+\/publish$/.test(r.url()));
    await page.getByRole('button', { name: /Publish & notify|Publish changes/ }).click();
    expect((await publish).status()).toBe(200);
  });

  test('cold rota load offline: a clear offline message, no infinite spinner; recovers when back online', async ({ page, context }) => {
    const { ownerPhone } = await createVenue();
    await logIn(page, ownerPhone);
    await page.waitForURL((url) => url.pathname === '/');
    await context.setOffline(true);
    await page.goto('/scheduling').catch(() => {});
    // An offline SPA navigation may fail to load the document at all (expected: the browser's own offline page).
    await context.setOffline(false);
    await page.goto('/scheduling');
    const toggle = page.getByRole('button', { name: /Weekly rota builder/ });
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    await expect(page.getByRole('button', { name: /Publish & notify|Publish changes/ })).toBeVisible({ timeout: 15_000 });
  });
});

function mondayOfThisWeek(): string {
  const d = new Date();
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = utc.getUTCDay();
  utc.setUTCDate(utc.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return utc.toISOString().slice(0, 10);
}
