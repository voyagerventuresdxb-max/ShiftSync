import { test, expect } from '@playwright/test';
import { cleanupTestOrgs, seedVenueWithRoles, signInAs } from './helpers';

/**
 * Run 17 UI fixes: a disabled shared button looks disabled (and gives no hover or press feedback),
 * and the join link's "Expires after" picker is drawn with the app's colours instead of the
 * browser's white box (Safari showed near-invisible text).
 */

test.use({ viewport: { width: 390, height: 844 } });
test.afterEach(async ({ page }) => {
  await page.close().catch(() => {});
  await cleanupTestOrgs();
});

const look = (el: import('@playwright/test').Locator) =>
  el.evaluate((b) => {
    const s = getComputedStyle(b);
    return { opacity: s.opacity, cursor: s.cursor, filter: s.filter, width: b.getBoundingClientRect().width, height: b.getBoundingClientRect().height };
  });

test('a disabled shared button is dimmed with a not-allowed cursor; enabled again it is full strength, same size', async ({ page }) => {
  await page.goto('/login');
  const send = page.getByRole('button', { name: 'Send code' });
  await expect(send).toBeDisabled();
  const off = await look(send);
  expect(off.opacity).toBe('0.5');
  expect(off.cursor).toBe('not-allowed');
  // No hover feedback while disabled.
  await send.hover({ force: true });
  expect((await look(send)).filter).toBe('none');
  await page.getByPlaceholder('Phone number').fill('+971500000000');
  await expect(send).toBeEnabled();
  const on = await look(send);
  expect(on.opacity).toBe('1');
  expect(on.cursor).toBe('pointer');
  // The layout doesn't move between the two.
  expect(on.width).toBe(off.width);
  expect(on.height).toBe(off.height);
});

test("the join link's Expires after picker uses the app's surface and text colours, not the browser's own box", async ({ page }) => {
  const v = await seedVenueWithRoles('r17-picker');
  await signInAs(page, v.sessions.OWNER.stored, '/people');
  const picker = page.getByRole('combobox').filter({ has: page.locator('option', { hasText: '30 days' }) }).first();
  await picker.waitFor();
  const s = await picker.evaluate((el) => {
    const c = getComputedStyle(el);
    return { appearance: c.appearance || c.webkitAppearance, background: c.backgroundColor, color: c.color, scheme: c.colorScheme, chevron: c.backgroundImage.includes('svg') };
  });
  expect(s.appearance).toBe('none');
  expect(s.background).toBe('rgb(30, 30, 40)');
  expect(s.color).toBe('rgb(224, 224, 224)');
  expect(s.scheme).toBe('dark');
  expect(s.chevron).toBe(true);
  // Still a real select: picking another value works (an iPhone opens its own picker on tap).
  await picker.selectOption({ label: '7 days' });
  await expect(picker).toHaveValue('7');
});
