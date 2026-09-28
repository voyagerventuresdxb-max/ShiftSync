import { test, expect } from '@playwright/test';
import { cleanupTestOrgs, signupNewVenue, testVenueName } from './helpers';
import { BAR_DES_PRES_SECTIONS, Touch, planZoom, seedBarDesPres } from './floorPlanFixture';

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

  test('zooming into the crowded Sec 6/7/8 cluster separates pins that overlap at 1x', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await signupNewVenue(page, testVenueName('floor-plan-pins-zoom'));
    await seedBarDesPres(page);

    await page.goto('/floor-plan');
    await page.waitForSelector('.fp-canvas-wrap img');
    await page.locator('.fp-canvas-wrap').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const wrapEl = page.locator('.fp-canvas-wrap');
    const wrap = (await wrapEl.boundingBox())!;
    const cluster = ['Section 6', 'Section 7', 'Section 8'];
    const boxes = async () => Promise.all(cluster.map(async (l) => (await page.locator(`[data-section-pin="${l}"]`).boundingBox())!));
    const overlapping = (b: Array<{ x: number; y: number; width: number; height: number }>) => {
      const pairs: string[] = [];
      for (let i = 0; i < b.length; i++)
        for (let j = i + 1; j < b.length; j++) {
          const [p, q] = [b[i]!, b[j]!];
          if (p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height) pairs.push(`${cluster[i]}↔${cluster[j]}`);
        }
      return pairs;
    };

    // The problem this feature exists for: at 1x these pins overlap.
    const at1x = await boxes();
    expect(overlapping(at1x), 'Sec 6/7/8 pins overlap at 1x').not.toEqual([]);
    await wrapEl.screenshot({ path: testInfo.outputPath('cluster-1x.png') });

    // Pinch 2.5x with the fingers' midpoint travelling from the cluster to the centre of the plan.
    const cx = at1x.reduce((n, b) => n + b.x + b.width / 2, 0) / at1x.length;
    const cy = at1x.reduce((n, b) => n + b.y + b.height / 2, 0) / at1x.length;
    const touch = await Touch.open(page);
    await touch.pinch({ x: cx, y: cy }, 40, 100, { x: wrap.x + wrap.width / 2, y: wrap.y + wrap.height / 2 });
    expect(await planZoom(page)).toBeCloseTo(2.5, 1);
    await page.waitForTimeout(200);
    await wrapEl.screenshot({ path: testInfo.outputPath('cluster-2.5x.png') });

    // Zoomed: no two cluster pins overlap, each is fully in view, and each opens its own section.
    const zoomed = await boxes();
    expect(overlapping(zoomed), 'Sec 6/7/8 pins still overlap after zooming in').toEqual([]);
    for (let i = 0; i < cluster.length; i++) {
      const b = zoomed[i]!;
      expect(b.width, `${cluster[i]} pin keeps its on-screen size`).toBeCloseTo(at1x[i]!.width, 0);
      expect(b.x).toBeGreaterThanOrEqual(wrap.x - 0.5);
      expect(b.y).toBeGreaterThanOrEqual(wrap.y - 0.5);
      expect(b.x + b.width).toBeLessThanOrEqual(wrap.x + wrap.width + 0.5);
      expect(b.y + b.height).toBeLessThanOrEqual(wrap.y + wrap.height + 0.5);
      await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
      await expect(page.locator('.fp-picker h3'), `${cluster[i]}: tap while zoomed`).toHaveText(cluster[i]!);
      await page.getByRole('button', { name: 'Close' }).first().click();
      await expect(page.locator('.fp-picker')).toHaveCount(0);
    }
  });
});
