import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import { cleanupTestOrgs, continueThroughVenue, signupNewVenue, testVenueName } from './helpers';

/**
 * Full real onboarding gate: Welcome (hold gesture + carousel) -> Account
 * (phone -> OTP -> venue created; both inside `signupNewVenue`) -> Venue ->
 * Roster (real upload) -> Review (confirm, including an inline edit) ->
 * Invite (join link/QR + one individual invite) -> real dashboard.
 *
 * Real backend + real Postgres throughout, no mocking, matching the
 * disposable-script verification this suite replaces. The one deliberate
 * gap: WhatsApp message delivery itself is not verified (impractical to test
 * live) — only that the correct wa.me link is constructed, via intercepting
 * the popup Playwright sees when the app calls window.open()/clicks the
 * target=_blank anchor.
 */

const FIXTURE = path.resolve('server/test-fixtures/sample-roster.xlsx');

async function uploadRoster(page: Page) {
  await page.waitForSelector('text=Bring your team with you.');
  await page.locator('input[type=file][accept*=".xlsx"]').setInputFiles(FIXTURE);
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({ timeout: 20000 });
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.waitForURL('**/onboarding/review**');
}

/** Resolves every flagged/unflagged review row (clicking "Looks right"/"Done"
 * for each), making an inline name+role edit on the first one, until the
 * footer's Confirm & Continue button is enabled. */
async function resolveReviewRows(page: Page) {
  await page.waitForSelector("text=Here's what we found.");
  let first = true;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const confirmBtn = page.getByRole('button', { name: /Confirm & Continue|Review \d+ flagged first/ });
    const label = (await confirmBtn.textContent())?.trim() ?? '';
    if (label.startsWith('Confirm & Continue')) break;

    const header = page.locator('div[role="button"]').first();
    await header.click();
    const panel = header.locator('xpath=following-sibling::div[1]');
    await panel.waitFor({ state: 'visible' });

    if (first) {
      await panel.locator('input').first().fill('E2E Edited Name');
      await panel.getByRole('button', { name: 'Bartender', exact: true }).click();
      first = false;
    }
    await panel.getByRole('button', { name: /Looks right|Done/ }).click();
  }
}

/** Triggers a click that opens a wa.me/whatsapp.com popup, aborts its
 * request before it reaches the real network, and returns the URL it tried
 * to load — proof of correct construction without a real external call. */
async function captureAbortedWhatsAppLink(context: BrowserContext, trigger: () => Promise<void>): Promise<string> {
  let resolveUrl!: (url: string) => void;
  const urlPromise = new Promise<string>((resolve) => {
    resolveUrl = resolve;
  });
  const predicate = (url: URL) => /wa\.me|whatsapp\.com/.test(url.hostname);
  await context.route(predicate, async (route) => {
    resolveUrl(route.request().url());
    await route.abort();
  });
  const popupPromise = context.waitForEvent('page');
  await trigger();
  const [url, popup] = await Promise.all([urlPromise, popupPromise]);
  await popup.close().catch(() => {});
  await context.unroute(predicate);
  return url;
}

test.describe('onboarding — full real gate', () => {
  // Close the page before deleting its venue's data — otherwise a
  // still-in-flight request from the closing page (a poll/interval mid-tick)
  // can race the cascading delete and crash the dev server (an unhandled
  // rejection in requireSession's async middleware takes down the whole
  // Node process, not just that request — see MEMORY.md's e2e-suite note).
  test.afterEach(async ({ page }) => {
    await page.close().catch(() => {});
    await cleanupTestOrgs();
  });

  test('Welcome -> Venue -> Roster -> Review -> Invite -> dashboard, state carries correctly end to end', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const venueName = testVenueName('onboarding-full');
    await signupNewVenue(page, venueName);

    // Venue shows the name Account already collected as a confirmed summary
    // (not a fresh re-prompt) — "Rename" reveals the same input as before.
    // Editing it here proves the two steps still hand the same Location to
    // each other.
    await page.waitForSelector('text=Tell us about the room.');
    // Scoped to `main`: the onboarding overlay renders inside it, while the
    // AppShell banner behind it also shows the venue name once its own fetch
    // lands — an unscoped getByText raced between 1 and 2 matches (strict-
    // mode violation ≈ 1 run in 6), which is what made this test flaky.
    await expect(page.getByRole('main').getByText(venueName, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Rename' }).click();
    await expect(page.getByPlaceholder('e.g. Sefarina, DIFC')).toHaveValue(venueName);
    await page.getByPlaceholder('e.g. Sefarina, DIFC').fill('E2E Test Restaurant');
    await continueThroughVenue(page);
    await uploadRoster(page);
    await resolveReviewRows(page);

    await page.getByRole('button', { name: 'Confirm & Continue' }).click();
    await page.waitForURL('**/onboarding/invite**');

    // Join link + QR
    await page.waitForSelector('text=Venue join-link', { timeout: 15000 });
    const linkText = await page.locator('.ob-serif').filter({ hasText: /^(shiftsync|localhost|127\.0\.0\.1)/ }).first().textContent();
    expect(linkText).toBeTruthy();

    await page.getByRole('button', { name: 'Copy' }).click();
    await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /Save as image/ }).click();
    await downloadPromise;

    // Share to WhatsApp / individual invite — assert the deep link is
    // constructed correctly without letting it actually reach WhatsApp's
    // real servers: both wa.me and api.whatsapp.com are real third-party
    // domains, so a genuine network round-trip here would be an actual
    // external call, not just "not verifying delivery." Intercept and abort
    // instead, asserting on the outgoing request URL itself.
    const shareUrl = await captureAbortedWhatsAppLink(context, () => page.getByRole('link', { name: 'Share to WhatsApp' }).click());
    expect(shareUrl).toMatch(/wa\.me|whatsapp\.com/);

    // Individual invite — the onboarding Owner created at signup is the one
    // real Staff Directory entry for a brand-new venue (roster-confirmed
    // rows without a matching existing User don't create one — they only
    // become real Users later, when that person self-onboards via the join
    // link, per InviteScreen's own documented behavior).
    await page.getByText('Or invite someone individually').click();
    await page.waitForSelector('text=Tick anyone to send a direct invite.');
    const firstStaffRow = page.locator('input[placeholder="Add mobile number"]').first();
    await firstStaffRow.fill('501234567');
    await firstStaffRow.blur();
    await page.getByRole('button', { name: 'Select' }).first().click();

    const inviteUrl = await captureAbortedWhatsAppLink(context, () => page.getByRole('button', { name: /Send 1 direct invite/ }).click());
    expect(inviteUrl).toContain('wa.me/971501234567');

    await page.getByRole('button', { name: 'Finish setup' }).click();
    await page.waitForURL('**/', { timeout: 5000 });
    expect(new URL(page.url()).pathname).toBe('/');
  });
});
