import { test, expect, type Page } from '@playwright/test';
import { cleanupTestOrgs, nextEchoPhone, prisma, testVenueName } from './helpers';

/**
 * /login — one phone + OTP screen for every role, routed by role afterwards
 * (OWNER/MANAGER → /, STAFF → /my-shifts, a safe ?returnTo= wins).
 *
 * Real backend + real DB, no request interception. Users are created
 * directly with fresh allowlisted phones, so no earlier signup code trips the
 * per-phone 30s resend cap.
 */

type Role = 'OWNER' | 'MANAGER' | 'STAFF';
const usedPhones: string[] = [];

async function createUser(systemRole: Role): Promise<string> {
  const phone = nextEchoPhone();
  usedPhones.push(phone);
  const org = await prisma.organization.create({ data: { name: testVenueName(`login-${systemRole}`) } });
  const location = await prisma.location.create({ data: { organizationId: org.id, name: org.name } });
  await prisma.user.create({ data: { locationId: location.id, systemRole, fullName: `E2E Login ${systemRole}`, phone } });
  return phone;
}

/** Same one-retry cold-Vite guard as helpers.ts `signupNewVenue`. */
async function open(page: Page, path: string): Promise<void> {
  try {
    await page.goto(path);
  } catch {
    await page.goto(path);
  }
}

/** Phone step → code step; returns the echoed dev code. */
async function requestCode(page: Page, phone: string): Promise<string> {
  await page.getByPlaceholder('Phone number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  return (await page.locator('p.hint .font-mono').innerText()).trim();
}

async function logIn(page: Page, phone: string): Promise<void> {
  const code = await requestCode(page, phone);
  await page.getByPlaceholder('6-digit code').fill(code);
  await page.getByRole('button', { name: 'Verify & log in' }).click();
}

async function storedSession(page: Page): Promise<{ user: { systemRole: string } } | null> {
  return JSON.parse((await page.evaluate(() => localStorage.getItem('shiftsync.session'))) ?? 'null');
}

const atPath = (pathname: string) => (url: URL) => url.pathname === pathname;

test.describe('/login — phone + OTP for every role, routed by role', () => {
  test.afterEach(async ({ page }) => {
    await page.close().catch(() => {});
    await cleanupTestOrgs();
    await prisma.otpCode.deleteMany({ where: { phone: { in: usedPhones.splice(0) } } });
  });

  for (const role of ['OWNER', 'MANAGER'] as const) {
    test(`${role} lands on / with a stored session; reopening /login goes straight back to /`, async ({ page }) => {
      const phone = await createUser(role);
      await open(page, '/login');
      await logIn(page, phone);
      await page.waitForURL(atPath('/'));
      expect((await storedSession(page))?.user.systemRole).toBe(role);

      await page.goto('/login');
      await page.waitForURL(atPath('/'));
    });
  }

  test('STAFF lands on /my-shifts', async ({ page }) => {
    const phone = await createUser('STAFF');
    await open(page, '/login');
    await logIn(page, phone);
    await page.waitForURL(atPath('/my-shifts'));
    expect((await storedSession(page))?.user.systemRole).toBe('STAFF');
  });

  test('STAFF with a returnTo to a manager-only page still ends on /my-shifts', async ({ page }) => {
    const phone = await createUser('STAFF');
    await open(page, '/login?returnTo=%2Fschedule');
    await logIn(page, phone);
    await page.waitForURL(atPath('/my-shifts'));
  });

  test('wrong code shows "Incorrect code.", stays on /login, stores no session', async ({ page }) => {
    const phone = await createUser('STAFF');
    await open(page, '/login');
    const code = await requestCode(page, phone);
    // Never 000000: that is ALLOW_DEV_OTP_BYPASS's fixed code.
    await page.getByPlaceholder('6-digit code').fill(code === '111111' ? '222222' : '111111');
    await page.getByRole('button', { name: 'Verify & log in' }).click();
    await expect(page.locator('.error-block')).toContainText('Incorrect code.');
    expect(new URL(page.url()).pathname).toBe('/login');
    expect(await storedSession(page)).toBeNull();
  });

  test('a second code for the same number within 30s is refused with a 429 and its message', async ({ page }) => {
    const phone = await createUser('STAFF');
    await open(page, '/login');
    await requestCode(page, phone);
    const response = page.waitForResponse((r) => r.url().endsWith('/api/identity/request-otp') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Send a new code' }).click();
    expect((await response).status()).toBe(429);
    await expect(page.locator('.error-block')).toContainText('Too many code requests for this number');
  });

  test('an unknown number explains how to join or set up a venue', async ({ page }) => {
    const phone = nextEchoPhone();
    usedPhones.push(phone);
    await open(page, '/login');
    await page.getByPlaceholder('Phone number').fill(phone);
    await page.getByRole('button', { name: 'Send code' }).click();
    const error = page.locator('.error-block');
    await expect(error).toContainText('No account with that number.');
    await expect(error).toContainText("Use your venue's invite link.");
    await expect(error.getByRole('link', { name: 'Set up your venue' })).toHaveAttribute('href', '/onboarding');
  });

  test('a signed-out visit to a gated page redirects to /login carrying returnTo', async ({ page }) => {
    await open(page, '/scheduling?week=2026-01-05');
    await page.waitForURL(atPath('/login'));
    expect(new URL(page.url()).searchParams.get('returnTo')).toBe('/scheduling?week=2026-01-05');
  });

  test('old /join?mode=login URL redirects to /login with returnTo, and login honours it', async ({ page }) => {
    const phone = await createUser('OWNER');
    await open(page, '/join?mode=login&returnTo=%2Fpeople');
    await page.waitForURL(atPath('/login'));
    expect(new URL(page.url()).searchParams.get('returnTo')).toBe('/people');
    await logIn(page, phone);
    await page.waitForURL(atPath('/people'));
  });

  test('an off-origin returnTo is ignored: login stays on this origin at the role destination', async ({ page, baseURL }) => {
    await open(page, '/join?mode=login&returnTo=https%3A%2F%2Fevil.example');
    await page.waitForURL(atPath('/login'));
    expect(new URL(page.url()).search).toBe('');

    const phone = await createUser('MANAGER');
    await open(page, '/login?returnTo=https%3A%2F%2Fevil.example');
    await logIn(page, phone);
    await page.waitForURL(atPath('/'));
    expect(new URL(page.url()).origin).toBe(new URL(baseURL!).origin);
  });
});
