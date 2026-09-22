import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { cleanupTestOrgs, continueThroughVenue, signupNewVenue, testVenueName } from './helpers';

/**
 * MVP readiness review, Part 1: the Roster upload control must work the way a
 * real person uses it — a tap on the visible "Upload your roster" zone, which
 * opens the browser's file picker, then a real .xlsx through the real
 * /api/schedules/upload round-trip, then Continue into Review showing rows.
 *
 * The existing onboarding.spec.ts drives the HIDDEN <input type=file> via
 * setInputFiles, which never exercises the zone's click handler at all. This
 * spec goes through the click -> filechooser path instead, which is exactly
 * the wiring the founder reported as "not working".
 */

const GOOD_FIXTURE = path.resolve('server/test-fixtures/sample-roster.xlsx');
const BAD_FIXTURE = path.resolve('e2e/fixtures/not-really-a-workbook.xlsx');
const SHOTS = process.env.MVP_SHOTS_DIR ?? '';

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
}

async function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    // Chrome logs every non-2xx fetch as "Failed to load resource" — the
    // deliberate bad-file 422 is not an app error; real JS errors are.
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console.error: ${m.text()}`);
  });
  return errors;
}

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
]) {
  test.describe(`roster upload via real click — ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test.afterEach(async ({ page }) => {
      await page.close().catch(() => {});
      await cleanupTestOrgs();
    });

    test('tapping the upload zone opens a file picker; a real .xlsx parses and lands in Review', async ({ page }) => {
      const errors = await collectErrors(page);
      await signupNewVenue(page, testVenueName(`p1-upload-${viewport.name}`));
      await continueThroughVenue(page);
      await page.waitForSelector('text=Bring your team with you.');
      await shot(page, `p1-${viewport.name}-roster-empty`);

      // Bad file first: a file with an .xlsx name that is not a workbook must
      // surface a visible error in the zone, and must NOT enable Continue.
      const zone = page.getByRole('button', { name: /Upload your roster/ });
      await expect(zone).toBeVisible();
      const [badChooser] = await Promise.all([page.waitForEvent('filechooser'), zone.click()]);
      expect(badChooser.isMultiple()).toBe(false);
      await badChooser.setFiles(BAD_FIXTURE);
      await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
      // The zone's subtitle swaps to the server's error message.
      await expect(zone).toContainText(/Could not|could not|not a real|cannot be read|No valid shift rows/i, { timeout: 20000 });
      await shot(page, `p1-${viewport.name}-roster-bad-file`);

      // Now the real file, through the same tap.
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), zone.click()]);
      await chooser.setFiles(GOOD_FIXTURE);
      await expect(page.getByText('sample-roster.xlsx')).toBeVisible({ timeout: 20000 });
      await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({ timeout: 20000 });
      await shot(page, `p1-${viewport.name}-roster-ready`);

      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.waitForURL('**/onboarding/review**');
      await page.waitForSelector("text=Here's what we found.");
      // Real parsed people, not an empty list.
      const rows = page.locator('div[role="button"]');
      expect(await rows.count()).toBeGreaterThan(0);
      await expect(page.getByText(/\d+ staff found/)).toBeVisible();
      await shot(page, `p1-${viewport.name}-review`);

      expect(errors, errors.join('\n')).toEqual([]);
    });

    test('keyboard: Enter on the focused upload zone opens the picker too', async ({ page }) => {
      await signupNewVenue(page, testVenueName(`p1-kbd-${viewport.name}`));
      await continueThroughVenue(page);
      await page.waitForSelector('text=Bring your team with you.');
      const zone = page.getByRole('button', { name: /Upload your roster/ });
      await zone.focus();
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
      await chooser.setFiles(GOOD_FIXTURE);
      await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({ timeout: 20000 });
    });
  });
}
