import { randomBytes } from 'node:crypto';
import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';
import { cleanupTestOrgs, nextEchoPhone, prisma, skipOtpResendWait, testVenueName } from './helpers';

/**
 * People stays live: a join request filed while the owner has /people open
 * appears when the window regains focus, and approving it moves the hire
 * into the Staff Directory — no reload. A declined applicant may apply again
 * through the venue's invite link, three requests in all; the owner sees
 * the earlier declines on each new one.
 *
 * Real backend + real DB, no request interception. Owner and applicant each
 * drive their own browser context; focus is a dispatched window `focus`
 * event, since a background context never gets a real one.
 */

const OWNER_NAME = 'E2E Live Owner';
const APPLICANT_NAME = 'E2E Live Applicant Noor';
const usedPhones: string[] = [];

function freshPhone(): string {
  const phone = nextEchoPhone();
  usedPhones.push(phone);
  return phone;
}

async function createVenue(): Promise<{ venueName: string; ownerPhone: string; inviteToken: string; locationId: string }> {
  const venueName = testVenueName('people-live');
  const org = await prisma.organization.create({ data: { name: venueName } });
  const location = await prisma.location.create({ data: { organizationId: org.id, name: venueName } });
  const ownerPhone = freshPhone();
  await prisma.user.create({ data: { locationId: location.id, systemRole: 'OWNER', fullName: OWNER_NAME, phone: ownerPhone } });
  const { token: inviteToken } = await prisma.inviteLink.create({
    data: { locationId: location.id, token: randomBytes(32).toString('base64url'), expiresAt: new Date(Date.now() + 30 * 86_400_000) },
  });
  return { venueName, ownerPhone, inviteToken, locationId: location.id };
}

/** Same one-retry cold-Vite guard as helpers.ts `signupNewVenue`. */
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

/** The owner signs in, opens /people once, and expands Pending Approvals and the Staff Directory. Marks the document so a reload would show. */
async function ownerOnPeople(browser: Browser, ownerPhone: string): Promise<{ page: Page; pending: Locator }> {
  const page = await (await browser.newContext()).newPage();
  await open(page, '/login');
  const code = await requestCode(page, ownerPhone);
  await page.getByPlaceholder('6-digit code').fill(code);
  await page.getByRole('button', { name: 'Verify & log in' }).click();
  await page.waitForURL((url) => url.pathname === '/');
  await page.goto('/people');
  const toggle = page.getByRole('button', { name: /Pending Approvals/ });
  await toggle.click();
  const pending = page.locator('section').filter({ has: toggle });
  await expect(pending.getByText('No join requests waiting for review.')).toBeVisible();
  await page.getByRole('button', { name: /Staff Directory/ }).click();
  await expect(page.getByRole('row').filter({ hasText: OWNER_NAME })).toBeVisible();
  await page.evaluate(() => ((window as unknown as { __sameDocument: boolean }).__sameDocument = true));
  return { page, pending };
}

const focusWindow = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('focus')));
const sameDocument = (page: Page) => page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument === true);

/** One application through the invite link, with a fresh code. */
async function applyViaLink(page: Page, inviteToken: string, phone: string): Promise<void> {
  await skipOtpResendWait(phone);
  await open(page, `/join?invite=${inviteToken}`);
  const code = await requestCode(page, phone);
  await page.getByPlaceholder('6-digit code').fill(code);
  await page.getByPlaceholder('Full name (if this is your first time)').fill(APPLICANT_NAME);
  await page.getByRole('button', { name: 'Verify & continue' }).click();
}

const waitingText = (venueName: string) => `Waiting for ${OWNER_NAME} to approve you at ${venueName}.`;

test.describe('/people live refresh, and re-applying after a decline', () => {
  test.afterEach(async ({ browser }) => {
    for (const context of browser.contexts()) await context.close().catch(() => {});
    await cleanupTestOrgs();
    await prisma.otpCode.deleteMany({ where: { phone: { in: usedPhones.splice(0) } } });
  });

  test('a request filed while People is open appears on focus; approving moves the hire into the Staff Directory without a reload', async ({ browser }) => {
    const { venueName, ownerPhone, inviteToken } = await createVenue();
    const owner = await ownerOnPeople(browser, ownerPhone);
    const joinLink = owner.page.locator('section').filter({ has: owner.page.getByRole('heading', { name: 'Join link', exact: true }) });
    await expect(joinLink.getByText(/· 0 joins$/)).toBeVisible();

    const applicant = await (await browser.newContext()).newPage();
    const phone = freshPhone();
    await applyViaLink(applicant, inviteToken, phone);
    await expect(applicant.getByText(waitingText(venueName))).toBeVisible();

    await focusWindow(owner.page);
    const request = owner.pending.getByRole('listitem').filter({ hasText: APPLICANT_NAME });
    await expect(request).toBeVisible();
    await expect(request.getByText(/Previously declined/)).toHaveCount(0);
    await expect(joinLink.getByText(/· 1 join$/)).toBeVisible();

    await request.getByRole('button', { name: 'Approve' }).click();
    await expect(request).toHaveCount(0);
    await expect(owner.pending.getByText('No join requests waiting for review.')).toBeVisible();
    await expect(owner.page.getByRole('row').filter({ hasText: APPLICANT_NAME })).toBeVisible();
    expect(await sameDocument(owner.page)).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { phone } })).fullName).toBe(APPLICANT_NAME);
  });

  test('a declined applicant re-applies through the link, the owner sees the history, and the fourth try is refused', async ({ browser }) => {
    test.setTimeout(150_000);
    const { venueName, ownerPhone, inviteToken, locationId } = await createVenue();
    const owner = await ownerOnPeople(browser, ownerPhone);
    const applicant = await (await browser.newContext()).newPage();
    const phone = freshPhone();
    const request = owner.pending.getByRole('listitem').filter({ hasText: APPLICANT_NAME });

    for (const attempt of [1, 2, 3]) {
      await applyViaLink(applicant, inviteToken, phone);
      await expect(applicant.getByText(waitingText(venueName))).toBeVisible();

      await focusWindow(owner.page);
      await expect(request).toBeVisible();
      if (attempt === 1) await expect(request.getByText(/Previously declined/)).toHaveCount(0);
      else await expect(request.getByText(new RegExp(`^Previously declined ${attempt - 1}× \\(last on .+\\)$`))).toBeVisible();

      await request.getByRole('button', { name: 'Decline' }).click();
      await expect(request).toHaveCount(0);
    }

    await applyViaLink(applicant, inviteToken, phone);
    await expect(applicant.locator('.error-block')).toHaveText(`You've already applied to ${venueName} 3 times. Ask a manager there to add you.`);
    await expect(applicant.getByText(waitingText(venueName))).toHaveCount(0);
    expect(await prisma.joinRequest.count({ where: { locationId, phone } })).toBe(3);
    expect(await prisma.joinRequest.count({ where: { locationId, phone, status: 'PENDING' } })).toBe(0);
    expect((await prisma.inviteLink.findUniqueOrThrow({ where: { token: inviteToken } })).useCount).toBe(3);

    await focusWindow(owner.page);
    await expect(owner.pending.getByText('No join requests waiting for review.')).toBeVisible();
    expect(await sameDocument(owner.page)).toBe(true);
  });
});
