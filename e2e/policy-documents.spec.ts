import { test, expect } from '@playwright/test';
import path from 'node:path';
import { cleanupTestOrgs, signupNewVenue, testVenueName } from './helpers';

/**
 * Regression coverage for the design-QA touch-target fix: the delete-
 * document button used to have zero sizing classes (~14x14px real hit-area)
 * — the only icon-only action button in the app missing the established
 * h-7 w-7 (28x28px) pattern used by Announcements/SectionDetail. Covers both
 * the hit-area size itself and that the fix didn't break the actual delete.
 */

const FIXTURE = path.resolve('server/test-fixtures/sample-roster.pdf');

test.describe('policy documents — delete button', () => {
  // See onboarding.spec.ts's afterEach comment: close the page before
  // deleting its data so no in-flight request races the cascading delete.
  test.afterEach(async ({ page }) => {
    await page.close().catch(() => {});
    await cleanupTestOrgs();
  });

  test('has a real >=28x28px hit area and still deletes the document', async ({ page }) => {
    const venueName = testVenueName('policydoc');
    await signupNewVenue(page, venueName);

    await page.goto('/people');
    await page.waitForSelector('input[placeholder="Document title"]', { timeout: 15000 });

    await page.locator('input[placeholder="Document title"]').fill('E2E Fire Safety Handbook');
    await page.locator('input[list]').first().fill('Safety');
    await page.locator('input[type=file]').setInputFiles(FIXTURE);
    await page.getByRole('button', { name: 'Upload' }).click();
    await page.waitForSelector('text=E2E Fire Safety Handbook', { timeout: 15000 });

    const deleteBtn = page.getByRole('button', { name: 'Delete E2E Fire Safety Handbook' });
    const box = await deleteBtn.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(28);
    expect(box?.height).toBeGreaterThanOrEqual(28);

    const [deleteResponse] = await Promise.all([
      page.waitForResponse((res) => res.request().method() === 'DELETE' && res.url().includes('/api/policy-documents/')),
      deleteBtn.click(),
    ]);
    expect(deleteResponse.status()).toBe(204);
    await expect(page.getByText('E2E Fire Safety Handbook')).toHaveCount(0);
  });
});
