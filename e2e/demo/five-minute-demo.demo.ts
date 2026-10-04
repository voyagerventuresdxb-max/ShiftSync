import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { cleanupTestOrgs, continueThroughVenue, nextEchoPhone, prisma, signupNewVenue, skipOtpResendWait, testVenueName } from '../helpers';

/**
 * The 5-minute demo from docs/mvp-status.md, recorded at phone size: one video
 * per scene (each scene is its own test with its own recorded browser
 * context), then the whole demo again in one take. Run with
 * `npm run demo:record` (playwright.demo.config.ts); videos go to
 * DEMO_VIDEO_DIR. The demo venue is the made-up one from
 * server/scripts/seed-demo-venue.ts, reset before each take with
 * server/scripts/reset-demo-venue.ts; the three sign-in numbers are made-up
 * numbers from this run's echo pool and are never printed.
 *
 * Scene 5 opens a floor-plan section but doesn't drag a chip: a recorded drag
 * on a phone-size canvas is not reliable enough to demo unattended.
 */
const OUT = process.env.DEMO_VIDEO_DIR ?? path.resolve('test-results/demo-videos');
const SIZE = { width: 390, height: 844 };
const ROSTER = path.resolve('server/eval/roster/corpus/grid-western.xlsx');
const phones = { owner: '', staff: '', applicant: '' };
const timings: [string, number][] = [];

test.describe.configure({ mode: 'default' });
// The first page load compiles the app in Vite's dev server, which can take most of a minute.
test.use({ actionTimeout: 15_000, navigationTimeout: 90_000 });

function resetVenue() {
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'server/scripts/reset-demo-venue.ts', `--phones=${phones.owner},${phones.staff},${phones.applicant}`], {
    encoding: 'utf8',
    env: process.env,
  });
  expect(r.status, 'demo reset').toBe(0);
  const seconds = Number(/reset in ([\d.]+)s/.exec(r.stdout)?.[1] ?? NaN);
  timings.push(['reset', seconds]);
}

async function recorded(browser: Browser, dir: string): Promise<BrowserContext> {
  mkdirSync(path.join(OUT, dir), { recursive: true });
  return browser.newContext({ viewport: SIZE, isMobile: true, hasTouch: true, deviceScaleFactor: 2, recordVideo: { dir: path.join(OUT, dir), size: SIZE } });
}

