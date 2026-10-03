import { test, expect, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { prisma, cleanupTestOrgs, nextEchoPhone, testVenueName } from './helpers';

/**
 * One-time login links next to phone codes (the default): a manager signs in
 * by phone code, sends an active staff member a link from the Staff
 * Directory, and the staff member uses it in a separate browser context.
 * Real server and DB, nothing intercepted.
 */
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const atPath = (pathname: string) => (url: URL) => url.pathname === pathname;
const usedPhones: string[] = [];

async function venueWithManager() {
  const org = await prisma.organization.create({ data: { name: testVenueName('login-links') } });
  const location = await prisma.location.create({
    data: { organizationId: org.id, name: 'Link Test Venue', emirate: 'Dubai', venueType: 'Fine Dining' },
  });
  const phone = nextEchoPhone();
  usedPhones.push(phone);
  const manager = await prisma.user.create({ data: { locationId: location.id, fullName: 'Link Manager', systemRole: 'MANAGER', phone } });
  const staff = await prisma.user.create({ data: { locationId: location.id, fullName: 'Link Staff', systemRole: 'STAFF' } });
  return { location, manager, staff, phone };
}

/** Mints a link the way the CLI does: only the hash is stored, the token goes in the fragment. */
async function mintLink(userId: string, locationId: string, expiresAt: Date) {
  const token = randomBytes(32).toString('base64url');
  const row = await prisma.loginLink.create({ data: { tokenHash: sha256(token), userId, locationId, expiresAt } });
  return { token, id: row.id };
}

/** Same one-retry cold-Vite guard as helpers.ts `signupNewVenue`. */
async function open(page: Page, path: string): Promise<void> {
  try {
    await page.goto(path);
  } catch {
    await page.goto(path);
  }
}

test.describe('login links', () => {
  test.afterEach(async ({ page }) => {
    await page.close().catch(() => {});
    await cleanupTestOrgs();
    await prisma.otpCode.deleteMany({ where: { phone: { in: usedPhones.splice(0) } } });
  });

  test('manager (phone code) sends a link from the Staff Directory → staff opens it elsewhere → Sign in → /my-shifts; a second open is refused', async ({ page, browser }) => {
    const { manager, staff, phone } = await venueWithManager();
    const gone = await prisma.user.create({ data: { locationId: staff.locationId, fullName: 'Gone Staff', systemRole: 'STAFF', isActive: false } });

    // --- Manager signs in with a phone code: still on by default, beside the paste box.
    await open(page, '/login');
    await expect(page.getByTestId('paste-login-link')).toBeVisible();
    await page.getByPlaceholder('Phone number').fill(phone);
    await page.getByRole('button', { name: 'Send code' }).click();
    const code = (await page.locator('p.hint .font-mono').innerText()).trim();
    await page.getByPlaceholder('6-digit code').fill(code);
    await page.getByRole('button', { name: 'Verify & log in' }).click();
    await page.waitForURL(atPath('/'));

    // --- People → Staff Directory → Send login link (active staff only).
    await page.goto('/people');
    const toggle = page.getByRole('button', { name: /Staff Directory/ });
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    await expect(page.getByRole('row').filter({ hasText: 'Gone Staff' }).getByRole('button', { name: 'Send login link' })).toHaveCount(0);
    const row = page.getByRole('row').filter({ hasText: 'Link Staff' });
    await row.getByRole('button', { name: 'Send login link' }).click();
    const url = (await row.getByTestId('login-link-url').innerText()).trim();
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/login/link');
    expect(parsed.hash).toMatch(/^#[A-Za-z0-9_-]{43}$/);
    // Path + fragment against Playwright's baseURL, whatever FRONTEND_ORIGIN the dev .env sets.
    const linkPath = `${parsed.pathname}${parsed.hash}`;
    const staffLink = await prisma.loginLink.findFirstOrThrow({ where: { userId: staff.id }, orderBy: { createdAt: 'desc' } });
    expect(staffLink.issuedById).toBe(manager.id);
    expect(staffLink.tokenHash).toBe(sha256(parsed.hash.slice(1)));
    expect(await prisma.loginLink.count({ where: { userId: gone.id } })).toBe(0);

    // --- Staff member, in a separate browser context (own storage, no session).
    const staffContext = await browser.newContext();
    try {
      const staffPage = await staffContext.newPage();
      await open(staffPage, linkPath);
      await expect(staffPage.getByRole('heading', { name: 'Sign in as Link Staff — Link Test Venue' })).toBeVisible();
      // Opening the page spends nothing, and the token is scrubbed from the address bar.
      expect((await prisma.loginLink.findUniqueOrThrow({ where: { id: staffLink.id } })).consumedAt).toBeNull();
      expect(new URL(staffPage.url()).hash).toBe('');

      await staffPage.getByTestId('login-link-sign-in').click();
      await staffPage.waitForURL(atPath('/my-shifts'));
      const spent = await prisma.loginLink.findUniqueOrThrow({ where: { id: staffLink.id } });
      expect(spent.consumedAt).not.toBeNull();
      expect(spent.redeemedIp).toBeTruthy();
      const stored = await staffPage.evaluate(() => localStorage.getItem('shiftsync.session'));
      expect(JSON.parse(stored ?? 'null')?.user.id).toBe(staff.id);
    } finally {
      await staffContext.close();
    }

    // --- One-time use: the same link opened again anywhere is refused before any tap.
    const secondContext = await browser.newContext();
    try {
      const again = await secondContext.newPage();
      await open(again, linkPath);
      await expect(again.getByRole('alert')).toContainText('already been used');
      await expect(again.getByTestId('login-link-sign-in')).toHaveCount(0);
    } finally {
      await secondContext.close();
    }
  });

  test('a link pasted on /login opens the same Sign in page; an expired link is refused', async ({ page }) => {
    const { location, staff } = await venueWithManager();
    const hour = 60 * 60 * 1000;

    const valid = await mintLink(staff.id, location.id, new Date(Date.now() + hour));
    await open(page, '/login');
    await page.getByLabel('Have a login link? Paste it here').fill(`http://localhost:5173/login/link#${valid.token}`);
    await page.getByRole('button', { name: 'Open login link' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in as Link Staff — Link Test Venue' })).toBeVisible();
    await page.getByTestId('login-link-sign-in').click();
    await page.waitForURL(atPath('/my-shifts'));
    await page.evaluate(() => localStorage.removeItem('shiftsync.session'));

    const expired = await mintLink(staff.id, location.id, new Date(Date.now() + hour));
    await prisma.loginLink.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await open(page, `/login/link#${expired.token}`);
    await expect(page.getByRole('alert')).toContainText('expired');
    await expect(page.getByTestId('login-link-sign-in')).toHaveCount(0);
    expect((await prisma.loginLink.findUniqueOrThrow({ where: { id: expired.id } })).consumedAt).toBeNull();
  });
});
