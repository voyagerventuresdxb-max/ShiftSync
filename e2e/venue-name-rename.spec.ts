import { test, expect } from '@playwright/test';
import { cleanupTestOrgs, prisma, signupNewVenue, testVenueName } from './helpers';

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
