import { test, expect } from '@playwright/test';
import { cleanupTestOrgs, continueThroughVenue, prisma, signupNewVenue, testVenueName } from './helpers';

/**
 * People → Staff Directory, as a fresh venue owner: add a member, edit a
 * field inline. Also asserts the page stays free of React runtime warnings —
 * the directory used to notify AppStateProvider from inside a setState
 * updater, which React reports as a setState-during-render error.
 */
test.describe('people — staff directory', () => {
  test.afterEach(async ({ page }) => {
    await page.close().catch(() => {});
    await cleanupTestOrgs();
  });

  test('adding and editing a staff member updates the table without React render warnings', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('pageerror', (e) => consoleErrors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });

    const venueName = testVenueName('staff-directory');
    await signupNewVenue(page, venueName);
    await continueThroughVenue(page);
    await page.getByRole('button', { name: /Skip for now/ }).click();
    await page.waitForSelector('text=Venue join-link', { timeout: 15000 });
    await page.getByRole('button', { name: /Skip — invite later/ }).click();
    await page.getByRole('button', { name: 'Continue to Dashboard' }).click();
    await page.waitForURL(/\/$/, { timeout: 10000 });

    await page.goto('/people');
    const toggle = page.getByRole('button', { name: /Staff Directory/ });
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();

    await page.getByPlaceholder('Full name').fill('Layla Directory');
    await page.getByPlaceholder(/Job title/).fill('Bartender');
    await page.getByRole('button', { name: 'Add staff member' }).click();
    await expect(page.getByRole('cell', { name: 'Layla Directory' })).toBeVisible();

    // Inline edit persists on blur.
    const row = page.getByRole('row', { name: /Layla Directory/ });
    const phone = row.locator('input').nth(1);
    await phone.fill('+971501112233');
    await phone.blur();
    await expect.poll(async () => (await prisma.user.findFirst({ where: { fullName: 'Layla Directory' } }))?.phone, { timeout: 10000 }).toBe('+971501112233');

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
  });
});
