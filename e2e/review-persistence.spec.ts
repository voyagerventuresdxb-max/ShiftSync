import { test, expect } from '@playwright/test';
import path from 'node:path';
import { cleanupTestOrgs, confirmOnboardingReview, continueThroughVenue, prisma, signupNewVenue, testVenueName } from './helpers';

/**
 * The review's in-progress decisions (a rename, a role pick) must survive a hard reload —
 * mirrored into sessionStorage, keyed by venue + batch — and still reach the server on confirm.
 *
 * Reaches Roster through the real Account + Venue steps (steps are gated by actual progress
 * since issue #14, so a direct `goto` would be bounced back to Venue). Still 100% real
 * backend: real signup, real file upload, real reload, real confirm.
 */

const FIXTURE = path.resolve('server/test-fixtures/sample-roster.xlsx');

test.describe('review screen — in-progress decisions persist across reload', () => {
  // See onboarding.spec.ts's afterEach comment: close the page before
  // deleting its data so no in-flight request races the cascading delete.
  test.afterEach(async ({ page }) => {
    await page.close().catch(() => {});
    await cleanupTestOrgs();
  });

  test('an unconfirmed rename + role pick survives a reload, then confirm creates that person with that role', async ({ page }) => {
    const venueName = testVenueName('review-persist');
    await signupNewVenue(page, venueName);
    await continueThroughVenue(page);
    await page.waitForSelector('text=Bring your team with you.');
    await page.locator('input[type=file][accept*=".xlsx"]').setInputFiles(FIXTURE);
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({ timeout: 20000 });
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.waitForURL('**/onboarding/review**');
    await page.waitForSelector("text=Here's what we found.");

    const card = page.getByTestId('rr-person').first();
    await card.getByRole('button', { name: 'Shifts, name & role' }).click();
    await card.getByLabel('Name on your staff list').fill('Persisted Edit Name');
    await card.getByLabel(/^Role for /).selectOption('Head Bartender');
    // Give the sessionStorage-mirroring effect a tick to run.
    await page.waitForTimeout(200);

    await page.reload();
    await page.waitForSelector("text=Here's what we found.");
    await expect(page.getByTestId('rr-person').first()).toContainText('Persisted Edit Name');
    await expect(page.getByTestId('rr-person').first()).toContainText('Head Bartender');

    await confirmOnboardingReview(page);

    // The restored decisions reached the server: a staff member with the edited name and the
    // picked role (created for the venue on the fly) exists.
    const org = await prisma.organization.findFirst({ where: { name: venueName } });
    const loc = await prisma.location.findFirst({ where: { organizationId: org?.id } });
    const user = await prisma.user.findFirst({ where: { locationId: loc?.id, fullName: 'Persisted Edit Name' }, include: { role: true } });
    expect(user?.role?.name).toBe('Head Bartender');
  });
});
