import { test, expect, type Page } from '@playwright/test';
import { cleanupTestOrgs, continueThroughVenue, prisma, seedVenueWithRoles, signInAs, signupNewVenue, testVenueName } from './helpers';

/**
 * Venue step: the venue-name summary + Rename control. The summary collapses
 * back as soon as the input blurs — which is right — but the fallback input
 * shown when the name is EMPTY must behave like a real edit field: typing
 * into it must not flip it back into the summary after the first character.
 */
test.describe('onboarding — venue name summary + rename', () => {
  test.afterEach(async ({ page }) => {
    await page.close().catch(() => {});
    await cleanupTestOrgs();
  });

  test('clearing the name, then typing a new one, keeps the input open until blur and persists on Continue', async ({ page }) => {
    const venueName = testVenueName('venue-rename');
    await signupNewVenue(page, venueName);
    await page.waitForSelector('text=Tell us about the room.');
    await expect(page.getByRole('main').getByText(venueName, { exact: true })).toBeVisible();

    // Rename → input prefilled; clear it; blur. Empty name means the input
    // stays (there is no summary to click Rename on) and Continue is gated.
    await page.getByRole('button', { name: 'Rename' }).click();
    const input = page.getByPlaceholder('e.g. Sefarina, DIFC');
    await expect(input).toHaveValue(venueName);
    await input.fill('');
    await input.blur();
    await expect(input).toBeVisible();
    await page.getByRole('button', { name: 'Dubai' }).click();
    await page.getByRole('button', { name: 'Fine Dining' }).click();
    const cont = page.getByRole('button', { name: 'Continue', exact: true });
    await expect(cont).toBeDisabled();

    // Type a new name character by character, the way a person does. The
    // input must still be there (and focused) after the first keystroke.
    const renamed = `${venueName} renamed`;
    await input.click();
    await input.pressSequentially(renamed);
    await expect(input).toBeVisible();
    await expect(input).toHaveValue(renamed);
    await expect(input).toBeFocused();

    // Blur collapses to the summary showing the new name; Continue persists it.
    await input.blur();
    await expect(page.getByRole('main').getByText(renamed, { exact: true })).toBeVisible();
    await expect(cont).toBeEnabled();
    await cont.click();
    await page.waitForURL('**/onboarding/roster**');
    const loc = await prisma.location.findFirst({ where: { name: renamed } });
    expect(loc).not.toBeNull();
  });
});

/**
 * The app header reads the venue name from one place (AppStateContext, fed by
 * Location.name). A rename must show there at once, on every screen, without
 * a reload — a reload would hide exactly the stale-header bug these guard
 * against, so each test marks the document and checks it is still the same
 * one at the end.
 */
async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __sameDocument?: boolean }).__sameDocument = true;
  });
}
async function expectSameDocument(page: Page): Promise<void> {
  expect(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument === true), 'the page must not have reloaded').toBe(true);
}

test.describe('venue rename — the app header follows without a reload', () => {
  test.afterEach(async ({ page }) => {
    await page.close().catch(() => {});
    await cleanupTestOrgs();
  });

  test('a rename in the Venue step shows in the header right after Continue and after Finish', async ({ page }) => {
    const original = testVenueName('header-signup-name');
    const renamed = testVenueName('casa-lumen');
    await signupNewVenue(page, original);
    const banner = page.getByRole('banner');
    await expect(banner).toContainText(original);
    await markDocument(page);

    await page.getByRole('button', { name: 'Rename' }).click();
    await page.getByPlaceholder('e.g. Sefarina, DIFC').fill(renamed);
    await continueThroughVenue(page);
    await expect(banner).toContainText(renamed);
    await expect(banner).not.toContainText(original);

    await page.getByRole('button', { name: /Skip for now/ }).click();
    await page.waitForSelector('text=Venue join-link', { timeout: 15000 });
    await page.getByRole('button', { name: 'Finish setup' }).click();
    await page.waitForURL(/\/$/, { timeout: 10000 });
    await expect(banner).toContainText(renamed);
    await expect(banner).not.toContainText(original);
    await expectSameDocument(page);
  });

  for (const role of ['OWNER', 'MANAGER'] as const) {
    test(`${role.toLowerCase()} renames the venue on Profile; the header changes at once, on every screen`, async ({ page }) => {
      const { venueName, locationId, sessions } = await seedVenueWithRoles(`settings-${role.toLowerCase()}`);
      const renamed = testVenueName(`casa-lumen-${role.toLowerCase()}`);
      await signInAs(page, sessions[role].stored, '/profile');
      const banner = page.getByRole('banner');
      await expect(banner).toContainText(venueName);
      await markDocument(page);

      const panel = page.getByTestId('venue-settings');
      await expect(panel.getByRole('heading', { name: venueName })).toBeVisible();
      await panel.getByRole('button', { name: 'Rename venue' }).click();
      const input = panel.getByLabel('Venue name');
      await expect(input).toHaveValue(venueName);
      await expect(input).toBeFocused();
      const save = panel.getByRole('button', { name: 'Save' });
      await expect(save).toBeDisabled(); // unchanged
      await input.fill('   ');
      await expect(save).toBeDisabled(); // blank
      await input.fill(`  ${renamed}  `);
      await save.click();

      await expect(panel.getByRole('status')).toHaveText('Venue name saved.');
      await expect(panel.getByRole('heading', { name: renamed })).toBeVisible();
      await expect(banner).toContainText(renamed);
      await expect(banner).not.toContainText(venueName);

      // Another screen, reached in-app: still the new name.
      await page.getByRole('link', { name: 'Open My Shifts' }).click();
      await page.waitForURL('**/my-shifts');
      await expect(banner).toContainText(renamed);
      await expectSameDocument(page);
      expect((await prisma.location.findUniqueOrThrow({ where: { id: locationId } })).name).toBe(renamed);
    });
  }

  test('staff see no venue setting, and a rename made on another device shows once their window regains focus', async ({ page }) => {
    const { venueName, locationId, sessions } = await seedVenueWithRoles('settings-staff');
    await signInAs(page, sessions.STAFF.stored, '/profile');
    const banner = page.getByRole('banner');
    await expect(banner).toContainText(venueName);
    await expect(page.getByTestId('delete-account')).toBeVisible();
    await expect(page.getByTestId('venue-settings')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Rename venue' })).toHaveCount(0);

    // The API refuses staff as well.
    const refused = await page.request.patch(`/api/locations/${locationId}`, {
      headers: { Authorization: `Bearer ${sessions.STAFF.token}` },
      data: { name: testVenueName('staff-rename') },
    });
    expect(refused.status()).toBe(403);

    // A manager renames from their own phone; this window picks it up on focus.
    await markDocument(page);
    const renamed = testVenueName('casa-lumen-elsewhere');
    const ok = await page.request.patch(`/api/locations/${locationId}`, {
      headers: { Authorization: `Bearer ${sessions.MANAGER.token}` },
      data: { name: renamed },
    });
    expect(ok.status()).toBe(200);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(banner).toContainText(renamed);
    await expectSameDocument(page);
  });
});
