import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTestOrgs, continueThroughVenue, signupNewVenue, testVenueName } from './helpers';

/**
 * While a roster is read, the screen shows the read's real steps — "Reading page 1 of 2", then
 * "Reading page 2 of 2", the cross-check, the matching — as the API reports them, on a phone.
 * A real read is too fast (or needs the paid AI reader), so the upload and its progress are
 * scripted at the network boundary: the test moves the read on one step at a time, then lets the
 * upload answer. The server side (stages recorded in order, who may read them) is covered by
 * server/src/routes/uploadProgress.test.ts. An API without the progress endpoint falls back to
 * the elapsed-time wording. Made-up data only.
 *
 * Set PROGRESS_SCREENS_DIR to save screenshots.
 */

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const preview = {
  batchId: 'e2e-progress-batch',
  templateDetected: 'Direct Vision Ingestion',
  parseIssues: [],
  summary: { totalRows: 1, matchedRows: 0, newEmployeeRows: 1, unmatchedRoleRows: 0, errorRows: 0 },
  anomalies: [],
  leaveRecords: [],
  legend: [],
  preview: [
    {
      rowNumber: 1,
      employeeName: 'Perrin Ashdown',
      role: 'Bartender',
      date: '2031-03-03',
      startTime: '10:00',
      endTime: '18:00',
      overnight: false,
      breakMinutes: 0,
      managerNotes: null,
      status: 'new_employee',
      issues: [],
    },
  ],
};

const pages = (done: number) => ({ total: 2, done, again: 0, againDone: 0 });
/** What the API reports, step by step, for a two-page text PDF. */
const STEPS = [
  { stage: 'uploading', passed: [], pages: null, secondRead: null },
  { stage: 'reading_text', passed: ['uploading'], pages: null, secondRead: null },
  { stage: 'reading_pages', passed: ['uploading', 'reading_text'], pages: pages(0), secondRead: null },
  { stage: 'reading_pages', passed: ['uploading', 'reading_text'], pages: pages(1), secondRead: null },
  { stage: 'cross_checking', passed: ['uploading', 'reading_text', 'reading_pages'], pages: pages(2), secondRead: null },
  { stage: 'matching', passed: ['uploading', 'reading_text', 'reading_pages', 'cross_checking'], pages: pages(2), secondRead: null },
];

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.PROGRESS_SCREENS_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.getByTestId('reading-progress').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

/**
 * Scripts the next upload: it answers only when `answer()` is called; meanwhile the progress
 * endpoint reports STEPS[step] (the test moves `step` on). Returns the controls and the upload id seen.
 */
async function scriptSlowUpload(page: Page) {
  let step = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const seen: { uploadId: string | null; polledIds: Set<string> } = { uploadId: null, polledIds: new Set() };
  await page.route('**/api/schedules/upload-progress/*', async (route) => {
    seen.polledIds.add(route.request().url().split('/').pop()!);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(STEPS[step]) });
  });
  await page.route('**/api/schedules/upload', async (route) => {
    seen.uploadId = (await route.request().headerValue('x-upload-id')) ?? null;
    await released;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(preview) });
  });
  return { seen, next: () => step++, answer: () => release() };
}

const current = (page: Page) => page.locator('[data-testid="reading-step"][data-state="current"]');

test.describe('reading a roster — real steps while it is read', () => {
  test.afterEach(async ({ page }) => {
    await page.close().catch(() => {});
    await cleanupTestOrgs();
  });

  test('onboarding: Uploading → Reading page 1 of 2 → page 2 of 2 → cross-check → matching; then Scheduling, with reduced motion', async ({ page }) => {
    test.setTimeout(180_000);
    await signupNewVenue(page, testVenueName('roster-progress'));
    await continueThroughVenue(page);

    const script = await scriptSlowUpload(page);
    await page.locator('input[type=file][accept*=".xlsx"]').setInputFiles({ name: 'two-pages.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 e2e') });

    const progress = page.getByTestId('reading-progress');
    await expect(progress).toHaveAttribute('data-mode', 'steps');
    await expect(current(page)).toHaveText('Uploading');
    // A PDF's expected steps are shown ahead, never as done.
    await expect(page.locator('[data-testid="reading-step"][data-state="upcoming"]')).toHaveText(["Reading the file's text", 'Reading the pages', 'Cross-checking the two readings', 'Matching people to your staff']);

    script.next();
    await expect(current(page)).toHaveText("Reading the file's text");
    script.next();
    await expect(current(page)).toHaveText('Reading page 1 of 2');
    await expect(progress.getByRole('status')).toHaveText('Reading page 1 of 2');
    await expect(page.locator('[data-testid="reading-step"][data-state="done"]')).toHaveText(['Uploaded', "Read the file's text"]);
    await shot(page, '01-onboarding-reading-page-1-of-2');

    script.next();
    await expect(current(page)).toHaveText('Reading page 2 of 2');
    await shot(page, '02-onboarding-reading-page-2-of-2');
    script.next();
    await expect(current(page)).toHaveText('Cross-checking the two readings');
    script.next();
    await expect(current(page)).toHaveText('Matching people to your staff');
    await expect(page.locator('[data-testid="reading-step"][data-state="done"]')).toHaveText(['Uploaded', "Read the file's text", 'Read all 2 pages', 'Cross-checked the two readings']);
    await shot(page, '03-onboarding-matching');

    // The id the screen polled is the one the upload carried.
    expect(script.seen.uploadId).toMatch(/^[0-9a-f-]{36}$/);
    expect([...script.seen.polledIds]).toEqual([script.seen.uploadId]);

    script.answer();
    await expect(progress).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();

    // Scheduling, with reduced motion: the same steps, and nothing moves.
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await page.getByRole('button', { name: /Skip for now/ }).click();
    await page.waitForSelector('text=Venue join-link', { timeout: 15000 });
    await page.getByRole('button', { name: /Skip — invite later/ }).click();
    await page.getByRole('button', { name: 'Continue to Dashboard' }).click();
    await page.waitForURL(/\/$/, { timeout: 10000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/scheduling');

    const again = await scriptSlowUpload(page);
    again.next();
    again.next();
    await page.locator('.upload-card input[type=file]').setInputFiles({ name: 'two-pages.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 e2e') });
    await expect(current(page)).toHaveText('Reading page 1 of 2');
    const dot = current(page).locator('span[aria-hidden] > span');
    expect(await dot.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
    await expect(page.locator('.spinner')).toHaveCount(0);
    await shot(page, '04-scheduling-reading-page-1-of-2-reduced-motion');
    again.next();
    await expect(current(page)).toHaveText('Reading page 2 of 2');
    again.answer();
    await expect(page.getByTestId('reading-progress')).toHaveCount(0);
  });

  test('an API without the progress endpoint: the elapsed-time wording, never a blank wait', async ({ page }) => {
    test.setTimeout(180_000);
    await signupNewVenue(page, testVenueName('roster-progress-old-api'));
    await continueThroughVenue(page);

    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    // What an older API answers for a path it doesn't know.
    await page.route('**/api/schedules/upload-progress/*', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Not found.' }) }));
    await page.route('**/api/schedules/upload', async (route) => {
      await released;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(preview) });
    });

    await page.locator('input[type=file][accept*=".xlsx"]').setInputFiles({ name: 'roster.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 e2e') });
    const progress = page.getByTestId('reading-progress');
    await expect(progress).toHaveAttribute('data-mode', 'elapsed');
    await expect(progress.getByRole('status')).toHaveText('Reading your roster…');
    await shot(page, '05-onboarding-older-api-fallback');
    release();
    await expect(progress).toHaveCount(0);
  });
});
