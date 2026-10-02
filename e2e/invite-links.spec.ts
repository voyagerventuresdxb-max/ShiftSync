import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';
import { cleanupTestOrgs, nextEchoPhone, prisma, testVenueName } from './helpers';

/**
 * Venue invite links: `/join?invite=<token>` with expiry, revoke, regenerate
 * and max uses, managed from the Join link panel on /people. Old
 * `/join?location=` links work only inside the venue's legacy window.
 *
 * Real backend + real DB, no request interception. The owner drives the real
 * People UI in one browser context; each applicant uses their own.
 */

const OWNER_NAME = 'E2E Invite Owner';
const APPLICANT_NAME = 'E2E Invitee Sara';
const usedPhones: string[] = [];

function freshPhone(): string {
  const phone = nextEchoPhone();
  usedPhones.push(phone);
  return phone;
}

async function createVenue(): Promise<{ locationId: string; venueName: string; ownerPhone: string }> {
  const venueName = testVenueName('invite-links');
  const org = await prisma.organization.create({ data: { name: venueName } });
  const location = await prisma.location.create({ data: { organizationId: org.id, name: venueName } });
  const ownerPhone = freshPhone();
  await prisma.user.create({ data: { locationId: location.id, systemRole: 'OWNER', fullName: OWNER_NAME, phone: ownerPhone } });
  return { locationId: location.id, venueName, ownerPhone };
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

/** The owner signs in through /login in their own context and opens the Join link panel on /people. */
async function ownerOnPeople(browser: Browser, ownerPhone: string): Promise<{ page: Page; panel: Locator }> {
  const context = await browser.newContext();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  await open(page, '/login');
  const code = await requestCode(page, ownerPhone);
  await page.getByPlaceholder('6-digit code').fill(code);
  await page.getByRole('button', { name: 'Verify & log in' }).click();
  await page.waitForURL((url) => url.pathname === '/');
  await page.goto('/people');
  const panel = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Join link', exact: true }) });
  await expect(panel).toBeVisible();
  return { page, panel };
}

/** Clicks Generate on an empty panel; returns the new link from the clipboard. */
async function generateLink(page: Page, panel: Locator): Promise<string> {
  await expect(panel.getByText('No active join link')).toBeVisible();
  await panel.getByRole('button', { name: 'Generate link' }).click();
  return copyLink(page, panel);
}

async function copyLink(page: Page, panel: Locator): Promise<string> {
  await panel.getByRole('button', { name: 'Copy link' }).click();
  await expect(panel.getByRole('button', { name: 'Copied' })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(await panel.getByRole('textbox', { name: 'Join link' }).inputValue());
  expect(copied).toMatch(/^http:\/\/localhost:5173\/join\?invite=[A-Za-z0-9_-]{43}$/);
  return copied;
}

/** A fresh applicant context opens `url`. */
async function applicantOpens(browser: Browser, url: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await open(page, url);
  return page;
}

async function joinWithForm(page: Page, phone: string): Promise<void> {
  const code = await requestCode(page, phone);
  await page.getByPlaceholder('6-digit code').fill(code);
  await page.getByPlaceholder('Full name (if this is your first time)').fill(APPLICANT_NAME);
  await page.getByRole('button', { name: 'Verify & continue' }).click();
}

const tokenOf = (url: string) => new URL(url).searchParams.get('invite')!;
const waitingText = (venueName: string) => `Waiting for ${OWNER_NAME} to approve you at ${venueName}.`;

async function expectDeadLink(page: Page, message: string): Promise<void> {
  await expect(page.getByRole('heading', { name: "This invite link can't be used" })).toBeVisible();
  await expect(page.locator('.error-block')).toHaveText(message);
  await expect(page.getByPlaceholder('Phone number')).toHaveCount(0);
}

test.describe('invite links — expiring, revocable, regenerable', () => {
  test.afterEach(async ({ browser }) => {
    for (const context of browser.contexts()) await context.close().catch(() => {});
    await cleanupTestOrgs();
    await prisma.otpCode.deleteMany({ where: { phone: { in: usedPhones.splice(0) } } });
  });

  test('valid: the owner copies the link on People, an applicant sees the venue, joins and is pending', async ({ browser }) => {
    const { venueName, ownerPhone } = await createVenue();
    const owner = await ownerOnPeople(browser, ownerPhone);
    const link = await generateLink(owner.page, owner.panel);
    await expect(owner.panel.getByText('Expires in 30 days · 0 joins')).toBeVisible();

    const applicant = await applicantOpens(browser, link);
    await expect(applicant.getByRole('heading', { name: `Join ${venueName} on ShiftSync` })).toBeVisible();
    const phone = freshPhone();
    await joinWithForm(applicant, phone);
    await expect(applicant.getByText(waitingText(venueName))).toBeVisible();

    expect(await prisma.joinRequest.count({ where: { phone, status: 'PENDING' } })).toBe(1);
    expect((await prisma.inviteLink.findUniqueOrThrow({ where: { token: tokenOf(link) } })).useCount).toBe(1);
    await owner.page.reload();
    await expect(owner.panel.getByText('Expires in 30 days · 1 join')).toBeVisible();
  });

  test('expired: an applicant sees the expired message and no form', async ({ browser }) => {
    const { ownerPhone } = await createVenue();
    const owner = await ownerOnPeople(browser, ownerPhone);
    const link = await generateLink(owner.page, owner.panel);
    await prisma.inviteLink.update({ where: { token: tokenOf(link) }, data: { expiresAt: new Date(Date.now() - 60_000) } });

    const applicant = await applicantOpens(browser, link);
    await expectDeadLink(applicant, 'This invite link has expired — ask your manager for a new one.');
  });

  test('revoked: after the owner revokes on People, the old link shows the inactive message', async ({ browser }) => {
    const { ownerPhone } = await createVenue();
    const owner = await ownerOnPeople(browser, ownerPhone);
    const link = await generateLink(owner.page, owner.panel);

    await owner.panel.getByRole('button', { name: 'Revoke', exact: true }).click();
    await expect(owner.panel.getByText('Revoke this link?')).toBeVisible();
    await owner.panel.getByRole('button', { name: 'Yes, revoke' }).click();
    await expect(owner.panel.getByText('No active join link')).toBeVisible();
    await expect(owner.panel.getByRole('textbox', { name: 'Join link' })).toHaveCount(0);

    const applicant = await applicantOpens(browser, link);
    await expectDeadLink(applicant, 'This invite link is no longer active — ask your manager for a new one.');
  });

  test('regenerated: the old token is rejected and the new one (7 days, 5 uses) works', async ({ browser }) => {
    const { venueName, ownerPhone } = await createVenue();
    const owner = await ownerOnPeople(browser, ownerPhone);
    const oldLink = await generateLink(owner.page, owner.panel);

    await owner.panel.getByRole('button', { name: 'Regenerate' }).click();
    await owner.panel.getByLabel('Expires after').selectOption('7');
    await owner.panel.getByLabel('Max uses').fill('5');
    await owner.panel.getByRole('button', { name: 'Create new link' }).click();
    await expect(owner.panel.getByText('Expires in 7 days · 0 of 5 uses')).toBeVisible();
    const newLink = await copyLink(owner.page, owner.panel);
    expect(newLink).not.toBe(oldLink);

    const stale = await applicantOpens(browser, oldLink);
    await expectDeadLink(stale, 'This invite link is no longer active — ask your manager for a new one.');

    const applicant = await applicantOpens(browser, newLink);
    await expect(applicant.getByRole('heading', { name: `Join ${venueName} on ShiftSync` })).toBeVisible();
    await joinWithForm(applicant, freshPhone());
    await expect(applicant.getByText(waitingText(venueName))).toBeVisible();
    expect((await prisma.inviteLink.findUniqueOrThrow({ where: { token: tokenOf(newLink) } })).useCount).toBe(1);
  });

  test('legacy ?location= links: accepted inside the venue window, rejected once it has passed', async ({ browser }) => {
    const { locationId, venueName } = await createVenue();
    await prisma.location.update({ where: { id: locationId }, data: { legacyJoinLinksUntil: new Date(Date.now() + 86_400_000) } });

    const early = await applicantOpens(browser, `/join?location=${locationId}`);
    await expect(early.getByRole('heading', { name: 'Join ShiftSync' })).toBeVisible();
    await joinWithForm(early, freshPhone());
    await expect(early.getByText(waitingText(venueName))).toBeVisible();

    await prisma.location.update({ where: { id: locationId }, data: { legacyJoinLinksUntil: new Date(Date.now() - 60_000) } });
    const late = await applicantOpens(browser, `/join?location=${locationId}`);
    const latePhone = freshPhone();
    await joinWithForm(late, latePhone);
    await expect(late.locator('.error-block')).toHaveText('This invite link has expired — ask your manager for a new one.');
    expect(await prisma.joinRequest.count({ where: { phone: latePhone } })).toBe(0);
  });
});
