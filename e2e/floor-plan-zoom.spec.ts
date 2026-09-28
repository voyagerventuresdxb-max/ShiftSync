import { test, expect, type Page } from '@playwright/test';
import { cleanupTestOrgs, prisma, signupNewVenue, testVenueName } from './helpers';
import { Touch, planPointOnScreen, planZoom, seedBarDesPres, sessionFromPage } from './floorPlanFixture';

/**
 * Pinch-to-zoom + pan on the Daily Assignment floor plan (planZoom.tsx),
 * driven with real multi-touch (CDP touch events) at 390x844, real backend.
 */

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function openBoard(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  await page.goto('/floor-plan');
  await page.waitForSelector('.fp-canvas-wrap img');
  await page.locator('.fp-canvas-wrap').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  return (await page.locator('.fp-canvas-wrap').boundingBox())!;
}

function centre(b: { x: number; y: number; width: number; height: number }) {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

test.describe('floor plan — pinch-to-zoom + pan (Daily Assignment)', () => {
  test.afterEach(async ({ page }) => {
    await page.close().catch(() => {});
    await cleanupTestOrgs();
  });

  test('pinch clamps between fit and 3x, one finger pans only once zoomed, taps still open the right section, reset works', async ({ page }) => {
    test.setTimeout(180_000);
    await signupNewVenue(page, testVenueName('floor-plan-zoom'));
    await seedBarDesPres(page);
    const wrap = await openBoard(page);
    const touch = await Touch.open(page);
    const mid = centre(wrap);

    // 1x: a one-finger drag does not pan the plan (the page keeps it).
    const layerAt1x = (await page.locator('.fp-canvas-wrap > div').first().boundingBox())!;
    const empty1x = await planPointOnScreen(page, 0.3, 0.8);
    await touch.drag(empty1x, { x: empty1x.x - 60, y: empty1x.y });
    expect(await planZoom(page)).toBe(1);
    expect((await page.locator('.fp-canvas-wrap > div').first().boundingBox())!.x).toBeCloseTo(layerAt1x.x, 0);
    await expect(page.getByRole('button', { name: 'Reset zoom' })).toHaveCount(0);

    // Mid zoom: fingers twice as far apart → 2x.
    await touch.pinch(mid, 60, 120);
    expect(await planZoom(page)).toBeGreaterThan(1.8);
    expect(await planZoom(page)).toBeLessThan(2.2);
    // Max: clamped at 3x however far the fingers spread.
    await touch.pinch(mid, 40, 400);
    expect(await planZoom(page)).toBe(3);
    // Min: clamped at fit (1x) — can't zoom out past the whole plan.
    await touch.pinch(mid, 300, 20);
    expect(await planZoom(page)).toBe(1);

    // Back to 2x: one finger on empty plan now pans.
    await touch.pinch(mid, 60, 120);
    const before = (await page.locator('.fp-canvas-wrap > div').first().boundingBox())!;
    const empty = await planPointOnScreen(page, 0.3, 0.7);
    await touch.drag(empty, { x: empty.x - 50, y: empty.y - 20 });
    const after = (await page.locator('.fp-canvas-wrap > div').first().boundingBox())!;
    expect(after.x - before.x).toBeCloseTo(-50, 0);
    expect(after.y - before.y).toBeCloseTo(-20, 0);

    // A pan that STARTS on a pin pans and does not open that section.
    const pin4 = (await page.locator('[data-section-pin="Section 4"]').boundingBox())!;
    const p4 = { x: pin4.x + pin4.width / 2, y: pin4.y + pin4.height / 2 };
    await touch.drag(p4, { x: p4.x + 40, y: p4.y });
    await page.waitForTimeout(300);
    await expect(page.locator('.fp-picker')).toHaveCount(0);

    // A tap on a pin at 2x opens its own section.
    const pin4b = (await page.locator('[data-section-pin="Section 4"]').boundingBox())!;
    await page.touchscreen.tap(pin4b.x + pin4b.width / 2, pin4b.y + pin4b.height / 2);
    await expect(page.locator('.fp-picker h3')).toHaveText('Section 4');
    await page.getByRole('button', { name: 'Close' }).first().click();

    // Visible reset control.
    await page.getByRole('button', { name: 'Reset zoom' }).tap();
    expect(await planZoom(page)).toBe(1);
    await expect(page.getByRole('button', { name: 'Reset zoom' })).toHaveCount(0);

    // Double-tap on empty plan also resets.
    await touch.pinch(mid, 60, 150);
    expect(await planZoom(page)).toBeGreaterThan(2);
    // Empty plan (no section, no pin) well inside the 2.5x viewport (visible range ≈ 0.3–0.7 of the plan).
    const emptyZoomed = await planPointOnScreen(page, 0.45, 0.65);
    await page.touchscreen.tap(emptyZoomed.x, emptyZoomed.y);
    await page.touchscreen.tap(emptyZoomed.x, emptyZoomed.y);
    await expect.poll(() => planZoom(page)).toBe(1);
  });

  test('a staff chip dropped on a section while zoomed and panned creates the assignment for THAT section', async ({ page }) => {
    test.setTimeout(180_000);
    await signupNewVenue(page, testVenueName('floor-plan-zoom-dnd'));
    await seedBarDesPres(page);
    const wrap = await openBoard(page);
    const touch = await Touch.open(page);

    // A point inside Section 4 only (not inside any other section's box).
    const target1x = await planPointOnScreen(page, 0.4, 0.36);
    // Zoom 2x while moving the pinch midpoint, so the section is both scaled and panned away from its 1x spot.
    const from = centre(wrap);
    await touch.pinch(from, 60, 120, { x: from.x - 30, y: from.y + 10 });
    expect(await planZoom(page)).toBeGreaterThan(1.8);
    const target = await planPointOnScreen(page, 0.4, 0.36);
    expect(Math.hypot(target.x - target1x.x, target.y - target1x.y), 'target moved on screen').toBeGreaterThan(30);
    expect(target.x).toBeGreaterThan(wrap.x);
    expect(target.x).toBeLessThan(wrap.x + wrap.width);
    expect(target.y).toBeGreaterThan(wrap.y);
    expect(target.y).toBeLessThan(wrap.y + wrap.height);

    const chip = page.locator('.fp-roster-strip > div').first();
    const staffName = (await chip.innerText()).split('\n').pop()!.trim();
    const c = (await chip.boundingBox())!;
    const assigned = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/api/floor-plan/assignments'));
    await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 15; i++) {
      await page.mouse.move(c.x + c.width / 2 + ((target.x - c.x - c.width / 2) * i) / 15, c.y + c.height / 2 + ((target.y - c.y - c.height / 2) * i) / 15);
    }
    await page.mouse.up();
    expect((await assigned).ok()).toBeTruthy();

    const { locationId } = await sessionFromPage(page);
    const rows = await prisma.sectionAssignment.findMany({
      where: { section: { locationId } },
      include: { section: true, staff: true },
    });
    expect(rows.map((r) => [r.section.label, r.staff.fullName])).toEqual([['Section 4', staffName]]);
  });
});
