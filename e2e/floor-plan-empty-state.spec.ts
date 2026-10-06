import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { cleanupTestOrgs, prisma, seedVenueWithRoles, signInAs } from './helpers';
import { planPointOnScreen } from './floorPlanFixture';

/**
 * The Floor Plan page before a venue has any section (onboarding no longer
 * pretends to set them up — docs/floor-sections.md). A manager gets "Add your
 * first section" and is walked through the existing flow: upload the plan,
 * then place and name a section — named for real (Terrace), or, left blank,
 * the next free "Section N". Staff get a calm "not set up yet" note and no
 * setup controls. Real backend and DB, phone width.
 */

test.use({ viewport: { width: 390, height: 844 } });

const FIXTURE_PNG = path.resolve('e2e/fixtures/floor-plan.png');

async function uploadPlanViaApi(token: string, locationId: string): Promise<void> {
  const fd = new FormData();
  fd.append('locationId', locationId);
  fd.append('file', new Blob([readFileSync(FIXTURE_PNG)], { type: 'image/png' }), 'floor-plan.png');
  const res = await fetch('http://localhost:4000/api/floor-plan/upload', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  expect(res.ok, 'floor plan upload').toBeTruthy();
}

async function addSectionThroughDialog(page: Page, name: string, pax: string): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'New section' });
  await expect(dialog).toBeVisible();
  const nameInput = dialog.getByLabel('Section name');
  await expect(nameInput).toHaveValue('');
  await expect(nameInput).toHaveAttribute('placeholder', /Terrace, Bar, Main floor/);
  if (name) await nameInput.fill(name);
  await dialog.getByLabel('Pax capacity').fill(pax);
  const saved = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/api/floor-plan/sections'));
  await dialog.getByRole('button', { name: 'Add section' }).click();
  expect((await saved).ok()).toBeTruthy();
  await expect(dialog).toHaveCount(0);
}

test.describe('floor plan — empty state', () => {
  test.afterEach(async ({ page }) => {
    await page.close().catch(() => {});
    await cleanupTestOrgs();
  });

  test('manager with no sections: "Add your first section" leads through upload, then place and name', async ({ page }) => {
    const { locationId, sessions } = await seedVenueWithRoles('floor-empty-manager');
    await signInAs(page, sessions.MANAGER.stored, '/floor-plan');

    // No plan yet: the empty state's one action is the upload.
    const empty = page.getByTestId('floor-plan-empty');
    await expect(empty.getByRole('heading', { name: 'Add your first section' })).toBeVisible();
    // (Each step's number badge is aria-hidden but still in textContent, hence toContainText.)
    await expect(empty.getByRole('listitem')).toContainText(['Upload your floor plan', 'Tap the plan where a section sits', 'Name it — Terrace, Bar, Main floor']);
    await expect(empty.getByRole('listitem').first()).not.toContainText('(done)');
    await expect(empty.getByRole('button', { name: 'Upload floor plan' })).toBeVisible();
    await empty.locator('input[type=file]').setInputFiles(FIXTURE_PNG);

    // Plan uploaded, still no section: step 1 is ticked, the action moves on.
    await expect(empty.getByRole('listitem').first()).toContainText('Upload your floor plan (done)');
    await expect(page.locator('.fp-editor .fp-canvas-wrap img')).toBeVisible();
    await expect(page.getByRole('button', { name: /Done — go to daily assignment/ })).toHaveCount(0);
    await empty.getByRole('button', { name: 'Add first section' }).click();
    await expect(page.getByRole('dialog', { name: 'New section' }).getByText('Left blank, it\'s saved as “Section 1”.')).toBeVisible();
    await addSectionThroughDialog(page, 'Terrace', '12');

    // The first section exists: the empty state gives way to the normal editor.
    await expect(page.locator('[data-section-pin="Terrace"]')).toBeVisible();
    await expect(page.getByTestId('floor-plan-empty')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Sections (1)' })).toBeVisible();
    const terrace = await prisma.floorSection.findFirstOrThrow({ where: { locationId, label: 'Terrace' } });
    expect(terrace.paxCapacity).toBe(12);
    expect(terrace.pinX).toBeCloseTo(0.5, 5);
    expect(terrace.pinY).toBeCloseTo(0.5, 5);

    // A second one by tapping the plan, name left blank: saved under the fallback.
    await page.locator('.fp-canvas-wrap').scrollIntoViewIfNeeded();
    const spot = await planPointOnScreen(page, 0.2, 0.8);
    await page.mouse.click(spot.x, spot.y);
    await addSectionThroughDialog(page, '', '8');
    await expect(page.locator('[data-section-pin="Section 2"]')).toBeVisible();
    expect(await prisma.floorSection.count({ where: { locationId, label: 'Section 2' } })).toBe(1);
  });

  test('staff with no sections see that the floor plan is not set up yet, and no setup controls', async ({ page }) => {
    const { locationId, sessions } = await seedVenueWithRoles('floor-empty-staff');
    await signInAs(page, sessions.STAFF.stored, '/floor-plan');
    const note = page.getByTestId('floor-plan-not-set-up');
    await expect(note.getByRole('heading', { name: "Your manager hasn't set up the floor plan yet" })).toBeVisible();
    await expect(page.getByTestId('floor-plan-empty')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Upload floor plan|Add first section|Set up sections/ })).toHaveCount(0);

    // A plan uploaded but still no section: the same note.
    await uploadPlanViaApi(sessions.MANAGER.token, locationId);
    await page.reload();
    await expect(note.getByRole('heading', { name: "Your manager hasn't set up the floor plan yet" })).toBeVisible();
    await expect(page.getByRole('button', { name: /Upload floor plan|Add first section|Set up sections/ })).toHaveCount(0);
  });
});
