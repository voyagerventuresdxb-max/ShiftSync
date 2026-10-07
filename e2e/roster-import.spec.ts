import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTestOrgs, continueThroughVenue, gotoSettled, prisma, signupNewVenue, testVenueName } from './helpers';

/**
 * Roster import end to end, on a phone-sized screen: the onboarding import makes everyone on
 * the roster a real staff member (Staff Directory and Invite list them all), and a second
 * roster in the same format on the Scheduling page matches every person — no new staff, no
 * duplicate shifts. Real backend and database; made-up names only.
 *
 * Set ROSTER_REVIEW_SCREENS_DIR to also save screenshots of each step.
 */

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const CREW: [string, string][] = [
  ['Ava Thornton', 'Waiter'],
  ['Ben Okafor', 'Bartender'],
  ['Cleo Varga', 'Wine Steward'], // not a role the venue has: imported anyway, role assigned in bulk
];
const WEEK_A = ['2031-03-03', '2031-03-04', '2031-03-05'];
const WEEK_B = ['2031-03-10', '2031-03-11', '2031-03-12'];

function rosterCsv(dates: string[]): Buffer {
  const lines = ['Employee Name,Role,Date,Start Time,End Time'];
  for (const [name, role] of CREW) for (const date of dates) lines.push(`${name},${role},${date},17:00,23:00`);
  return Buffer.from(lines.join('\n'));
}

/** Full page, or (with `at`) the phone screen scrolled to that element — how a manager sees it. */
async function shot(page: Page, name: string, at?: string): Promise<void> {
  const dir = process.env.ROSTER_REVIEW_SCREENS_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  if (at) await page.getByTestId(at).first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: !at });
}

