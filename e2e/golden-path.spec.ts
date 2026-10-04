import { test, expect, type Browser, type Page } from '@playwright/test';
import { cleanupTestOrgs, continueThroughVenue, nextEchoPhone, prisma, signupNewVenue, skipOtpResendWait, testVenueName } from './helpers';

/**
 * The golden path, through the real UI: an owner sets up a venue in
 * onboarding and copies its join link from People; a hire whose number the
 * owner put in the Staff Directory is claimed straight in, another waits for
 * approval and gets in once approved; then staff and owner come back via
 * /login and land on their own Home.
 *
 * Real backend + real DB, no request interception. Prisma only reads state
 * for assertions, ages OTP codes past the 30s resend window, and tears down.
 */

const OWNER_NAME = 'E2E Test Owner'; // what signupNewVenue types in
const CLAIMED_NAME = 'E2E Golden Rania';
const APPLICANT_NAME = 'E2E Golden Omar';
const usedPhones: string[] = [];

function freshPhone(): string {
  const phone = nextEchoPhone();
  usedPhones.push(phone);
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

async function newPage(browser: Browser): Promise<Page> {
  return (await browser.newContext()).newPage();
}

/** Phone step → code step on /login or /join; returns the echoed dev code. */
async function requestCode(page: Page, phone: string): Promise<string> {
  await page.getByPlaceholder('Phone number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  return (await page.locator('p.hint .font-mono').innerText()).trim();
}

/** Signs in on /login with a fresh code (any earlier code for this phone is aged out of the resend window first). */
async function logIn(page: Page, phone: string): Promise<void> {
  await skipOtpResendWait(phone);
  await open(page, '/login');
  const code = await requestCode(page, phone);
  await page.getByPlaceholder('6-digit code').fill(code);
  await page.getByRole('button', { name: 'Verify & log in' }).click();
}

async function storedSession(page: Page): Promise<{ user: { systemRole: string; fullName: string } } | null> {
  return JSON.parse((await page.evaluate(() => localStorage.getItem('shiftsync.session'))) ?? 'null');
}

const atPath = (pathname: string) => (url: URL) => url.pathname === pathname;
const inviteTokenIn = (text: string) => /\/join\?invite=([A-Za-z0-9_-]{43})$/.exec(text.trim())?.[1];

test.describe('golden path — venue → join link → claim / approve → staff home; returning staff and owner', () => {
  test.afterEach(async ({ browser }) => {
    for (const context of browser.contexts()) await context.close().catch(() => {});
    await cleanupTestOrgs();
    await prisma.otpCode.deleteMany({ where: { phone: { in: usedPhones.splice(0) } } });
  });

  test('owner sets up and invites; one hire claimed by phone, one approved; both and the owner return via /login', async ({ page, context, browser }) => {
    test.setTimeout(180_000);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const manager = page;
    const venueName = testVenueName('golden-path');
    let ownerPhone = '';
    let joinPath = '';
    const claimedPhone = freshPhone();
    const applicantPhone = freshPhone();

    await test.step('owner sets up the venue in onboarding and copies its join link from People', async () => {
      ({ phone: ownerPhone } = await signupNewVenue(manager, venueName));
      usedPhones.push(ownerPhone);
      await continueThroughVenue(manager);
      await manager.getByRole('button', { name: /Skip for now/ }).click();
      await manager.waitForURL('**/onboarding/invite**');
      await manager.waitForSelector('text=Venue join-link', { timeout: 15_000 });
      const onboardingLink = await manager.locator('.ob-serif').filter({ hasText: '/join?invite=' }).first().innerText();
      const onboardingToken = inviteTokenIn(onboardingLink);
      expect(onboardingToken).toBeTruthy();

      await manager.getByRole('button', { name: 'Finish setup' }).click();
      await manager.waitForURL(atPath('/'), { timeout: 15_000 });

      await manager.goto('/people');
      const panel = manager.locator('section').filter({ has: manager.getByRole('heading', { name: 'Join link', exact: true }) });
      await panel.getByRole('button', { name: 'Copy link' }).click();
      await expect(panel.getByRole('button', { name: 'Copied' })).toBeVisible();
      const copied = await manager.evaluate(() => navigator.clipboard.readText());
      expect(copied).toBe(await panel.getByRole('textbox', { name: 'Join link' }).inputValue());
      // The link onboarding showed is the one People manages.
      expect(inviteTokenIn(copied)).toBe(onboardingToken);
      // Opened against Playwright's baseURL, whatever origin the dev server mints links for.
      const url = new URL(copied);
      joinPath = `${url.pathname}${url.search}`;
    });

    await test.step('claim: the owner adds a hire with their phone; the hire joins by link and is matched straight in', async () => {
      const toggle = manager.getByRole('button', { name: /Staff Directory/ });
      if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
      await manager.getByPlaceholder('Full name').fill(CLAIMED_NAME);
      await manager.getByPlaceholder(/Job title/).fill('Bartender');
      await manager.getByRole('button', { name: 'Add staff member' }).click();
      const row = manager.getByRole('row').filter({ hasText: CLAIMED_NAME });
      await expect(row).toBeVisible();
      const phoneInput = row.locator('input').nth(1);
      await phoneInput.fill(claimedPhone);
      await phoneInput.blur();
      await expect
        .poll(async () => (await prisma.user.findUnique({ where: { phone: claimedPhone } }))?.fullName, { timeout: 10_000 })
        .toBe(CLAIMED_NAME);

      const staff = await newPage(browser);
      await open(staff, joinPath);
      await expect(staff.getByRole('heading', { name: `Join ${venueName} as staff` })).toBeVisible();
      const code = await requestCode(staff, claimedPhone);
      await staff.getByPlaceholder('6-digit code').fill(code);
      await staff.getByRole('button', { name: 'Verify & continue' }).click();
      await staff.waitForURL(atPath('/my-shifts'));
      await expect(staff.getByText(`Welcome back, ${CLAIMED_NAME}`)).toBeVisible();
      expect((await storedSession(staff))?.user.systemRole).toBe('STAFF');
      expect(await prisma.joinRequest.count({ where: { phone: claimedPhone } })).toBe(0);
    });

    await test.step('pending: an unknown number joins by link, waits on the owner, is approved, and signs in to staff Home', async () => {
      const applicant = await newPage(browser);
      await open(applicant, joinPath);
      const code = await requestCode(applicant, applicantPhone);
      await applicant.getByPlaceholder('6-digit code').fill(code);
      await applicant.getByPlaceholder('Full name (if this is your first time)').fill(APPLICANT_NAME);
      await applicant.getByRole('button', { name: 'Verify & continue' }).click();
      await expect(applicant.getByText(`Waiting for ${OWNER_NAME} to approve you at ${venueName}.`)).toBeVisible();
      expect(await storedSession(applicant)).toBeNull();
      expect(await prisma.joinRequest.count({ where: { phone: applicantPhone, status: 'PENDING' } })).toBe(1);

      // People was loaded before the request was filed: reopen it to see the request.
      await manager.goto('/people');
      const toggle = manager.getByRole('button', { name: /Pending Approvals/ });
      await toggle.click();
      const request = manager.locator('section').filter({ has: toggle }).getByRole('listitem').filter({ hasText: APPLICANT_NAME });
      await request.getByRole('button', { name: 'Approve' }).click();
      await expect(request).toHaveCount(0);
      const approved = await prisma.user.findUniqueOrThrow({ where: { phone: applicantPhone } });
      expect(approved.systemRole).toBe('STAFF');

      await logIn(applicant, applicantPhone);
      await applicant.waitForURL(atPath('/my-shifts'));
      await expect(applicant.getByText(`Welcome back, ${APPLICANT_NAME}`)).toBeVisible();
      await expect.poll(() => prisma.notification.count({ where: { userId: approved.id, title: "You're in" } })).toBe(1);
      await applicant.getByRole('button', { name: /^(\d+ unread )?notifications$/i }).click();
      await expect(applicant.getByText(`${venueName} approved your request — welcome!`)).toBeVisible();
    });

    await test.step('returning staff: a fresh browser signs in on /login and lands on /my-shifts', async () => {
      const returning = await newPage(browser);
      await logIn(returning, claimedPhone);
      await returning.waitForURL(atPath('/my-shifts'));
      await expect(returning.getByText(`Welcome back, ${CLAIMED_NAME}`)).toBeVisible();
      expect((await storedSession(returning))?.user.systemRole).toBe('STAFF');
    });

    await test.step('returning owner: a fresh browser signs in on /login and lands on manager Home, not /my-shifts', async () => {
      const returning = await newPage(browser);
      await logIn(returning, ownerPhone);
      await returning.waitForURL(atPath('/'));
      await expect(returning.getByRole('banner').getByText(venueName, { exact: true })).toBeVisible();
      expect(new URL(returning.url()).pathname).toBe('/');
      expect((await storedSession(returning))?.user).toMatchObject({ systemRole: 'OWNER', fullName: OWNER_NAME });
    });
  });
});
