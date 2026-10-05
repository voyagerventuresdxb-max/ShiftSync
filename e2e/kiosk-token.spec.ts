import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';
import { cleanupTestOrgs, nextEchoPhone, prisma, testVenueName } from './helpers';

/**
 * Kiosk links: `/kiosk?venue=<id>#k=<token>` shows a venue's published rota,
 * announcements and shoutouts on a shared screen with no sign-in. The owner
 * creates, regenerates and revokes the link on /people; each "shared screen"
 * is a fresh browser context. A venue id alone shows nothing but the message.
 *
 * Real backend + real DB, no request interception.
 */

const OWNER_NAME = 'E2E Kiosk Owner';
const STAFF_NAME = 'E2E Kiosk Bartender Rania';
const ANNOUNCEMENT = 'E2E kiosk: staff meeting moved to Thursday 4pm';
const SHOUTOUT = 'E2E kiosk: brilliant close last night';
const BRIEFING = 'E2E kiosk briefing: VIP table at nine';
const REFUSED = 'This screen needs a current kiosk link — ask a manager to share it again.';
const usedPhones: string[] = [];

function freshPhone(): string {
  const phone = nextEchoPhone();
  usedPhones.push(phone);
  return phone;
}

/** This week's Monday in local time — the week the app shows (src/engine/weekStart.ts `currentWeekStart`; the browser shares this clock). */
function currentWeekStart(): string {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * A venue with an owner, one staff member, this week's rota published with
 * one shift (10:00–18:00 on Tuesday), a later DRAFT shift (12:00–20:00 on
 * Wednesday), an announcement and a shoutout. "This week" is the Monday the
 * app itself shows (`currentWeekStart`, same clock as the browser).
 */
async function createVenue(): Promise<{ locationId: string; ownerPhone: string; staffPhone: string }> {
  const venueName = testVenueName('kiosk-token');
  const org = await prisma.organization.create({ data: { name: venueName } });
  const location = await prisma.location.create({ data: { organizationId: org.id, name: venueName, timezone: 'Asia/Dubai' } });
  const ownerPhone = freshPhone();
  const owner = await prisma.user.create({ data: { locationId: location.id, systemRole: 'OWNER', fullName: OWNER_NAME, phone: ownerPhone } });
  const staffPhone = freshPhone();
  const staff = await prisma.user.create({ data: { locationId: location.id, systemRole: 'STAFF', fullName: STAFF_NAME, phone: staffPhone } });
  const role = await prisma.role.create({ data: { locationId: location.id, name: 'Bartender' } });

  const monday = currentWeekStart();
  const shift = (date: string, start: string, end: string, status: 'DRAFT' | 'PUBLISHED') =>
    prisma.shift.create({
      data: {
        locationId: location.id, roleId: role.id, userId: staff.id, date: new Date(`${date}T00:00:00.000Z`),
        startTime: new Date(`${date}T${start}:00+04:00`), endTime: new Date(`${date}T${end}:00+04:00`), status, managerNotes: BRIEFING,
      },
    });
  await shift(addDays(monday, 1), '10:00', '18:00', 'PUBLISHED');
  await shift(addDays(monday, 2), '12:00', '20:00', 'DRAFT');
  await prisma.rotaPublish.create({ data: { locationId: location.id, weekStart: new Date(`${monday}T00:00:00.000Z`), publishedAt: new Date(), publishedById: owner.id, notifiedCount: 1 } });
  await prisma.announcement.create({ data: { locationId: location.id, authorId: owner.id, body: ANNOUNCEMENT } });
  await prisma.shoutout.create({ data: { locationId: location.id, employeeId: staff.id, authorId: owner.id, note: SHOUTOUT } });
  return { locationId: location.id, ownerPhone, staffPhone };
}

/** Same one-retry cold-Vite guard as helpers.ts `signupNewVenue`. */
async function open(page: Page, path: string): Promise<void> {
  try {
    await page.goto(path);
  } catch {
    await page.goto(path);
  }
}

/** The owner signs in through /login in their own context and opens the Kiosk link panel on /people. */
async function ownerOnPeople(browser: Browser, ownerPhone: string): Promise<{ page: Page; panel: Locator }> {
  const context = await browser.newContext();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  await open(page, '/login');
  await page.getByPlaceholder('Phone number').fill(ownerPhone);
  await page.getByRole('button', { name: 'Send code' }).click();
  const code = (await page.locator('p.hint .font-mono').innerText()).trim();
  await page.getByPlaceholder('6-digit code').fill(code);
  await page.getByRole('button', { name: 'Verify & log in' }).click();
  await page.waitForURL((url) => url.pathname === '/');
  await page.goto('/people');
  const panel = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Kiosk link', exact: true }) });
  await expect(panel).toBeVisible();
  return { page, panel };
}

/** Copies the just-created link from the panel (it is shown only now). */
async function copyLink(page: Page, panel: Locator, locationId: string): Promise<string> {
  await panel.getByRole('button', { name: 'Copy link' }).click();
  await expect(panel.getByRole('button', { name: 'Copied' })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(await panel.getByRole('textbox', { name: 'Kiosk link' }).inputValue());
  expect(copied).toMatch(new RegExp(`^http://localhost:5173/kiosk\\?venue=${locationId}#k=[A-Za-z0-9_-]{43}$`));
  return copied;
}

async function createLink(page: Page, panel: Locator, locationId: string): Promise<string> {
  await expect(panel.getByText('No kiosk link')).toBeVisible();
  await panel.getByRole('button', { name: 'Create kiosk link' }).click();
  await expect(panel.getByText(/^Active since /)).toBeVisible();
  return copyLink(page, panel, locationId);
}

/** A fresh shared-screen context opens `url`. */
async function screenOpens(browser: Browser, url: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await open(page, url);
  return page;
}

const rotaHeading = (page: Page) => page.getByRole('heading', { name: "This week's rota" });

async function expectRefused(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Kiosk link needed' })).toBeVisible();
  await expect(page.getByText(REFUSED)).toBeVisible();
  await expect(rotaHeading(page)).toHaveCount(0);
  await expect(page.getByText(STAFF_NAME)).toHaveCount(0);
  await expect(page.getByText(ANNOUNCEMENT)).toHaveCount(0);
  await expect(page.getByText(SHOUTOUT)).toHaveCount(0);
}

test.describe('kiosk links — a shared screen shows the published rota with the venue’s current link only', () => {
  test.afterEach(async ({ browser }) => {
    for (const context of browser.contexts()) await context.close().catch(() => {});
    await cleanupTestOrgs();
    await prisma.otpCode.deleteMany({ where: { phone: { in: usedPhones.splice(0) } } });
  });

  test('valid link: the screen shows the published rota, announcements and shoutouts — no drafts, notes or phone numbers', async ({ browser }) => {
    const { locationId, ownerPhone, staffPhone } = await createVenue();
    const owner = await ownerOnPeople(browser, ownerPhone);
    const link = await createLink(owner.page, owner.panel, locationId);

    const screen = await screenOpens(browser, link);
    await expect(rotaHeading(screen)).toBeVisible();
    const rota = screen.locator('section').filter({ has: rotaHeading(screen) });
    await expect(rota.getByText(STAFF_NAME)).toBeVisible();
    await expect(rota.getByText('Bartender · 10:00–18:00')).toBeVisible();
    await expect(rota.getByText(/12:00–20:00/)).toHaveCount(0);
    await expect(screen.getByText(ANNOUNCEMENT)).toBeVisible();
    await expect(screen.getByText(SHOUTOUT)).toBeVisible();
    await expect(screen.getByText(BRIEFING)).toHaveCount(0);
    await expect(screen.getByText(staffPhone)).toHaveCount(0);

    // The token leaves the address bar but stays on the device: a reload still shows the rota.
    await expect(screen).toHaveURL(new RegExp(`/kiosk\\?venue=${locationId}$`));
    await screen.reload();
    await expect(rotaHeading(screen)).toBeVisible();
    await expect(screen.getByText(ANNOUNCEMENT)).toBeVisible();

    // The panel never shows the link again once the page is reloaded.
    await owner.page.reload();
    await expect(owner.panel.getByText(/^Active since /)).toBeVisible();
    await expect(owner.panel.getByRole('textbox', { name: 'Kiosk link' })).toHaveCount(0);
  });

  test('regenerated: the old link is refused and the new one works', async ({ browser }) => {
    const { locationId, ownerPhone } = await createVenue();
    const owner = await ownerOnPeople(browser, ownerPhone);
    const oldLink = await createLink(owner.page, owner.panel, locationId);

    await owner.panel.getByRole('button', { name: 'Regenerate' }).click();
    await expect(owner.panel.getByText('The current kiosk link stops working as soon as the new one is created.')).toBeVisible();
    await owner.panel.getByRole('button', { name: 'Create new link' }).click();
    await expect(owner.panel.getByRole('button', { name: 'Create new link' })).toHaveCount(0);
    await expect(owner.panel.getByRole('textbox', { name: 'Kiosk link' })).not.toHaveValue(oldLink);
    const newLink = await copyLink(owner.page, owner.panel, locationId);
    expect(newLink).not.toBe(oldLink);

    await expectRefused(await screenOpens(browser, oldLink));

    const screen = await screenOpens(browser, newLink);
    await expect(rotaHeading(screen)).toBeVisible();
    await expect(screen.getByText(ANNOUNCEMENT)).toBeVisible();
  });

  test('revoked: a screen already showing the rota is refused on its next load', async ({ browser }) => {
    const { locationId, ownerPhone } = await createVenue();
    const owner = await ownerOnPeople(browser, ownerPhone);
    const link = await createLink(owner.page, owner.panel, locationId);

    const screen = await screenOpens(browser, link);
    await expect(rotaHeading(screen)).toBeVisible();

    await owner.panel.getByRole('button', { name: 'Revoke', exact: true }).click();
    await expect(owner.panel.getByText('Revoke the kiosk link?')).toBeVisible();
    await owner.panel.getByRole('button', { name: 'Yes, revoke' }).click();
    await expect(owner.panel.getByText('No kiosk link')).toBeVisible();
    await expect(owner.panel.getByRole('textbox', { name: 'Kiosk link' })).toHaveCount(0);

    await screen.reload();
    await expectRefused(screen);
    await expectRefused(await screenOpens(browser, link));
  });

  test('a URL with only the venue id shows no data, just the message — on /kiosk and on Home', async ({ browser }) => {
    const { locationId } = await createVenue();

    await expectRefused(await screenOpens(browser, `/kiosk?venue=${locationId}`));

    const home = await screenOpens(browser, `/?venue=${locationId}`);
    await expect(home.getByText(REFUSED).first()).toBeVisible();
    await expect(home.getByText(ANNOUNCEMENT)).toHaveCount(0);
    await expect(home.getByText(SHOUTOUT)).toHaveCount(0);
  });
});
