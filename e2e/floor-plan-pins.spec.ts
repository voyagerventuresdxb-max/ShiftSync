import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { cleanupTestOrgs, signupNewVenue, testVenueName } from './helpers';

/**
 * Floor-plan section pins at phone width (2026-09-29 correctness fix).
 *
 * The 8 Bar des Prés sections, traced as irregular polygons (fractional
 * coords over the venue's 16:9 plan — e2e/fixtures/floor-plan.png has the
 * same 16:9 aspect, so the rendered geometry at 390px is identical to the
 * real 1440x810 plan). At 390px the whole plan is ~316x179px and several
 * polygons are only 21–28px tall, so the ~48px pin stack centred on the
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

const API = 'http://localhost:4000';

const BAR_DES_PRES_SECTIONS = [
  { label: 'Section 1', paxCapacity: 18, notes: 'Shade after 17:00', polygon: [{ x: 0.03, y: 0.36 }, { x: 0.12, y: 0.30 }, { x: 0.16, y: 0.42 }, { x: 0.10, y: 0.66 }, { x: 0.03, y: 0.62 }] },
  { label: 'Section 2', paxCapacity: 16, polygon: [{ x: 0.13, y: 0.22 }, { x: 0.29, y: 0.20 }, { x: 0.30, y: 0.40 }, { x: 0.15, y: 0.42 }] },
  { label: 'Section 3', paxCapacity: 15, polygon: [{ x: 0.16, y: 0.44 }, { x: 0.35, y: 0.44 }, { x: 0.35, y: 0.55 }, { x: 0.20, y: 0.56 }] },
  { label: 'Section 4', paxCapacity: 15, polygon: [{ x: 0.30, y: 0.22 }, { x: 0.48, y: 0.30 }, { x: 0.49, y: 0.44 }, { x: 0.31, y: 0.42 }] },
  { label: 'Section 5', paxCapacity: 15, polygon: [{ x: 0.49, y: 0.30 }, { x: 0.63, y: 0.30 }, { x: 0.71, y: 0.38 }, { x: 0.62, y: 0.44 }, { x: 0.50, y: 0.44 }] },
  { label: 'Section 6', paxCapacity: 16, polygon: [{ x: 0.71, y: 0.24 }, { x: 0.91, y: 0.22 }, { x: 0.93, y: 0.34 }, { x: 0.73, y: 0.36 }] },
  { label: 'Section 7', paxCapacity: 16, polygon: [{ x: 0.88, y: 0.36 }, { x: 0.97, y: 0.36 }, { x: 0.97, y: 0.66 }, { x: 0.86, y: 0.64 }] },
  { label: 'Section 8', paxCapacity: 14, polygon: [{ x: 0.73, y: 0.38 }, { x: 0.86, y: 0.38 }, { x: 0.87, y: 0.52 }, { x: 0.73, y: 0.54 }] },
];

async function seedBarDesPres(page: Page): Promise<void> {
  const raw = await page.evaluate(() => localStorage.getItem('shiftsync.session'));
  const session = JSON.parse(raw ?? 'null') as { token: string; user: { locationId: string } };
  const auth = { Authorization: `Bearer ${session.token}` };
  const fd = new FormData();
  fd.append('locationId', session.user.locationId);
  fd.append('file', new Blob([readFileSync(path.resolve('e2e/fixtures/floor-plan.png'))], { type: 'image/png' }), 'floor-plan.png');
  const up = await fetch(`${API}/api/floor-plan/upload`, { method: 'POST', headers: auth, body: fd });
  expect(up.ok, 'floor plan upload').toBeTruthy();
  const { image } = (await up.json()) as { image: { id: string } };
  for (const s of BAR_DES_PRES_SECTIONS) {
    const res = await fetch(`${API}/api/floor-plan/sections`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ locationId: session.user.locationId, floorPlanImageId: image.id, ...s }),
    });
    expect(res.ok, `create ${s.label}`).toBeTruthy();
  }
}

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
