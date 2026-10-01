import { test, expect, type Page } from '@playwright/test';
import { cleanupTestOrgs, continueThroughVenue, signupNewVenue, testVenueName } from './helpers';

/**
 * Back-navigation regression gate (2026-09-28, Capacitor-critical) — the
 * browser-testable half of src/lib/backNavigation.ts's priority order:
 *
 *   (i)  history back closes the topmost open sheet / dropdown and stays on
 *        the same route;
 *   (ii) inside onboarding, history back goes to the previous step instead
 *        of leaving the flow, and the in-app Back control pops (never
 *        stacks) history entries;
 *   (iii) closing a sheet with its own Close button leaves no dead entry: the
 *        next history back leaves the page as it would have before.
 *
 * (iv) — exiting the app at a root tab — is Android-only (App.exitApp) and
 * can't run here; see MEMORY.md's manual test steps.
 */

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const API = 'http://localhost:4000';

async function pathname(page: Page): Promise<string> {
  return new URL(page.url()).pathname;
}

/** Uploads a floor plan + one section through the real API with the signed-in session, so /floor-plan renders a tappable pin. */
async function seedFloorPlan(page: Page): Promise<void> {
  const raw = await page.evaluate(() => localStorage.getItem('shiftsync.session'));
  const session = JSON.parse(raw ?? 'null') as { token: string; user: { locationId: string } };
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const fd = new FormData();
  fd.append('locationId', session.user.locationId);
  fd.append('file', new Blob([readFileSync(path.resolve('e2e/fixtures/floor-plan.png'))], { type: 'image/png' }), 'floor-plan.png');
  const up = await fetch(`${API}/api/floor-plan/upload`, { method: 'POST', headers: { Authorization: `Bearer ${session.token}` }, body: fd });
  expect(up.ok).toBeTruthy();
  const { image } = (await up.json()) as { image: { id: string } };
  const sec = await fetch(`${API}/api/floor-plan/sections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
    body: JSON.stringify({
      locationId: session.user.locationId,
      floorPlanImageId: image.id,
      label: 'Area 1',
      paxCapacity: 12,
      pinX: 0.185,
      pinY: 0.265,
    }),
  });
  expect(sec.ok).toBeTruthy();
}

test.describe('back navigation', () => {
  test.afterEach(async ({ page }) => {
    await page.close().catch(() => {});
    await cleanupTestOrgs();
  });

  test('history back closes the topmost sheet/dropdown and stays on the route; closing by button leaves no dead entry', async ({ page }) => {
    test.setTimeout(180_000);
    await signupNewVenue(page, testVenueName('back-nav'));
    await seedFloorPlan(page);

    // (i) RotaBuilder sheet
    await page.goto('/people');
    await page.waitForSelector('text=Staff Directory');
    await page.goto('/scheduling');
    await page.waitForSelector('text=Weekly rota builder');
    await page.getByRole('button', { name: /Save as template/ }).first().click();
    await expect(page.getByText('Save week as template')).toBeVisible();
    await page.goBack();
    await expect(page.getByText('Save week as template')).toHaveCount(0);
    expect(await pathname(page)).toBe('/scheduling');

    // (iii) open again, close with the button, then back must leave /scheduling for /people
    await page.getByRole('button', { name: /Save as template/ }).first().click();
    await expect(page.getByText('Save week as template')).toBeVisible();
    await page.getByRole('button', { name: 'Close' }).first().click();
    await expect(page.getByText('Save week as template')).toHaveCount(0);
    await page.goBack();
    await page.waitForURL('**/people');
    expect(await pathname(page)).toBe('/people');

    // (i) notification bell dropdown
    await page.getByRole('button', { name: /notifications/i }).first().click();
    await expect(page.getByText('Notifications', { exact: true })).toBeVisible();
    await page.goBack();
    await expect(page.getByText('Notifications', { exact: true })).toHaveCount(0);
    expect(await pathname(page)).toBe('/people');

    // (i) SectionDetail over the floor plan
    await page.goto('/floor-plan');
    await page.waitForSelector('.fp-canvas-wrap img');
    await page.getByRole('button', { name: /^Area 1,/ }).click();
    await expect(page.getByText('pax assigned')).toBeVisible();
    await page.goBack();
    await expect(page.getByText('pax assigned')).toHaveCount(0);
    expect(await pathname(page)).toBe('/floor-plan');

    // Overlay switch in one tick (SectionDetail closes as SectionPicker opens):
    // the picker adopts the detail's history entry, so one back closes the
    // picker and leaves the page — no extra dead entry, no self-closing.
    await page.getByRole('button', { name: /^Area 1,/ }).click();
    await expect(page.getByText('pax assigned')).toBeVisible();
    await page.getByRole('button', { name: 'Assign staff' }).click();
    await expect(page.getByText('Assign to Area 1')).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page.getByText('Assign to Area 1')).toBeVisible();
    await page.goBack();
    await expect(page.getByText('Assign to Area 1')).toHaveCount(0);
    await expect(page.getByText('pax assigned')).toHaveCount(0);
    expect(await pathname(page)).toBe('/floor-plan');
    await page.goBack();
    await page.waitForURL('**/people');

    // A route change from inside an open overlay must not be undone by the sentinel cleanup.
    await page.goto('/floor-plan');
    await page.waitForSelector('.fp-canvas-wrap img');
    await page.getByRole('button', { name: /^Area 1,/ }).click();
    await expect(page.getByText('pax assigned')).toBeVisible();
    await page.goto('/profile');
    await page.waitForSelector('text=Sign out');
    expect(await pathname(page)).toBe('/profile');
  });

  test('onboarding: history back goes to the previous step, the in-app Back control pops rather than stacks, and step 1 leaves the flow', async ({ page }) => {
    test.setTimeout(180_000);
    await signupNewVenue(page, testVenueName('back-nav-onboarding'));
    // Account handed over to Venue: history back from Venue must NOT land on
    // the consumed Account step — it goes to the intro (step 1).
    await continueThroughVenue(page);
    expect(await pathname(page)).toBe('/onboarding/roster');

    // (ii) browser back = previous step, still inside the flow
    await page.goBack();
    await page.waitForURL('**/onboarding/venue');
    await page.waitForSelector('text=Tell us about the room.');

    // forward again through the real Continue, then the in-app Back control
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.waitForURL('**/onboarding/roster');
    await page.getByRole('button', { name: /^Back$/i }).click();
    await page.waitForURL('**/onboarding/venue');
    // In-app Back popped the roster entry: browser back now leaves Venue for
    // step 1 (the intro at /onboarding), not forward to Roster.
    await page.goBack();
    await page.waitForURL(/\/onboarding$/);
    expect(await pathname(page)).toBe('/onboarding');
  });
});
