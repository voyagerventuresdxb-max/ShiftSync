import { test, expect, devices } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { cleanupTestOrgs, nextEchoPhone, prisma, testVenueName } from './helpers';

/**
 * iPhone / PWA basics, emulated on Chromium with an iPhone descriptor
 * (viewport, device scale, touch, Safari user agent). Real WebKit is not
 * installed in this sandbox, so what is asserted is what any engine renders
 * the same: the manifest and Apple meta tags, 16px form controls at phone
 * width (iOS Safari zooms on anything smaller), the viewport-fit=cover
 * viewport, the Home-Screen install hint on an iPhone without PushManager,
 * and that a first-run image upload never returns a sample roster when the
 * AI reader is unavailable.
 */
const iphone = devices['iPhone 13'];
test.use({
  ...iphone,
  // The descriptor asks for WebKit; this project runs Chromium.
  defaultBrowserType: 'chromium',
});

const usedPhones: string[] = [];

test.describe('iPhone / PWA', () => {
  test.afterEach(async () => {
    await cleanupTestOrgs();
    await prisma.otpCode.deleteMany({ where: { phone: { in: usedPhones.splice(0) } } });
  });

  test('manifest, Apple meta, viewport-fit=cover and 16px controls at phone width', async ({ page, request }) => {
    const manifest = await request.get('/manifest.webmanifest');
    expect(manifest.status()).toBe(200);
    const body = (await manifest.json()) as { display: string; start_url: string; icons: { src: string; sizes: string }[] };
    expect(body.display).toBe('standalone');
    expect(body.start_url).toBe('/');
    expect(body.icons.some((i) => i.sizes === '512x512')).toBe(true);
    for (const icon of ['/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon-180.png']) {
      expect((await request.get(icon)).status(), icon).toBe(200);
    }

    await page.goto('/login');
    expect(await page.locator('meta[name=viewport]').getAttribute('content')).toContain('viewport-fit=cover');
    expect(await page.locator('link[rel=manifest]').getAttribute('href')).toBe('/manifest.webmanifest');
    expect(await page.locator('link[rel=apple-touch-icon]').getAttribute('href')).toBe('/icons/apple-touch-icon-180.png');
    expect(await page.locator('meta[name=apple-mobile-web-app-capable]').getAttribute('content')).toBe('yes');
    expect(await page.locator('meta[name=apple-mobile-web-app-status-bar-style]').getAttribute('content')).toBe('black-translucent');

    // Every text control on the login screen is at least 16px at 390px wide.
    const sizes = await page.locator('input, select, textarea').evaluateAll((els) => els.map((el) => parseFloat(getComputedStyle(el).fontSize)));
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) expect(size).toBeGreaterThanOrEqual(16);

    // The page is laid out with the dynamic viewport height (dvh), never under the toolbar.
    const minHeight = await page.evaluate(() => getComputedStyle(document.documentElement).minHeight);
    expect(minHeight).toBe(`${iphone.viewport.height}px`);
  });

  test('on an iPhone without PushManager, notification settings explain Add to Home Screen instead of "not supported"', async ({ browser }) => {
    const phone = nextEchoPhone();
    usedPhones.push(phone);
    const org = await prisma.organization.create({ data: { name: testVenueName('iphone-push') } });
    const location = await prisma.location.create({ data: { organizationId: org.id, name: org.name } });
    await prisma.user.create({ data: { locationId: location.id, systemRole: 'OWNER', fullName: 'iPhone Owner', phone } });

    const context = await browser.newContext({ ...iphone });
    // iOS Safari in a tab has no PushManager; Chromium does, so take it away.
    await context.addInitScript(() => {
      delete (window as unknown as { PushManager?: unknown }).PushManager;
    });
    const page = await context.newPage();
    try {
      await page.goto('/login');
      await page.getByPlaceholder('Phone number').fill(phone);
      await page.getByRole('button', { name: 'Send code' }).click();
      const code = (await page.locator('p.hint .font-mono').innerText()).trim();
      await page.getByPlaceholder('6-digit code').fill(code);
      await page.getByRole('button', { name: 'Verify & log in' }).click();
      await page.waitForURL((url) => url.pathname === '/');
      await page.goto('/people');
      await expect(page.getByText('Add to Home Screen')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("aren't supported in this browser")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('first run: an image roster with no AI reader available is refused clearly, never answered with a sample roster', async ({ request }) => {
    const org = await prisma.organization.create({ data: { name: testVenueName('iphone-no-sample') } });
    const location = await prisma.location.create({ data: { organizationId: org.id, name: org.name } });
    const owner = await prisma.user.create({ data: { locationId: location.id, systemRole: 'OWNER', fullName: 'No Sample Owner' } });
    // A real session row, the way the server stores one (sha256 of the token).
    const plainToken = randomBytes(32).toString('hex');
    await prisma.session.create({ data: { userId: owner.id, tokenHash: createHash('sha256').update(plainToken).digest('hex'), expiresAt: new Date(Date.now() + 3600_000) } });
    // A 1x1 PNG, the smallest valid image an iPhone camera path could produce.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const res = await request.post('/api/schedules/upload', {
      headers: { Authorization: `Bearer ${plainToken}` },
      multipart: { file: { name: 'roster-photo.png', mimeType: 'image/png', buffer: png } },
    });
    expect(res.status()).toBe(422);
    const body = (await res.json()) as { error: string; errorCode?: string; preview?: unknown };
    expect(body.preview).toBeUndefined();
    expect(body.errorCode).toBe('vision_unconfigured');
    expect(body.error).toMatch(/Excel|CSV|try again|unavailable|not configured/i);
    expect(JSON.stringify(body)).not.toMatch(/Kalim|Fallback sample/);
    expect(await prisma.shift.count({ where: { locationId: location.id } })).toBe(0);
  });
});
