import { test, expect, type Page } from '@playwright/test';
import { cleanupTestOrgs, prisma, signupNewVenue, testVenueName } from './helpers';
import { Touch, planPointOnScreen, planZoom, seedBarDesPres, sessionFromPage } from './floorPlanFixture';

/**
 * The Sections setup editor, pin-only (2026-09-29 — drawn polygon boundaries
 * were removed). Real backend, 390x844 touch, real multi-touch via CDP.
 * Every write is checked in the DB: a pin's saved position is the plan
 * fraction under the finger, whatever the zoom while placing or moving it.
 */

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

// Empty plan (no Bar des Prés pin nearby), as plan fractions.
const EMPTY_A = { x: 0.45, y: 0.8 };
const EMPTY_B = { x: 0.62, y: 0.86 };
const TOLERANCE = 0.006; // ≤ ~2px on the 316px-wide plan

async function openEditor(page: Page): Promise<void> {
  await page.goto('/floor-plan');
  await page.waitForSelector('.fp-canvas-wrap img');
  await page.getByRole('button', { name: 'Sections', exact: true }).click();
  await page.waitForSelector('.fp-editor .fp-canvas-wrap img');
  await page.locator('.fp-canvas-wrap').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
}

async function sectionRow(page: Page, label: string) {
  const { locationId } = await sessionFromPage(page);
  return prisma.floorSection.findFirst({ where: { locationId, label } });
}

