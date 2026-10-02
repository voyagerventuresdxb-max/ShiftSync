import { test, expect } from '@playwright/test';
import { cleanupTestOrgs, continueThroughVenue, signupNewVenue, testVenueName } from './helpers';

/**
 * The API as production runs it today: no VAPID keys (playwright.config.ts
 * blanks them). People must say push is off instead of offering a button that
 * prompts for permission and then fails, the push routes must answer without
 * a 500, and the page must log no errors.
 */
test.describe('push — server without VAPID keys', () => {
  test.afterEach(async ({ page }) => {
    await page.close().catch(() => {});
    await cleanupTestOrgs();
  });

  test('People shows push as not switched on, no Enable button, routes answer, no page errors', async ({ page, context }) => {
    // Already-granted permission must not resurrect the Enable button either.
    await context.grantPermissions(['notifications']);
    const consoleErrors: string[] = [];
    page.on('pageerror', (e) => consoleErrors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });

    await signupNewVenue(page, testVenueName('push-unavailable'));
    await continueThroughVenue(page);
    await page.getByRole('button', { name: /Skip for now/ }).click();
    await page.waitForSelector('text=Venue join-link', { timeout: 15000 });
    await page.getByRole('button', { name: /Skip — invite later/ }).click();
    await page.getByRole('button', { name: 'Continue to Dashboard' }).click();
    await page.waitForURL(/\/$/, { timeout: 10000 });

    await page.goto('/people');
    const panel = page.locator('section', { hasText: 'Notification preferences' });
    await expect(panel.getByText("Push notifications aren't switched on for ShiftSync yet.")).toBeVisible();
    await expect(panel.getByRole('button', { name: /Enable notifications/ })).toHaveCount(0);

    const key = await page.request.get('/api/push/vapid-public-key');
    expect(key.status()).toBe(200);
    expect(await key.json()).toEqual({ publicKey: '' });

    const token = await page.evaluate(() => JSON.parse(localStorage.getItem('shiftsync.session') ?? '{}').token as string);
    const headers = { Authorization: `Bearer ${token}` };
    const endpoint = `https://push.example.invalid/e2e-${Date.now()}`;
    expect((await page.request.post('/api/push/subscribe', { data: { endpoint } })).status()).toBe(401);
    expect((await page.request.post('/api/push/subscribe', { headers, data: { endpoint } })).status()).toBe(400);
    expect(
      (await page.request.post('/api/push/subscribe', { headers, data: { endpoint, keys: { p256dh: 'p', auth: 'a' } } })).status(),
    ).toBe(201);
    // Idempotent: the second delete finds nothing and still answers 204.
    expect((await page.request.delete('/api/push/subscribe', { headers, data: { endpoint } })).status()).toBe(204);
    expect((await page.request.delete('/api/push/subscribe', { headers, data: { endpoint } })).status()).toBe(204);

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
  });
});