async function signIn(page: Page, phone: string) {
  await skipOtpResendWait(phone);
  await page.goto('/login');
  await page.getByPlaceholder('Phone number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  const code = (await page.locator('p.hint .font-mono').innerText()).trim();
  await page.getByPlaceholder('6-digit code').fill(code);
  await page.getByRole('button', { name: 'Verify & log in' }).click();
  await page.waitForURL((url) => url.pathname === '/' || url.pathname === '/my-shifts' || url.pathname === '/welcome');
}

/** A short pause so a viewer can read the screen in the video. */
const beat = (page: Page, ms = 1200) => page.waitForTimeout(ms);

async function currentMonday(): Promise<string> {
  const publish = await prisma.rotaPublish.findFirst({ where: { locationId: 'demo-location' }, orderBy: { weekStart: 'desc' } });
  return publish!.weekStart.toISOString().slice(0, 10);
}

// ---- the scenes ----------------------------------------------------------------

async function ownerHome(page: Page) {
  await signIn(page, phones.owner);
  await expect(page.getByText(/announcement/i).first()).toBeVisible();
  await beat(page);
  await page.mouse.wheel(0, 600);
  await beat(page);
}

async function editShift(page: Page) {
  await page.goto(`/scheduling?week=${await currentMonday()}`);
  const toggle = page.getByRole('button', { name: /Weekly rota builder/ });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(page.getByText(/Published · locked|Unpublished changes/)).toBeVisible({ timeout: 15_000 });
  await beat(page);
  // The staff persona's last shift this week (My Shifts lists today onwards). A published week has no "Add shift" buttons.
  const row = page.locator('div[class*="grid-cols-[10rem"]').filter({ has: page.getByText('Priya Nair', { exact: true }) });
  // In a locked week the chip's drag is disabled (aria-disabled), but a tap still opens it.
  await row.getByRole('button', { name: /^\d{2}:\d{2}–\d{2}:\d{2}/ }).last().dispatchEvent('click');
  await page.locator('input[type=time]').nth(1).fill('23:30');
  await beat(page, 600);
  await page.getByRole('button', { name: 'Save shift' }).click();
  await expect(page.getByText('Unpublished changes')).toBeVisible();
  await beat(page);
}

async function staffSees(page: Page) {
  await signIn(page, phones.staff);
  await page.goto('/my-shifts');
  await page.waitForLoadState('networkidle');
  await beat(page);
  await page.goto('/');
  await beat(page);
}

async function approveJoin(page: Page) {
  await page.goto('/people');
  const toggle = page.getByRole('button', { name: /Pending Approvals/ });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  const panel = page.locator('section').filter({ has: toggle });
  const row = panel.getByRole('listitem').filter({ hasText: 'Sara Nour' });
  await beat(page, 800);
  await row.getByRole('button', { name: 'Approve' }).click();
  await expect(row).toHaveCount(0);
  await beat(page);
  await page.mouse.wheel(0, 1200);
  await beat(page);
}

async function floorPlan(page: Page) {
  await page.goto('/floor-plan');
  const section = page.locator('[role="button"][aria-label*="pax"]').first();
  await expect(section).toBeVisible();
  await beat(page);
  // The plan canvas sits over the pins for panning; dispatch the tap to the pin itself.
  await section.dispatchEvent('click');
  await beat(page);
}

async function announce(owner: Page, staff: Page) {
  await owner.goto('/');
  await owner.getByRole('button', { name: /Post/ }).first().click();
  await owner.getByPlaceholder('Share an update with the whole venue…').fill('Tasting menu briefing at 17:30 today, bar side.');
  await beat(owner, 600);
  await owner.getByRole('button', { name: 'Broadcast' }).click();
  await expect(owner.getByText('Tasting menu briefing at 17:30 today').first()).toBeVisible();
  await beat(owner);
  await staff.goto('/');
  await staff.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(staff.getByText('Tasting menu briefing at 17:30 today').first()).toBeVisible();
  await beat(staff);
}

async function onboardingUpload(page: Page) {
  await signupNewVenue(page, testVenueName('demo-onboarding'));
  await continueThroughVenue(page);
  await page.waitForSelector('text=Bring your team with you.');
  await page.locator('input[type=file][accept*=".xlsx"]').setInputFiles(ROSTER);
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.waitForSelector("text=Here's what we found.");
  await beat(page, 2000);
}

// ---- one video per scene ---------------------------------------------------------

test.beforeAll(() => {
  mkdirSync(OUT, { recursive: true });
  phones.owner = nextEchoPhone();
  phones.staff = nextEchoPhone();
  phones.applicant = nextEchoPhone();
  resetVenue();
});

test.afterAll(async () => {
  await cleanupTestOrgs();
  await prisma.otpCode.deleteMany({ where: { phone: { in: Object.values(phones) } } });
  console.log(`[demo] timings (s): ${timings.map(([n, s]) => `${n}=${s.toFixed(1)}`).join(' ')}`);
});

async function scene(browser: Browser, name: string, fn: (page: Page) => Promise<void>) {
  const started = Date.now();
  const ctx = await recorded(browser, name);
  try {
    await fn(await ctx.newPage());
  } finally {
    await ctx.close();
    timings.push([name, (Date.now() - started) / 1000]);
  }
}

test('1 owner signs in: Home', async ({ browser }) => scene(browser, '1-owner-home', ownerHome));
test('2 scheduling: edit a published shift', async ({ browser }) =>
  scene(browser, '2-scheduling-edit', async (page) => {
    await signIn(page, phones.owner);
    await editShift(page);
  }));
test('3 staff phone: My Shifts shows the change', async ({ browser }) => scene(browser, '3-staff-my-shifts', staffSees));
test('4 people: approve the join request', async ({ browser }) =>
  scene(browser, '4-people-approve', async (page) => {
    await signIn(page, phones.owner);
    await approveJoin(page);
  }));
test('5 floor plan: open a section', async ({ browser }) =>
  scene(browser, '5-floor-plan', async (page) => {
    await signIn(page, phones.owner);
    await floorPlan(page);
  }));
test('6 announcement reaches the staff phone', async ({ browser }) => {
  const started = Date.now();
  const ownerCtx = await recorded(browser, '6-announcement-owner');
  const staffCtx = await recorded(browser, '6-announcement-staff');
  try {
    const owner = await ownerCtx.newPage();
    const staff = await staffCtx.newPage();
    await signIn(owner, phones.owner);
    await signIn(staff, phones.staff);
    await announce(owner, staff);
  } finally {
    await ownerCtx.close();
    await staffCtx.close();
    timings.push(['6-announcement', (Date.now() - started) / 1000]);
  }
});
test('7 onboarding: a new venue uploads an Excel roster', async ({ browser }) => scene(browser, '7-onboarding-upload', onboardingUpload));

// ---- the whole demo in one take ---------------------------------------------------

test('full run', async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  resetVenue();
  const started = Date.now();
  const ownerCtx = await recorded(browser, 'full-run-owner');
  const staffCtx = await recorded(browser, 'full-run-staff');
  const newVenueCtx = await recorded(browser, 'full-run-onboarding');
  try {
    const owner = await ownerCtx.newPage();
    const staff = await staffCtx.newPage();
    await ownerHome(owner);
    await editShift(owner);
    await staffSees(staff);
    await approveJoin(owner);
    await floorPlan(owner);
    await announce(owner, staff);
    await onboardingUpload(await newVenueCtx.newPage());
  } finally {
    await ownerCtx.close();
    await staffCtx.close();
    await newVenueCtx.close();
    timings.push(['full-run', (Date.now() - started) / 1000]);
  }
});
