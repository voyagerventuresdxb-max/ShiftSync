import { test, expect } from '@playwright/test';

/**
 * A signed-out visit to /my-shifts offers a sign-in button. It used to link to
 * bare /join, which (no ?location=) renders the "missing venue information"
 * dead end instead of a way to log in.
 */
test.describe('my shifts — signed-out sign-in link', () => {
  test.afterEach(async ({ page }) => {
    await page.close().catch(() => {});
  });

  test('the sign-in button lands on the login screen, not the missing-venue dead end', async ({ page }) => {
    await page.goto('/my-shifts');
    await page.evaluate(() => localStorage.removeItem('shiftsync.session'));
    await page.reload();

    await page.getByRole('link', { name: 'Log in', exact: true }).click();
    // Either the login mode of /join or /login itself (where /join?mode=login redirects once /login exists).
    await page.waitForURL(/\/(join\?mode=login|login\?)/);
    await expect(page.getByRole('heading', { name: 'Log in to ShiftSync' })).toBeVisible();
    await expect(page.getByText('This link is missing venue information')).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get('returnTo')).toBe('/my-shifts');
  });
});
