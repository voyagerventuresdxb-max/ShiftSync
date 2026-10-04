import { test, expect, type Page, type Request } from '@playwright/test';
import { cleanupTestOrgs, continueThroughVenue, signupNewVenue, testVenueName } from './helpers';

/**
 * The manager is asked before a roster goes to the third-party AI reader, and "yes" re-sends
 * the same file with consent — no re-picking. The e2e API has no AI reader configured, so the
 * upload endpoint's answers are scripted here at the network boundary; the server side of the
 * same flow (consent gate, allowance, escalation rules) is covered by
 * server/src/routes/rosterEscalation.test.ts.
 */
const PNG = 'server/scripts/fixtures/vlm-check-roster.png';

const preview = (escalation?: { reason: string; status: string; message: string }) => ({
  batchId: 'e2e-batch',
  templateDetected: 'Direct Vision Ingestion',
  parseIssues: [],
  summary: { totalRows: 1, matchedRows: 0, newEmployeeRows: 1, unmatchedRoleRows: 0, errorRows: 0 },
  anomalies: [],
  leaveRecords: [],
  legend: [],
  ...(escalation ? { escalation } : {}),
  preview: [
    {
      rowNumber: 1,
      employeeName: 'Test Person A',
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
});

/** Answers each upload from `answers` in order and records whether each request carried consent. */
async function scriptUploads(page: Page, answers: { status: number; body: unknown }[]): Promise<boolean[]> {
  const consent: boolean[] = [];
  await page.route('**/api/schedules/upload', async (route) => {
    const req: Request = route.request();
    consent.push((req.postDataBuffer() ?? Buffer.alloc(0)).toString('latin1').includes('name="aiConsent"'));
    const answer = answers[Math.min(consent.length - 1, answers.length - 1)]!;
    await route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body) });
  });
  return consent;
}

test.describe('roster upload — consent before the AI reader', () => {
  test.use({ actionTimeout: 20_000 });

  test.afterEach(async ({ page }) => {
    await page.close().catch(() => {});
    await cleanupTestOrgs();
  });

  test('onboarding photo: asked first (nothing sent), then "Send to the AI reader" re-sends the same photo with consent', async ({ page }) => {
    test.setTimeout(180_000);
    await signupNewVenue(page, testVenueName('ai-consent'));
    await continueThroughVenue(page);

    const consent = await scriptUploads(page, [
      {
        status: 422,
        body: {
          error: 'This is a photo or scanned file, so it can only be read by the AI reader. To read it, ShiftSync needs to send the file to its AI reader, a third-party service outside the UAE. Nothing is sent unless you agree.',
          errorCode: 'ai_consent_required',
          escalationReason: 'image_or_scan',
        },
      },
      { status: 200, body: preview() },
    ]);

    await page.locator('input[type=file][accept="image/*"]').setInputFiles(PNG);
    const panel = page.getByTestId('ai-consent-panel');
    await expect(panel).toContainText('third-party service outside the UAE');
    await expect(panel).toContainText('People → Add staff member');
    expect(consent).toEqual([false]);

    await page.getByTestId('ai-consent-send').click();
    await expect(page.getByText('vlm-check-roster.png')).toBeVisible();
    await expect(panel).toHaveCount(0);
    expect(consent).toEqual([false, true]);
  });

  test('Scheduling: a suspect result offers a re-read, and the re-read carries consent', async ({ page }) => {
    test.setTimeout(180_000);
    await signupNewVenue(page, testVenueName('ai-reread'));
    await continueThroughVenue(page);
    await page.getByRole('button', { name: /Skip for now/ }).click();
    await page.waitForSelector('text=Venue join-link', { timeout: 15000 });
    await page.getByRole('button', { name: /Skip — invite later/ }).click();
    await page.getByRole('button', { name: 'Continue to Dashboard' }).click();
    await page.waitForURL(/\/$/, { timeout: 10000 });
    await page.goto('/scheduling');

    const consent = await scriptUploads(page, [
      { status: 200, body: preview({ reason: 'empty_roles', status: 'needs_consent', message: 'Many shifts on this roster came out without a role. The AI reader can usually fill those in.' }) },
      { status: 200, body: preview({ reason: 'empty_roles', status: 'used', message: 'Read by the AI reader. Check every row before confirming.' }) },
    ]);

    await page.locator('.upload-card input[type=file]').setInputFiles({ name: 'roster.csv', mimeType: 'text/csv', buffer: Buffer.from(',Mon\nTest Person A,10-18\n') });
    const banner = page.getByTestId('escalation-banner');
    await expect(banner).toHaveAttribute('data-status', 'needs_consent');
    expect(consent).toEqual([false]);

    await page.getByTestId('escalation-reread').click();
    await expect(banner).toHaveAttribute('data-status', 'used');
    await expect(page.getByTestId('escalation-reread')).toHaveCount(0);
    expect(consent).toEqual([false, true]);
  });
});
