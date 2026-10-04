import { test, expect, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { cleanupTestOrgs, nextEchoPhone, prisma, skipOtpResendWait, testVenueName } from './helpers';

/**
 * The staff-specific look on the existing join + login flow, end to end with
 * two browser contexts: the applicant joins through the venue's invite link
 * (staff wording, no manager wording, no setup steps), the owner approves on
 * /people in another context, the applicant signs in through "Staff sign in",
 * sees the one-time "You're in" screen and lands on My Shifts. The applicant
 * never sees manager onboarding.
 */
const OWNER_NAME = 'Staff Flow Owner';
const APPLICANT_NAME = 'Noor Applicant';
const usedPhones: string[] = [];

function freshPhone(): string {
  const phone = nextEchoPhone();
  usedPhones.push(phone);
  return phone;
}

async function createVenue() {
  const venueName = testVenueName('staff-flow');
  const org = await prisma.organization.create({ data: { name: venueName } });
  const location = await prisma.location.create({ data: { organizationId: org.id, name: venueName, emirate: 'Dubai', venueType: 'Fine Dining' } });
  const ownerPhone = freshPhone();
  await prisma.user.create({ data: { locationId: location.id, systemRole: 'OWNER', fullName: OWNER_NAME, phone: ownerPhone } });
  const { token } = await prisma.inviteLink.create({
    data: { locationId: location.id, token: randomBytes(32).toString('base64url'), expiresAt: new Date(Date.now() + 86_400_000) },
  });
  return { inviteToken: token, venueName, ownerPhone, locationId: location.id };
}

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

const MANAGER_WORDING = /Sign up your restaurant|Set up your venue|Setting up a (brand-)?new venue|onboarding|Continue to Dashboard/i;

test.describe('staff flow — join as staff, approval, staff sign in, "You\'re in", My Shifts', () => {
  test.afterEach(async () => {
    await cleanupTestOrgs();
    await prisma.otpCode.deleteMany({ where: { phone: { in: usedPhones.splice(0) } } });
  });

  test('two contexts: staff joins and waits → owner approves → staff signs in → You\'re in → My Shifts, never seeing manager onboarding', async ({ browser }) => {
    const { inviteToken, venueName, ownerPhone } = await createVenue();
    const staffPhone = freshPhone();
    const staffContext = await browser.newContext();
    const ownerContext = await browser.newContext();
    const staffPage = await staffContext.newPage();
    const visited: string[] = [];
    staffPage.on('framenavigated', (f) => {
      if (f === staffPage.mainFrame()) visited.push(new URL(f.url()).pathname);
    });

    try {
      // --- Staff join screen: the venue, "as staff", a phone field, a short welcome, nothing for managers.
      await open(staffPage, `/join?invite=${inviteToken}`);
      await expect(staffPage.getByRole('heading', { name: `Join ${venueName} as staff` })).toBeVisible();
      await expect(staffPage.getByText(`Welcome to the ${venueName} team`)).toBeVisible();
      await expect(staffPage.getByPlaceholder('Phone number')).toBeVisible();
      await expect(staffPage.locator('main')).not.toContainText(MANAGER_WORDING);
      await expect(staffPage.getByRole('link', { name: /Staff sign in/ })).toHaveAttribute('href', '/login?as=staff');

      const code = await requestCode(staffPage, staffPhone);
      await staffPage.getByPlaceholder('6-digit code').fill(code);
      await staffPage.getByPlaceholder('Full name (if this is your first time)').fill(APPLICANT_NAME);
      await staffPage.getByRole('button', { name: 'Verify & continue' }).click();
      await expect(staffPage.getByText(`Waiting for ${OWNER_NAME} to approve you at ${venueName}.`)).toBeVisible();
      await expect(staffPage.getByRole('link', { name: 'Staff sign in' })).toBeVisible();
      await expect(staffPage.locator('main')).not.toContainText(MANAGER_WORDING);

      // --- Owner, in another context, approves on /people.
      const ownerPage = await ownerContext.newPage();
      await open(ownerPage, '/login');
      const ownerCode = await requestCode(ownerPage, ownerPhone);
      await ownerPage.getByPlaceholder('6-digit code').fill(ownerCode);
      await ownerPage.getByRole('button', { name: 'Verify & log in' }).click();
      await ownerPage.waitForURL((url) => url.pathname === '/');
      await ownerPage.goto('/people');
      const toggle = ownerPage.getByRole('button', { name: /Pending Approvals/ });
      await toggle.click();
      const panel = ownerPage.locator('section').filter({ has: toggle });
      const row = panel.getByRole('listitem').filter({ hasText: APPLICANT_NAME });
      await row.getByRole('button', { name: 'Approve' }).click();
      await expect(row).toHaveCount(0);

      // --- Staff sign in: the staff variant of /login, same codes.
      await skipOtpResendWait(staffPhone);
      await staffPage.getByRole('link', { name: 'Staff sign in' }).click();
      await staffPage.waitForURL((url) => url.pathname === '/login' && url.searchParams.get('as') === 'staff');
      await expect(staffPage.getByRole('heading', { name: 'Staff sign in' })).toBeVisible();
      await expect(staffPage.getByText('Enter the mobile number your manager has for you')).toBeVisible();
      await expect(staffPage.locator('main')).not.toContainText(MANAGER_WORDING);
      const signInCode = await requestCode(staffPage, staffPhone);
      await staffPage.getByPlaceholder('6-digit code').fill(signInCode);
      await staffPage.getByRole('button', { name: 'Verify & log in' }).click();

      // --- "You're in", then straight to My Shifts.
      await staffPage.waitForURL((url) => url.pathname === '/welcome');
      const welcome = staffPage.getByTestId('staff-welcome');
      await expect(welcome.getByRole('heading', { name: "You're in" })).toBeVisible();
      await expect(welcome).toContainText(`Welcome to ${venueName}, Noor`);
      await expect(welcome).not.toContainText(MANAGER_WORDING);
      await welcome.getByRole('button', { name: 'See my shifts' }).click();
      await staffPage.waitForURL((url) => url.pathname === '/my-shifts');
      await expect(staffPage.getByRole('heading', { name: `Welcome back, ${APPLICANT_NAME}` })).toBeVisible();
      const stored = JSON.parse((await staffPage.evaluate(() => localStorage.getItem('shiftsync.session'))) ?? 'null') as { user: { systemRole: string } };
      expect(stored.user.systemRole).toBe('STAFF');

      // --- A second sign-in is routine: no welcome screen again.
      await staffPage.evaluate(() => localStorage.removeItem('shiftsync.session'));
      await skipOtpResendWait(staffPhone);
      await open(staffPage, '/login?as=staff');
      const again = await requestCode(staffPage, staffPhone);
      await staffPage.getByPlaceholder('6-digit code').fill(again);
      await staffPage.getByRole('button', { name: 'Verify & log in' }).click();
      await staffPage.waitForURL((url) => url.pathname === '/my-shifts');

      // Staff never saw manager onboarding.
      expect(visited.filter((p) => p.startsWith('/onboarding') || p === '/signup')).toEqual([]);
      // Manager onboarding is not reachable for them either: a direct visit bounces to My Shifts.
      await staffPage.goto('/onboarding');
      await staffPage.waitForURL((url) => url.pathname === '/my-shifts');
    } finally {
      await staffContext.close();
      await ownerContext.close();
    }
  });
});
