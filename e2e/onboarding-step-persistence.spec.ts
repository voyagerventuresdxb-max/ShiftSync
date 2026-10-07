import { test, expect } from '@playwright/test';
import path from 'node:path';
import { cleanupTestOrgs, confirmOnboardingReview, continueThroughVenue, signupNewVenue, testVenueName } from './helpers';

/**
 * The onboarding step lives in the URL (/onboarding/:step), not plain React
 * state, specifically so a hard reload resumes where the manager left off
 * instead of bouncing back to Welcome. This covers both halves of that:
 * the step itself, and Roster's already-parsed-but-unconfirmed upload
 * (mirrored into sessionStorage, since it's the one piece of real
 * cross-screen state that doesn't refetch itself on mount the way Venue and
 * Invite do).
 */

const FIXTURE = path.resolve('server/test-fixtures/sample-roster.xlsx');

test.describe('onboarding — step position survives a reload', () => {
  // See onboarding.spec.ts's afterEach comment: close the page before
  // deleting its data so no in-flight request races the cascading delete.
  test.afterEach(async ({ page }) => {
    await page.close().catch(() => {});
    await cleanupTestOrgs();
  });

  test('reload on Roster resumes on Roster', async ({ page }) => {
    const venueName = testVenueName('step-persist-roster');
    await signupNewVenue(page, venueName);
    await continueThroughVenue(page);
    await page.waitForSelector('text=Bring your team with you.');

    await page.reload();
    await page.waitForSelector('text=Bring your team with you.');
    expect(new URL(page.url()).pathname).toBe('/onboarding/roster');
  });

  test('Back from Review, and a reload on Roster, both keep the attached file — no re-upload needed', async ({ page }) => {
    const venueName = testVenueName('step-persist-roster-file');
    await signupNewVenue(page, venueName);
    await continueThroughVenue(page);
    await page.waitForSelector('text=Bring your team with you.');
    await page.locator('input[type=file][accept*=".xlsx"]').setInputFiles(FIXTURE);
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({ timeout: 20000 });
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.waitForURL('**/onboarding/review**');
    await page.waitForSelector("text=Here's what we found.");

    // Back: the zone still shows the file, Continue is still enabled.
    await page.getByRole('button', { name: 'Back' }).click();
    await page.waitForURL('**/onboarding/roster**');
    await expect(page.getByText('sample-roster.xlsx')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove file' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();

    // Reload on Roster: same.
    await page.reload();
    await page.waitForSelector('text=Bring your team with you.');
    await expect(page.getByText('sample-roster.xlsx')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();

    // Remove really clears it, on this screen AND for Review.
    await page.getByRole('button', { name: 'Remove file' }).click();
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
    await page.reload();
    await page.waitForSelector('text=Bring your team with you.');
    await expect(page.getByRole('button', { name: /Upload your roster/ })).toBeVisible();
  });

  test('reload on Review resumes on Review with the same parsed rows — no re-upload', async ({ page }) => {
    const venueName = testVenueName('step-persist-review');
    await signupNewVenue(page, venueName);
    await continueThroughVenue(page);
    await page.waitForSelector('text=Bring your team with you.');
    await page.locator('input[type=file][accept*=".xlsx"]').setInputFiles(FIXTURE);
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({ timeout: 20000 });
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.waitForURL('**/onboarding/review**');
    await page.waitForSelector("text=Here's what we found.");
    const rowCountBefore = await page.getByTestId('rr-person').count();
    expect(rowCountBefore).toBeGreaterThan(0);

    await page.reload();

    // No re-upload prompt — "Nothing to review yet" only renders when
    // uploadResult didn't survive the reload.
    await expect(page.getByText('Nothing to review yet.')).toHaveCount(0);
    await page.waitForSelector("text=Here's what we found.");
    expect(new URL(page.url()).pathname).toBe('/onboarding/review');
    const rowCountAfter = await page.getByTestId('rr-person').count();
    expect(rowCountAfter).toBe(rowCountBefore);

    // The rest of the flow still works post-resume (confirm -> Invite),
    // proving this isn't just a display artifact.
    await confirmOnboardingReview(page);

    // The batch is spent: Back to Review has nothing stale to confirm again.
    await page.goto('/onboarding/review');
    await expect(page.getByText('Nothing to review yet.')).toBeVisible();
  });
});
