import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { cleanupTestOrgs, nextEchoPhone, prisma, skipOtpResendWait, testVenueName } from './helpers';

/**
 * Staff join via the venue link and wait for a manager's approval. A
 * returning applicant sees their real status on /login; once approved, the
 * next sign-in lands on staff Home; a decline is explained, and they may apply again.
 *
 * Real backend + real DB, no request interception. The venue and its owner
 * are created directly; the owner approves/declines in the real
 * PendingApprovals UI on /people, in a second browser context.
 */

const OWNER_NAME = 'E2E Approver Layla';
const APPLICANT_NAME = 'E2E Applicant Omar';
const usedPhones: string[] = [];

function freshPhone(): string {
  const phone = nextEchoPhone();
  usedPhones.push(phone);
  return phone;
}

async function createVenue(): Promise<{ inviteToken: string; venueName: string; ownerPhone: string; locationId: string }> {
  const venueName = testVenueName('join-approval');
  const org = await prisma.organization.create({ data: { name: venueName } });
  const location = await prisma.location.create({ data: { organizationId: org.id, name: venueName } });
  const ownerPhone = freshPhone();
  await prisma.user.create({ data: { locationId: location.id, systemRole: 'OWNER', fullName: OWNER_NAME, phone: ownerPhone } });
  const { token: inviteToken } = await prisma.inviteLink.create({
    data: { locationId: location.id, token: randomBytes(32).toString('base64url'), expiresAt: new Date(Date.now() + 86_400_000) },
  });
  return { inviteToken, venueName, ownerPhone, locationId: location.id };
}

/** Same one-retry cold-Vite guard as helpers.ts `signupNewVenue`. */
async function open(page: Page, path: string): Promise<void> {
  try {
    await page.goto(path);
  } catch {
    await page.goto(path);
  }
}

/** Phone step → code step on /login or /join; returns the echoed dev code. */
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

async function joinViaLink(page: Page, inviteToken: string, phone: string, fullName = APPLICANT_NAME): Promise<void> {
  await open(page, `/join?invite=${inviteToken}`);
  const code = await requestCode(page, phone);
  await page.getByPlaceholder('6-digit code').fill(code);
  await page.getByPlaceholder('Full name (if this is your first time)').fill(fullName);
  await page.getByRole('button', { name: 'Verify & continue' }).click();
}

async function storedSession(page: Page): Promise<{ user: { systemRole: string } } | null> {
  return JSON.parse((await page.evaluate(() => localStorage.getItem('shiftsync.session'))) ?? 'null');
}

/** The owner signs in, opens Pending Approvals on /people and decides the applicant's request. */
async function ownerDecides(page: Page, ownerPhone: string, decision: 'Approve' | 'Decline'): Promise<void> {
  await logIn(page, ownerPhone);
  await page.waitForURL((url) => url.pathname === '/');
  await page.goto('/people');
  const toggle = page.getByRole('button', { name: /Pending Approvals/ });
  await toggle.click();
  const panel = page.locator('section').filter({ has: toggle });
  const row = panel.getByRole('listitem').filter({ hasText: APPLICANT_NAME });
  await row.getByRole('button', { name: decision }).click();
  await expect(row).toHaveCount(0);
}

const waitingText = (venueName: string) => `Waiting for ${OWNER_NAME} to approve you at ${venueName}.`;

