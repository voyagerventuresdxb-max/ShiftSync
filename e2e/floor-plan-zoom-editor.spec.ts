import { test, expect, type Page } from '@playwright/test';
import { cleanupTestOrgs, prisma, signupNewVenue, testVenueName } from './helpers';
import { Touch, planPointOnScreen, planZoom, seedBarDesPres, sessionFromPage } from './floorPlanFixture';

/**
 * Zoom/pan in the manager Sections/setup editor (Konva). The point of this
 * spec: a section drawn while zoomed in must save the SAME plan geometry as
 * one drawn at 1x — points are read in plan coordinates
 * (getRelativePointerPosition), never screen coordinates.
 */

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const TRIANGLE = [
  { x: 0.42, y: 0.62 },
  { x: 0.6, y: 0.64 },
  { x: 0.5, y: 0.74 },
];

async function openEditor(page: Page): Promise<void> {
  await page.goto('/floor-plan');
  await page.waitForSelector('.fp-canvas-wrap img');
  await page.getByRole('button', { name: 'Sections', exact: true }).click();
  await page.waitForSelector('.fp-canvas-wrap canvas');
  await page.locator('.fp-canvas-wrap').scrollIntoViewIfNeeded();
  await page.waitForTimeout(800); // plan image decode into the Konva layer
}

/** Draws TRIANGLE by clicking its plan-space corners at their current screen positions; returns those screen points. */
async function drawTriangle(page: Page, label: string): Promise<Array<{ x: number; y: number }>> {
  await page.getByRole('button', { name: '+ Draw section' }).click();
  const screen: Array<{ x: number; y: number }> = [];
  for (const p of TRIANGLE) {
    const s = await planPointOnScreen(page, p.x, p.y);
    screen.push(s);
    await page.mouse.click(s.x, s.y);
  }
  await page.getByRole('button', { name: /Close shape \(3 pts\)/ }).click();
  await page.getByPlaceholder('Label (e.g. Section 1)').fill(label);
  await page.getByPlaceholder('Pax capacity').fill('6');
  const saved = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/api/floor-plan/sections'));
  // Keyboard activation, not a tap: at phone size the pre-existing "New
  // section" dialog bug (issue #47) leaves the fields covering "Save section".
  // Switch back to .click() once #47 is fixed.
  await page.getByRole('button', { name: 'Save section' }).focus();
  await page.keyboard.press('Enter');
  expect((await saved).ok()).toBeTruthy();
  return screen;
}

test.describe('floor plan — zoom/pan in the setup editor', () => {
  test.afterEach(async ({ page }) => {
    await page.close().catch(() => {});
    await cleanupTestOrgs();
  });

  test('a section drawn at 2x (zoomed and panned) saves the same geometry as one drawn at 1x', async ({ page }) => {
    test.setTimeout(180_000);
    await signupNewVenue(page, testVenueName('floor-plan-zoom-editor'));
    await seedBarDesPres(page);
    await openEditor(page);
    const touch = await Touch.open(page);

    const at1x = await drawTriangle(page, 'Drawn at 1x');
    expect(await planZoom(page)).toBe(1);

    // Zoom to 2x and pan, so the same plan points sit somewhere else on screen.
    const wrap = (await page.locator('.fp-canvas-wrap').boundingBox())!;
    const mid = { x: wrap.x + wrap.width / 2, y: wrap.y + wrap.height / 2 };
    await touch.pinch(mid, 60, 120, { x: mid.x + 80, y: mid.y - 60 });
    expect(await planZoom(page)).toBeGreaterThan(1.8);
    await expect(page.getByRole('button', { name: 'Reset zoom' })).toBeVisible();

    // While drawing, one finger must place points, not pan.
    await page.getByRole('button', { name: '+ Draw section' }).click();
    const before = await page.locator('.fp-canvas-wrap').getAttribute('data-plan-x');
    await touch.drag({ x: mid.x, y: mid.y }, { x: mid.x - 60, y: mid.y });
    expect(await page.locator('.fp-canvas-wrap').getAttribute('data-plan-x')).toBe(before);
    await page.getByRole('button', { name: 'Cancel' }).first().click();

    const at2x = await drawTriangle(page, 'Drawn at 2x');
    for (let i = 0; i < TRIANGLE.length; i++) {
      expect(Math.hypot(at2x[i]!.x - at1x[i]!.x, at2x[i]!.y - at1x[i]!.y), `corner ${i} moved on screen`).toBeGreaterThan(20);
    }

    const { locationId } = await sessionFromPage(page);
    const rows = await prisma.floorSection.findMany({ where: { locationId, label: { in: ['Drawn at 1x', 'Drawn at 2x'] } } });
    const poly = (label: string) => rows.find((r) => r.label === label)!.polygon as Array<{ x: number; y: number }>;
    const one = poly('Drawn at 1x');
    const two = poly('Drawn at 2x');
    expect(one).toHaveLength(3);
    expect(two).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      // Both match the intended plan points (≤1.3px at 316px wide) — and each other.
      expect(Math.abs(one[i]!.x - TRIANGLE[i]!.x)).toBeLessThan(0.004);
      expect(Math.abs(one[i]!.y - TRIANGLE[i]!.y)).toBeLessThan(0.004);
      expect(Math.abs(two[i]!.x - one[i]!.x)).toBeLessThan(0.004);
      expect(Math.abs(two[i]!.y - one[i]!.y)).toBeLessThan(0.004);
    }
  });
});
