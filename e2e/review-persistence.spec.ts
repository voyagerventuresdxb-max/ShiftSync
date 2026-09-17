import { test, expect } from '@playwright/test';
import path from 'node:path';
import { cleanupTestOrgs, continueThroughVenue, prisma, signupNewVenue, testVenueName } from './helpers';

/**
 * Review's in-progress inline edits (a rename, a role pick) must survive a
 * hard reload — mirrored into sessionStorage, keyed by locationId+batchId.
 * Regression coverage for the mid-edit case specifically (a flag left
 * UNCLEARED before the reload), which is the harder, more realistic case
 * than reloading after already confirming a row.
 *
 * Reaches Roster through the real Account + Venue steps (steps are gated
 * by actual progress since issue #14, so a direct `goto` would be bounced
 * back to Venue). Still 100% real backend: real signup, real file upload,
 * real reload, real confirm.
 */

const FIXTURE = path.resolve('server/test-fixtures/sample-roster.xlsx');

test.describe('review screen — in-progress edit persistence across reload', () => {
  // See onboarding.spec.ts's afterEach comment: close the page before
  // deleting its data so no in-flight request races the cascading delete.
  test.afterEach(async ({ page }) => {
    await page.close().catch(() => {});
    await cleanupTestOrgs();
  });

  test('an unconfirmed edit (name + role, flag left uncleared) survives a reload, then confirm still succeeds', async ({ page }) => {
    const venueName = testVenueName('review-persist');
    await signupNewVenue(page, venueName);
    await continueThroughVenue(page);
    await page.waitForSelector('text=Bring your team with you.');
    await page.locator('input[type=file][accept*=".xlsx"]').setInputFiles(FIXTURE);
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({ timeout: 20000 });
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.waitForURL('**/onboarding/review**');
    await page.waitForSelector("text=Here's what we found.");

    // Open the first row and edit it WITHOUT clicking Looks right/Done —
    // the harder case: the flag (if any) is still uncleared when we reload.
    const header = page.locator('div[role="button"]').first();
    await header.click();
    const panel = header.locator('xpath=following-sibling::div[1]');
    await panel.waitFor({ state: 'visible' });
    await panel.locator('input').first().fill('Persisted Edit Name');
    await panel.getByRole('button', { name: 'Bartender', exact: true }).click();
    // Give the debounce-free sessionStorage-mirroring effect a tick to run.
    await page.waitForTimeout(200);

    await page.reload();
    await page.waitForSelector("text=Here's what we found.");

    // Collapsed row should show the restored name, not the original parse.
    await expect(page.getByText('Persisted Edit Name')).toBeVisible();

    // Re-expand and confirm the Role chip selection was restored too.
    const headerAfterReload = page.locator('div[role="button"]').first();
    await headerAfterReload.click();
    const panelAfterReload = headerAfterReload.locator('xpath=following-sibling::div[1]');
    await panelAfterReload.waitFor({ state: 'visible' });
    await expect(panelAfterReload.locator('input').first()).toHaveValue('Persisted Edit Name');
    await expect(panelAfterReload.locator('[data-role-chip-active="true"]')).toHaveText('Bartender');

    // Clear the restored edit's flag, resolve any remaining rows, and confirm
    // for real — proves the restored edit actually reaches the server, not
    // just the UI.
    await panelAfterReload.getByRole('button', { name: /Looks right|Done/ }).click();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const confirmBtn = page.getByRole('button', { name: /Confirm & Continue|Review \d+ flagged first/ });
      const label = (await confirmBtn.textContent())?.trim() ?? '';
      if (label.startsWith('Confirm & Continue')) break;
      const h = page.locator('div[role="button"]').first();
      await h.click();
      const p = h.locator('xpath=following-sibling::div[1]');
      await p.waitFor({ state: 'visible' });
      await p.getByRole('button', { name: /Looks right|Done/ }).click();
    }

    const confirmResponsePromise = page.waitForResponse((res) => res.url().includes('/confirm'));
    await page.getByRole('button', { name: 'Confirm & Continue' }).click();
    const confirmBody = (await (await confirmResponsePromise).json()) as { createdCount: number };
    expect(confirmBody.createdCount).toBeGreaterThan(0);
    await page.waitForURL('**/onboarding/invite**');

    // A brand-new venue has no existing staff for a parsed roster name to
    // match, so confirm never creates a User here (that only happens later,
    // when the person self-onboards via the invite link) — it creates the
    // Shift and, since "Bartender" wasn't yet a real Role for this venue,
    // auto-creates that Role too. THAT is the real, unambiguous proof the
    // restored edit reached the server: this Role would not exist at all if
    // the reload had silently dropped the edit.
    const org = await prisma.organization.findFirst({ where: { name: venueName } });
    const loc = await prisma.location.findFirst({ where: { organizationId: org?.id } });
    const role = await prisma.role.findFirst({ where: { locationId: loc?.id, name: 'Bartender' } });
    expect(role).toBeTruthy();
  });
});