test.describe('join link → manager approval → staff in', () => {
  test.afterEach(async ({ page }) => {
    await page.close().catch(() => {});
    await cleanupTestOrgs();
    await prisma.otpCode.deleteMany({ where: { phone: { in: usedPhones.splice(0) } } });
  });

  test('a pending applicant sees who they are waiting on, at join and again on /login, with no session', async ({ page }) => {
    const { inviteToken, venueName } = await createVenue();
    const phone = freshPhone();

    await joinViaLink(page, inviteToken, phone);
    await expect(page.getByText(waitingText(venueName))).toBeVisible();

    await skipOtpResendWait(phone);
    await logIn(page, phone);
    await expect(page.getByText(waitingText(venueName))).toBeVisible();
    await expect(page.getByText("Sign in again once you've been approved.")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/login');
    expect(await storedSession(page)).toBeNull();
    expect(await prisma.joinRequest.count({ where: { phone } })).toBe(1);
  });

  test('once the owner approves on /people, the next sign-in lands on /my-shifts', async ({ page, browser }) => {
    const { inviteToken, venueName, ownerPhone } = await createVenue();
    const phone = freshPhone();

    await joinViaLink(page, inviteToken, phone);
    await expect(page.getByText(waitingText(venueName))).toBeVisible();

    const ownerContext = await browser.newContext();
    try {
      await ownerDecides(await ownerContext.newPage(), ownerPhone, 'Approve');
    } finally {
      await ownerContext.close();
    }

    await skipOtpResendWait(phone);
    await logIn(page, phone);
    await page.waitForURL((url) => url.pathname === '/my-shifts');
    await expect(page.getByText(`Welcome back, ${APPLICANT_NAME}`)).toBeVisible();
    expect((await storedSession(page))?.user.systemRole).toBe('STAFF');
  });

  test('an applicant who could be either of two people imported from the roster: the owner must choose, and exactly that record is linked', async ({ page, browser }) => {
    const { inviteToken, venueName, ownerPhone, locationId } = await createVenue();
    // Made-up names: two roster-imported staff (no phone yet) share the applicant's first name.
    const halloumi = await prisma.user.create({ data: { locationId, fullName: 'Tarek Halloumi', systemRole: 'STAFF' } });
    const benali = await prisma.user.create({ data: { locationId, fullName: 'Tarek Benali', systemRole: 'STAFF' } });
    const phone = freshPhone();
    await joinViaLink(page, inviteToken, phone, 'Tarek');
    await expect(page.getByText(waitingText(venueName))).toBeVisible();

    const ownerContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    try {
      const owner = await ownerContext.newPage();
      await logIn(owner, ownerPhone);
      await owner.waitForURL((url) => url.pathname === '/');
      await owner.goto('/people');
      const toggle = owner.getByRole('button', { name: /Pending Approvals/ });
      await toggle.click();
      const row = owner.locator('section').filter({ has: toggle }).getByTestId('join-request').filter({ hasText: 'Tarek' });
      const approve = row.getByRole('button', { name: 'Approve' });
      await expect(row.getByRole('radio')).toHaveCount(3);
      await expect(approve).toBeDisabled();
      await expect(row).toContainText('Choose who this is to approve.');
      const halloumiOption = row.getByRole('radio', { name: /Link to Tarek Halloumi \(imported from the roster\)/ });
      for (const option of [halloumiOption, row.getByRole('radio', { name: /New person/ })]) {
        expect((await option.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
      const dir = process.env.JOIN_SCREENS_DIR;
      if (dir) {
        mkdirSync(dir, { recursive: true });
        await row.scrollIntoViewIfNeeded();
        await owner.screenshot({ path: join(dir, '01-approval-choose-who.png') });
      }
      await halloumiOption.check();
      await expect(approve).toBeEnabled();
      if (dir) await owner.screenshot({ path: join(dir, '02-approval-chosen.png') });
      await approve.click();
      await expect(row).toHaveCount(0);
    } finally {
      await ownerContext.close();
    }

    expect((await prisma.user.findUniqueOrThrow({ where: { id: halloumi.id } })).phone).toBe(phone);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: benali.id } })).phone).toBeNull();
    expect(await prisma.user.count({ where: { locationId, systemRole: 'STAFF' } })).toBe(2);
  });

  test('a declined applicant is told on /login they may apply again, and the join link files a new request', async ({ page, browser }) => {
    const { inviteToken, venueName, ownerPhone } = await createVenue();
    const phone = freshPhone();

    await joinViaLink(page, inviteToken, phone);
    await expect(page.getByText(waitingText(venueName))).toBeVisible();

    const ownerContext = await browser.newContext();
    try {
      await ownerDecides(await ownerContext.newPage(), ownerPhone, 'Decline');
    } finally {
      await ownerContext.close();
    }

    await skipOtpResendWait(phone);
    await logIn(page, phone);
    await expect(page.locator('.error-block')).toContainText(
      `Your request to join ${venueName} was declined. You can apply again with your full name through ${venueName}'s invite link`,
    );
    expect(await storedSession(page)).toBeNull();

    await skipOtpResendWait(phone);
    await joinViaLink(page, inviteToken, phone);
    await expect(page.getByText(waitingText(venueName))).toBeVisible();
    expect(await prisma.joinRequest.count({ where: { phone } })).toBe(2);
    expect(await prisma.joinRequest.count({ where: { phone, status: 'PENDING' } })).toBe(1);
  });
});