async function pinCentre(page: Page, label: string): Promise<{ x: number; y: number }> {
  const b = (await page.locator(`[data-section-pin="${label}"]`).boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** Taps empty plan at a plan fraction and fills the New-section dialog. */
async function dropPin(page: Page, at: { x: number; y: number }, name: string, pax: string): Promise<void> {
  const p = await planPointOnScreen(page, at.x, at.y);
  await page.touchscreen.tap(p.x, p.y);
  const dialog = page.getByRole('dialog', { name: 'New section' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Section name').fill(name);
  await dialog.getByLabel('Pax capacity').fill(pax);
  const saved = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/api/floor-plan/sections'));
  await dialog.getByRole('button', { name: 'Add section' }).tap();
  expect((await saved).ok()).toBeTruthy();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(`[data-section-pin="${name}"]`)).toBeVisible();
}

function expectNear(actual: { pinX: number; pinY: number }, expected: { x: number; y: number }, what: string) {
  expect(Math.abs(actual.pinX - expected.x), `${what} x`).toBeLessThan(TOLERANCE);
  expect(Math.abs(actual.pinY - expected.y), `${what} y`).toBeLessThan(TOLERANCE);
}

test.describe('floor plan — Sections setup editor (pin-only)', () => {
  test.afterEach(async ({ page }) => {
    await page.close().catch(() => {});
    await cleanupTestOrgs();
  });

  test('tap to drop a pin — at 1x and at 2x (zoomed + panned) it saves the plan point under the finger', async ({ page }) => {
    test.setTimeout(180_000);
    await signupNewVenue(page, testVenueName('section-editor-create'));
    await seedBarDesPres(page);
    await openEditor(page);
    await expect(page.locator('.fp-editor [data-section-pin]')).toHaveCount(8);

    const at1x = await planPointOnScreen(page, EMPTY_A.x, EMPTY_A.y);
    await dropPin(page, EMPTY_A, 'Terrace', '6');
    expectNear((await sectionRow(page, 'Terrace'))!, EMPTY_A, 'pin dropped at 1x');
    // Drawn polygons are gone: a new section stores no boundary.
    expect((await sectionRow(page, 'Terrace'))!.polygon).toEqual([]);

    // Zoom 2x and pan, so the same plan point sits somewhere else on screen.
    const touch = await Touch.open(page);
    const wrap = (await page.locator('.fp-canvas-wrap').boundingBox())!;
    const mid = { x: wrap.x + wrap.width / 2, y: wrap.y + wrap.height / 2 };
    await touch.pinch(mid, 60, 120, { x: mid.x - 20, y: mid.y - 50 });
    expect(await planZoom(page)).toBeGreaterThan(1.8);
    const at2x = await planPointOnScreen(page, EMPTY_B.x, EMPTY_B.y);
    // Inside the visible plan, and clear of the bottom-right Reset-zoom button.
    expect(at2x.x).toBeGreaterThan(wrap.x);
    expect(at2x.x).toBeLessThan(wrap.x + wrap.width - 50);
    expect(at2x.y).toBeGreaterThan(wrap.y);
    expect(at2x.y).toBeLessThan(wrap.y + wrap.height);
    await dropPin(page, EMPTY_B, 'Garden', '4');
    expectNear((await sectionRow(page, 'Garden'))!, EMPTY_B, 'pin dropped at 2x');
    expect(Math.hypot(at2x.x - at1x.x, at2x.y - at1x.y), 'the two taps were far apart on screen').toBeGreaterThan(20);
  });

  test('drag a pin to move it (1x and 2x) — saves the new point, never pans, never opens the pin', async ({ page }) => {
    test.setTimeout(180_000);
    await signupNewVenue(page, testVenueName('section-editor-drag'));
    await seedBarDesPres(page);
    await openEditor(page);
    await dropPin(page, EMPTY_A, 'Terrace', '6');
    const touch = await Touch.open(page);

    // 1x drag.
    const to1 = await planPointOnScreen(page, EMPTY_B.x, EMPTY_B.y);
    const moved = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes('/api/floor-plan/sections/'));
    await touch.drag(await pinCentre(page, 'Terrace'), to1);
    expect((await moved).ok()).toBeTruthy();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expectNear((await sectionRow(page, 'Terrace'))!, EMPTY_B, 'dragged at 1x');

    // A pinch whose fingers both start ON a pin zooms the plan — the pinch
    // wins over the pin drag — and the pin stays where it was.
    const beforePinch = (await sectionRow(page, 'Terrace'))!;
    await touch.pinch(await pinCentre(page, 'Terrace'), 12, 26);
    expect(await planZoom(page)).toBeGreaterThan(1.8);
    await page.waitForTimeout(300);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const afterPinch = (await sectionRow(page, 'Terrace'))!;
    expect(afterPinch.pinX).toBe(beforePinch.pinX);
    expect(afterPinch.pinY).toBe(beforePinch.pinY);

    // 2x: dragging a pin must move the pin, not the plan.
    const wrap = (await page.locator('.fp-canvas-wrap').boundingBox())!;
    const viewBefore = await page.locator('.fp-canvas-wrap').getAttribute('data-plan-x');
    const target = { x: 0.55, y: 0.78 };
    const to2 = await planPointOnScreen(page, target.x, target.y);
    expect(to2.x).toBeGreaterThan(wrap.x);
    expect(to2.x).toBeLessThan(wrap.x + wrap.width - 50);
    expect(to2.y).toBeGreaterThan(wrap.y);
    expect(to2.y).toBeLessThan(wrap.y + wrap.height);
    const moved2 = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes('/api/floor-plan/sections/'));
    await touch.drag(await pinCentre(page, 'Terrace'), to2);
    expect((await moved2).ok()).toBeTruthy();
    expect(await page.locator('.fp-canvas-wrap').getAttribute('data-plan-x'), 'plan did not pan').toBe(viewBefore);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expectNear((await sectionRow(page, 'Terrace'))!, target, 'dragged at 2x');

    // Keyboard alternative to dragging: arrow keys nudge a focused pin by 1% of the plan.
    const before = (await sectionRow(page, 'Terrace'))!;
    const nudged = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes('/api/floor-plan/sections/'));
    await page.locator('[data-section-pin="Terrace"]').focus();
    await page.keyboard.press('ArrowRight');
    expect((await nudged).ok()).toBeTruthy();
    const after = (await sectionRow(page, 'Terrace'))!;
    expect(after.pinX - before.pinX).toBeCloseTo(0.01, 6);
    expect(after.pinY).toBeCloseTo(before.pinY, 6);
  });

  test('tap a pin to rename it; delete needs a second, explicit confirm', async ({ page }) => {
    test.setTimeout(180_000);
    await signupNewVenue(page, testVenueName('section-editor-edit'));
    await seedBarDesPres(page);
    await openEditor(page);
    await dropPin(page, EMPTY_A, 'Terrace', '6');

    // Rename + pax via the pin.
    let c = await pinCentre(page, 'Terrace');
    await page.touchscreen.tap(c.x, c.y);
    let dialog = page.getByRole('dialog', { name: 'Edit Terrace' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Section name').fill('Garden');
    await dialog.getByLabel('Pax capacity').fill('8');
    const saved = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes('/api/floor-plan/sections/'));
    await dialog.getByRole('button', { name: 'Save' }).tap();
    expect((await saved).ok()).toBeTruthy();
    await expect(page.locator('[data-section-pin="Garden"]')).toBeVisible();
    const renamed = (await sectionRow(page, 'Garden'))!;
    expect(renamed.paxCapacity).toBe(8);
    expectNear(renamed, EMPTY_A, 'rename did not move the pin');

    // Delete: first tap only asks; "Keep" backs out without deleting.
    c = await pinCentre(page, 'Garden');
    await page.touchscreen.tap(c.x, c.y);
    dialog = page.getByRole('dialog', { name: 'Edit Garden' });
    await dialog.getByRole('button', { name: 'Delete…' }).tap();
    const confirm = dialog.getByRole('group', { name: 'Confirm delete' });
    await expect(confirm).toContainText('Delete Garden and its assignments?');
    await confirm.getByRole('button', { name: 'Keep' }).tap();
    await expect(confirm).toHaveCount(0);
    expect(await sectionRow(page, 'Garden')).not.toBeNull();

    // Second, explicit confirm deletes.
    await dialog.getByRole('button', { name: 'Delete…' }).tap();
    const deleted = page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes('/api/floor-plan/sections/'));
    await dialog.getByRole('group', { name: 'Confirm delete' }).getByRole('button', { name: 'Delete', exact: true }).tap();
    expect((await deleted).status()).toBe(204);
    await expect(page.locator('[data-section-pin="Garden"]')).toHaveCount(0);
    expect(await sectionRow(page, 'Garden')).toBeNull();
    await expect(page.locator('.fp-editor [data-section-pin]')).toHaveCount(8);
  });
});