async function expectNoSideways(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe('roster import — people become staff; a second roster matches them', () => {
  test.afterEach(async ({ page }) => {
    await page.close().catch(() => {});
    await cleanupTestOrgs();
  });

  test('onboarding import -> review -> confirm -> everyone on staff; Scheduling re-import matches all, no duplicates', async ({ page }) => {
    test.setTimeout(240_000);
    const venueName = testVenueName('roster-import');
    await signupNewVenue(page, venueName);
    await continueThroughVenue(page);

    // Onboarding: Roster -> Review
    await page.waitForSelector('text=Bring your team with you.');
    await page.locator('input[type=file][accept*=".xlsx"]').setInputFiles({ name: 'roster-week-a.csv', mimeType: 'text/csv', buffer: rosterCsv(WEEK_A) });
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({ timeout: 20000 });
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.waitForURL('**/onboarding/review**');

    await expect(page.getByTestId('rr-header')).toHaveText('Found 3 people');
    await expect(page.getByTestId('rr-person')).toHaveCount(3);
    await expect(page.getByTestId('rr-week')).toContainText('Week of Mon 3 Mar 2031');
    await expect(page.getByText('No role (1)')).toBeVisible();
    await shot(page, '01-onboarding-review');

    // Role unresolved never blocks; assign one in bulk anyway.
    await page.getByRole('button', { name: 'Select everyone without a role' }).click();
    await page.getByLabel('Role for the selected people').selectOption('Head Waiter');
    await shot(page, '02-onboarding-bulk-role');
    await page.getByTestId('rr-bulk-assign').click();
    await expect(page.getByText('No role (0)')).toBeVisible();

    const confirmButton = page.getByTestId('rr-confirm');
    await expect(confirmButton).toHaveText('Confirm 3 people');
    const box = await confirmButton.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await expectNoSideways(page);
    await confirmButton.click();
    await page.waitForSelector('text=Your team is in.');
    await expect(page.getByTestId('rr-result-lines')).toContainText('3 new people added to your staff');
    await expect(page.getByTestId('rr-result-lines')).toContainText('9 shifts added');
    await shot(page, '03-onboarding-result');

    // Invite lists everyone imported: they are real staff now.
    await page.getByRole('button', { name: 'Continue to Invite' }).click();
    await page.waitForURL('**/onboarding/invite**');
    await page.waitForSelector('text=Venue join-link', { timeout: 15000 });
    await page.getByText('Or invite someone individually').click();
    for (const [name] of CREW) await expect(page.getByText(name, { exact: true })).toBeVisible();
    await shot(page, '04-invite-lists-imported');

    const org = await prisma.organization.findFirst({ where: { name: venueName } });
    const location = await prisma.location.findFirst({ where: { organizationId: org!.id } });
    const cleo = await prisma.user.findFirst({ where: { locationId: location!.id, fullName: 'Cleo Varga' }, include: { role: true } });
    expect(cleo?.role?.name).toBe('Head Waiter');

    await page.getByRole('button', { name: /Skip — invite later/ }).click();
    await page.getByRole('button', { name: 'Continue to Dashboard' }).click();
    await page.waitForURL(/\/$/, { timeout: 10000 });

    // Staff Directory shows everyone.
    await gotoSettled(page, '/people');
    const directory = page.getByRole('button', { name: /Staff Directory/ });
    await expect(directory).toContainText('4'); // the owner + the three imported
    if ((await directory.getAttribute('aria-expanded')) !== 'true') await directory.click();
    for (const [name] of CREW) await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
    await shot(page, '05-staff-directory');

    // Scheduling, after onboarding: the next week's roster, same format.
    await gotoSettled(page, '/scheduling');
    await page.locator('.upload-card input[type=file]').setInputFiles({ name: 'roster-week-b.csv', mimeType: 'text/csv', buffer: rosterCsv(WEEK_B) });
    await expect(page.getByTestId('rr-header')).toHaveText('Found 3 people', { timeout: 20000 });
    await expect(page.getByTestId('roster-review')).toContainText('3 already on your staff · 0 new');
    await expect(page.getByText('No role (0)')).toBeVisible(); // remembered from the first import
    await shot(page, '06-scheduling-second-import', 'roster-review');
    await expectNoSideways(page);
    await page.getByTestId('rr-confirm').click();
    await expect(page.getByTestId('rr-result-lines')).toContainText('0 new people added to your staff');
    await expect(page.getByTestId('rr-result-lines')).toContainText('3 matched to people already on your staff');
    await expect(page.getByTestId('rr-result-lines')).toContainText('9 shifts added');
    // The grid moved to the imported week and shows them.
    await expect(page).toHaveURL(/week=2031-03-10/);
    for (const [name] of CREW) await expect(page.locator('.roster-table-grid').getByText(name).first()).toBeVisible();
    await shot(page, '07-scheduling-result');
    await shot(page, '07b-scheduling-result-screen', 'rr-result');

    // The same roster again: nothing new.
    await page.getByRole('button', { name: 'Upload another roster' }).click();
    await page.locator('.upload-card input[type=file]').setInputFiles({ name: 'roster-week-b.csv', mimeType: 'text/csv', buffer: rosterCsv(WEEK_B) });
    await expect(page.getByTestId('rr-header')).toHaveText('Found 3 people', { timeout: 20000 });
    await page.getByTestId('rr-confirm').click();
    await expect(page.getByTestId('rr-result-lines')).toContainText('0 shifts added');
    await expect(page.getByTestId('rr-result-lines')).toContainText('9 shifts were already on the rota — not added twice');
    await shot(page, '08-scheduling-repeat');

    // A short form of someone on staff is a question, never linked on its own: Confirm waits for the answer.
    await page.getByRole('button', { name: 'Upload another roster' }).click();
    await page.locator('.upload-card input[type=file]').setInputFiles({
      name: 'roster-short-name.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(['Employee Name,Role,Date,Start Time,End Time', 'Ava,Waiter,2031-03-17,17:00,23:00'].join('\n')),
    });
    const card = page.getByTestId('rr-person').first();
    await expect(card).toContainText('Possibly the same person as Ava Thornton — same person?', { timeout: 20000 });
    await expect(page.getByTestId('rr-confirm')).toBeDisabled();
    await expect(page.getByTestId('rr-status')).toHaveText('Answer “same person?” for 1 person');
    await shot(page, '09-same-person-question', 'roster-review');
    await card.getByRole('button', { name: 'Same person' }).click();
    await page.getByTestId('rr-confirm').click();
    await expect(page.getByTestId('rr-result-lines')).toContainText('1 matched to people already on your staff');

    expect(await prisma.user.count({ where: { locationId: location!.id, systemRole: 'STAFF' } })).toBe(3);
    expect(await prisma.shift.count({ where: { locationId: location!.id } })).toBe(19);
  });
});
