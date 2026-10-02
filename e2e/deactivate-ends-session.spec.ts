import { test, expect, type Page } from '@playwright/test';
import { cleanupTestOrgs, nextEchoPhone, prisma, skipOtpResendWait, testVenueName } from './helpers';

/**
 * Deactivation ends a session immediately (#20): a staff member signed in on
 * their own device is deactivated by a manager in the real Staff Directory,
 * and their very next request is refused — no 30-day grace on the old token.
 * Two browser contexts, real server and DB, nothing intercepted.
 */
const atPath = (pathname: string) => (url: URL) => url.pathname === pathname;
const usedPhones: string[] = [];

/** Same one-retry cold-Vite guard as helpers.ts `signupNewVenue`. */
async function open(page: Page, path: string): Promise<void> {
  try {
    await page.goto(path);
  } catch {
    await page.goto(path);
  }
}

/** /login phone step → code step → submit. */
async function logIn(page: Page, phone: string): Promise<void> {
  await page.getByPlaceholder('Phone number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  const code = (await page.locator('p.hint .font-mono').innerText()).trim();
  await page.getByPlaceholder('6-digit code').fill(code);
  await page.getByRole('button', { name: 'Verify & log in' }).click();
}

test.describe('deactivation ends the session', () => {
  test.afterEach(async ({ page }) => {
    await page.close().catch(() => {});
    await cleanupTestOrgs();
    await prisma.otpCode.deleteMany({ where: { phone: { in: usedPhones.splice(0) } } });
  });

  test("manager deactivates a signed-in staff member → the staff member's next request is refused and they're signed out", async ({ page, browser }) => {
    const org = await prisma.organization.create({ data: { name: testVenueName('deactivate-session') } });
    const location = await prisma.location.create({
      data: { organizationId: org.id, name: 'Deactivation Venue', emirate: 'Dubai', venueType: 'Fine Dining' },
    });
    const managerPhone = nextEchoPhone();
    const staffPhone = nextEchoPhone();
    usedPhones.push(managerPhone, staffPhone);
    await prisma.user.create({ data: { locationId: location.id, fullName: 'Deactivating Manager', systemRole: 'MANAGER', phone: managerPhone } });
    const staff = await prisma.user.create({ data: { locationId: location.id, fullName: 'Leaving Staff', systemRole: 'STAFF', phone: staffPhone } });

    const staffContext = await browser.newContext();
    try {
      // --- Staff signs in on their own device and sees their home.
      const staffPage = await staffContext.newPage();
      await open(staffPage, '/login');
      await logIn(staffPage, staffPhone);
      await staffPage.waitForURL(atPath('/my-shifts'));
      await expect(staffPage.getByRole('heading', { name: 'Welcome back, Leaving Staff' })).toBeVisible();
      expect(await prisma.session.count({ where: { userId: staff.id } })).toBe(1);

      // --- Manager, elsewhere, deactivates them in People → Staff Directory.
      await open(page, '/login');
      await logIn(page, managerPhone);
      await page.waitForURL(atPath('/'));
      await page.goto('/people');
      const toggle = page.getByRole('button', { name: /Staff Directory/ });
      if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
      const row = page.getByRole('row').filter({ hasText: 'Leaving Staff' });
      const patched = page.waitForResponse((r) => r.url().includes(`/api/staff-directory/${staff.id}`) && r.request().method() === 'PATCH');
      await row.getByRole('button', { name: 'Active', exact: true }).click();
      expect((await patched).status()).toBe(200);
      await expect(row.getByRole('button', { name: 'Inactive', exact: true })).toBeVisible();
      expect(await prisma.session.count({ where: { userId: staff.id } })).toBe(0);

      // --- Staff's next request: refused, and the app drops to the signed-out state.
      const refused = staffPage.waitForResponse((r) => r.url().endsWith('/api/my-shifts'));
      await staffPage.reload();
      expect((await refused).status()).toBe(401);
      await expect(staffPage.getByText("You're not signed in.", { exact: false })).toBeVisible();
      await expect(staffPage.getByRole('heading', { name: /Welcome back/ })).toHaveCount(0);
      await expect(staffPage.getByText('Your next shifts')).toHaveCount(0);
      expect(await staffPage.evaluate(() => localStorage.getItem('shiftsync.session'))).toBeNull();

      // --- And signing back in is refused with the deactivated message.
      await skipOtpResendWait(staffPhone);
      await open(staffPage, '/login');
      await logIn(staffPage, staffPhone);
      await expect(staffPage.locator('.error-block')).toContainText('has been deactivated');
      expect(await staffPage.evaluate(() => localStorage.getItem('shiftsync.session'))).toBeNull();
    } finally {
      await staffContext.close();
    }
  });
});
