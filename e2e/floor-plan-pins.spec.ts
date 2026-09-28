import { test, expect } from '@playwright/test';
import { cleanupTestOrgs, signupNewVenue, testVenueName } from './helpers';
import { BAR_DES_PRES_SECTIONS, seedBarDesPres } from './floorPlanFixture';

/**
 * Floor-plan section pins at phone width (2026-09-29 correctness fix).
 *
 * The 8 Bar des Prés sections (e2e/floorPlanFixture.ts). At 390px the
 * whole plan is ~316x179px and several polygons are only 21–28px tall, so
 * the ~48px pin stack centred on the
 * centroid used to spill outside its polygon: the part outside was clipped
 * by the polygon's clip-path (unpainted AND untappable) — 4 of these 8 pins
 * opened nothing when tapped at their own visual centre. Pins near the plan
 * edge were also cut off by the canvas wrap.
 *
 * Every pin must render entirely inside the plan, be painted where it
 * renders, and open ITS OWN SectionDetail on a real touch tap at its visual
 * centre (and at the centre of its "Sec N" badge).
 */

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test.describe('floor plan — section pins at phone width', () => {
  test.afterEach(async ({ page }) => {
    await page.close().catch(() => {});
    await cleanupTestOrgs();
  });

  test('all 8 Bar des Prés pins render inside the plan and open their own SectionDetail on a centre tap', async ({ page }) => {
    test.setTimeout(180_000);
    await signupNewVenue(page, testVenueName('floor-plan-pins'));
    await seedBarDesPres(page);

    await page.goto('/floor-plan');
    await page.waitForSelector('.fp-canvas-wrap img');
    await page.locator('.fp-canvas-wrap').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const wrap = (await page.locator('.fp-canvas-wrap').boundingBox())!;

    for (const { label } of BAR_DES_PRES_SECTIONS) {
      const pin = page.locator(`[data-section-pin="${label}"]`);
      const box = (await pin.boundingBox())!;
      expect(box, `${label} pin rendered`).toBeTruthy();

      // Renders entirely inside the plan (nothing cut off by the canvas wrap).
      expect(box.x, `${label} left edge inside plan`).toBeGreaterThanOrEqual(wrap.x - 0.5);
      expect(box.y, `${label} top edge inside plan`).toBeGreaterThanOrEqual(wrap.y - 0.5);
      expect(box.x + box.width, `${label} right edge inside plan`).toBeLessThanOrEqual(wrap.x + wrap.width + 0.5);
      expect(box.y + box.height, `${label} bottom edge inside plan`).toBeLessThanOrEqual(wrap.y + wrap.height + 0.5);

      const badge = (await pin.locator('span').first().boundingBox())!;
      const centres: Array<[string, number, number]> = [
        ['pin visual centre', box.x + box.width / 2, box.y + box.height / 2],
        ['"Sec" badge centre', badge.x + badge.width / 2, badge.y + badge.height / 2],
      ];
      for (const [where, x, y] of centres) {
        // Painted where it renders: the topmost element at that point is the pin itself.
        const topmostIsPin = await page.evaluate(
          ([px, py, l]) => !!document.elementFromPoint(px, py)?.closest(`[data-section-pin="${l}"]`),
          [x, y, label] as const,
        );
        expect(topmostIsPin, `${label}: ${where} is covered or clipped`).toBe(true);

        await page.touchscreen.tap(x, y);
        await expect(page.locator('.fp-picker h3'), `${label}: tap at ${where}`).toHaveText(label);
        await page.getByRole('button', { name: 'Close' }).first().click();
        await expect(page.locator('.fp-picker')).toHaveCount(0);
      }
    }
  });
});
