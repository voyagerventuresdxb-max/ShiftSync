import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { cleanupTestOrgs, continueThroughVenue, passWelcomeIntro, prisma, signupNewVenue, testVenueName } from './helpers';

/**
 * MVP readiness review, Part 2.1: every onboarding screen, every button, every
 * transition, as a brand-new manager would meet them — including the states
 * the happy-path spec never visits (409 on an existing phone, Rename on
 * Venue, Skip on Roster, Skip on Invite, Back from every step, the two Done
 * screens). Real backend, real Postgres, no API shortcuts.
 */

const FIXTURE = path.resolve('server/test-fixtures/sample-roster.xlsx');
const SHOTS = process.env.MVP_SHOTS_DIR ?? '';

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    // Chrome logs every non-2xx fetch as "Failed to load resource" — an
    // expected 409/404 from the API is not an app error; real JS errors are.
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console.error: ${m.text()}`);
  });
  return errors;
}

// Audit walkthrough of every onboarding screen at both viewports (~9 min).
// Opt-in so the default suite stays fast: MVP_AUDIT=1 npx playwright test e2e/mvp-review-part2-onboarding.spec.ts
test.skip(!process.env.MVP_AUDIT, 'audit scenario — run with MVP_AUDIT=1');

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
]) {
  test.describe(`onboarding walkthrough — ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test.afterEach(async ({ page }) => {
      await page.close().catch(() => {});
      await cleanupTestOrgs();
    });

    test('Account: 409 on an already-registered phone shows the "already here" state with a working Log in link', async ({ page }) => {
      const errors = collectErrors(page);
      const venueName = testVenueName(`p2-409-${viewport.name}`);
      const { phone } = await signupNewVenue(page, venueName);

      // Second visitor, same phone, fresh browser state.
      await page.evaluate(() => localStorage.clear());
      await page.goto('/onboarding');
      await passWelcomeIntro(page);
      await page.waitForURL('**/onboarding/account**');
      await page.getByPlaceholder('+971 50 123 4567').fill(phone);
      await page.getByRole('button', { name: 'Send code' }).click();
      await page.waitForSelector('text=Check your messages.');
      const devCode = (await page.locator('[data-dev-code]').innerText()).trim();
      await page.getByPlaceholder('······').fill(devCode);
      await page.getByPlaceholder('e.g. Layla Haddad').fill('Second Person');
      await page.getByPlaceholder('e.g. Sefarina, DIFC').fill('Duplicate Venue');
      await page.getByRole('button', { name: 'Verify & continue' }).click();

      await expect(page.getByText('You’re already here.')).toBeVisible();
      await expect(page.getByText(`An account already exists for ${phone}`)).toBeVisible();
      await shot(page, `p2-${viewport.name}-account-409`);
      // Log in link is a real link to the login mode of /join.
      const loginLink = page.getByRole('link', { name: 'Log in' });
      await expect(loginLink).toHaveAttribute('href', /\/join\?mode=login/);
      await loginLink.click();
      await page.waitForURL('**/join?mode=login**');
      await expect(page.getByRole('heading', { name: 'Log in to ShiftSync' })).toBeVisible();

      // And the login actually works for that phone, landing back on Venue.
      await page.getByPlaceholder('Phone number').fill(phone);
      await page.getByRole('button', { name: 'Send code' }).click();
      const loginCode = (await page.locator('.font-mono').innerText()).trim();
      await page.getByPlaceholder('6-digit code').fill(loginCode);
      await page.getByRole('button', { name: 'Verify & log in' }).click();
      await page.waitForURL('**/onboarding/venue**', { timeout: 15000 });
      await expect(page.getByText('Tell us about the room.')).toBeVisible();
      expect(errors, errors.join('\n')).toEqual([]);
    });

    test('Venue: name summary + Rename, Back to Welcome, city/type chips gate Continue, sections stepper', async ({ page }) => {
      const errors = collectErrors(page);
      const venueName = testVenueName(`p2-venue-${viewport.name}`);
      await signupNewVenue(page, venueName);
      await page.waitForSelector('text=Tell us about the room.');
      await shot(page, `p2-${viewport.name}-venue`);

      // Summary shows the Account-collected name; Continue is disabled until
      // both a city and a type are picked.
      await expect(page.getByRole('main').getByText(venueName, { exact: true })).toBeVisible();
      const cont = page.getByRole('button', { name: 'Continue', exact: true });
      await expect(cont).toBeDisabled();
      await page.getByRole('button', { name: 'Dubai' }).click();
      await expect(cont).toBeDisabled();
      await page.getByRole('button', { name: 'Fine Dining' }).click();
      await expect(cont).toBeEnabled();

      // Rename reveals the input prefilled; blur collapses back to a summary
      // showing the NEW name.
      await page.getByRole('button', { name: 'Rename' }).click();
      const nameInput = page.getByPlaceholder('e.g. Sefarina, DIFC');
      await expect(nameInput).toHaveValue(venueName);
      const renamed = `${venueName} renamed`;
      await nameInput.fill(renamed);
      await nameInput.blur();
      await expect(page.getByRole('main').getByText(renamed, { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Rename' })).toBeVisible();

      // Clearing the name must NOT strand the manager: empty falls back to
      // the open input (no summary to click Rename on).
      await page.getByRole('button', { name: 'Rename' }).click();
      await nameInput.fill('');
      await nameInput.blur();
      await expect(nameInput).toBeVisible();
      await expect(cont).toBeDisabled();
      await nameInput.fill(renamed);
      await nameInput.blur();
      await expect(cont).toBeEnabled();

      // Sections stepper + "Set up later" toggle.
      await expect(page.getByText('3', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'More sections' }).click();
      await expect(page.getByText('4', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Fewer sections' }).click();
      await page.getByRole('button', { name: 'Set up later' }).click();
      await expect(page.getByText('Later', { exact: true })).toBeVisible();

      // Back goes to Welcome; the step is already unlocked so Venue is
      // reachable again via the intro's Continue (signed in -> straight to Venue).
      await page.getByRole('button', { name: 'Back' }).click();
      await page.waitForURL(/\/onboarding$/);
      await passWelcomeIntro(page);
      await page.waitForURL('**/onboarding/venue**');

      // Continue persists the rename server-side.
      await page.getByRole('button', { name: 'Dubai' }).click();
      await page.getByRole('button', { name: 'Fine Dining' }).click();
      await page.getByRole('button', { name: 'Rename' }).click();
      await page.getByPlaceholder('e.g. Sefarina, DIFC').fill(renamed);
      await cont.click();
      await page.waitForURL('**/onboarding/roster**');
      const loc = await prisma.location.findFirst({ where: { name: renamed } });
      expect(loc, 'renamed venue persisted').not.toBeNull();
      expect(loc?.venueType).toBe('Fine Dining');
      expect(loc?.emirate).toBe('Dubai');
      expect(errors, errors.join('\n')).toEqual([]);
    });

    test('Roster: Skip goes straight to Invite (Review skipped); Back from Invite lands on Review "Nothing to review yet"', async ({ page }) => {
      const errors = collectErrors(page);
      await signupNewVenue(page, testVenueName(`p2-skip-${viewport.name}`));
      await continueThroughVenue(page);
      await page.getByRole('button', { name: /Skip for now/ }).click();
      await page.waitForURL('**/onboarding/invite**');
      await page.waitForSelector('text=Venue join-link', { timeout: 15000 });
      await shot(page, `p2-${viewport.name}-invite`);
      await page.getByRole('button', { name: 'Back' }).click();
      await page.waitForURL('**/onboarding/review**');
      await expect(page.getByText('Nothing to review yet.')).toBeVisible();
      await page.getByRole('button', { name: 'Back' }).click();
      await page.waitForURL('**/onboarding/roster**');
      expect(errors, errors.join('\n')).toEqual([]);
    });

    test('Review: flagged rows gate Confirm; Remove drops a person; confirm persists the right number of shifts; Invite -> Done -> dashboard', async ({ page, context }) => {
      const errors = collectErrors(page);
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      const venueName = testVenueName(`p2-review-${viewport.name}`);
      await signupNewVenue(page, venueName);
      await continueThroughVenue(page);
      await page.waitForSelector('text=Bring your team with you.');
      await page.locator('input[type=file][accept*=".xlsx"]').setInputFiles(FIXTURE);
      await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({ timeout: 20000 });
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.waitForURL('**/onboarding/review**');
      await page.waitForSelector("text=Here's what we found.");
      await shot(page, `p2-${viewport.name}-review`);

      const rows = page.locator('div[role="button"]');
      const total = await rows.count();
      expect(total).toBeGreaterThan(1);

      // "Flagged only" filter toggles the visible set.
      const flaggedLabel = await page.getByText(/need(s)? your review|all confirmed/).innerText();
      if (/need/.test(flaggedLabel)) {
        await page.getByRole('button', { name: 'Flagged only' }).click();
        expect(await rows.count()).toBeLessThanOrEqual(total);
        await page.getByRole('button', { name: 'Show all' }).click();
      }

      // Remove the LAST person entirely; resolve every remaining row.
      const last = rows.nth(total - 1);
      const lastName = (await last.locator('.ob-serif').first().innerText()).trim();
      await last.click();
      await last.locator('xpath=following-sibling::div[1]').getByRole('button', { name: 'Remove' }).click();
      await expect(page.getByText(`${total - 1} staff found`)).toBeVisible();
      await expect(page.getByText(lastName, { exact: true })).toHaveCount(0);

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const confirmBtn = page.getByRole('button', { name: /Confirm & Continue|Review \d+ flagged first/ });
        if (((await confirmBtn.textContent()) ?? '').startsWith('Confirm & Continue')) break;
        const header = page.locator('div[role="button"]').first();
        await header.click();
        const panel = header.locator('xpath=following-sibling::div[1]');
        await panel.waitFor({ state: 'visible' });
        // Custom role path on the first flagged row: type a venue term.
        if (await panel.getByRole('button', { name: '+ Custom' }).isVisible()) {
          await panel.getByRole('button', { name: '+ Custom' }).click();
          await panel.getByPlaceholder(/Your venue's term/).fill('Sommelier');
          await panel.getByPlaceholder(/Your venue's term/).press('Enter');
          await expect(panel.getByRole('button', { name: 'Sommelier' })).toBeVisible();
        }
        await panel.getByRole('button', { name: /Looks right|Done/ }).click();
      }

      await page.getByRole('button', { name: 'Confirm & Continue' }).click();
      await page.waitForURL('**/onboarding/invite**');

      // Persisted shifts belong to THIS venue and the removed person has none.
      const location = await prisma.location.findFirst({ where: { name: venueName } });
      expect(location).not.toBeNull();
      const shifts = await prisma.shift.findMany({ where: { locationId: location!.id } });
      expect(shifts.length).toBeGreaterThan(0);
      const removedUser = await prisma.user.findFirst({ where: { locationId: location!.id, fullName: lastName } });
      expect(removedUser).toBeNull();
      const sommelier = await prisma.role.findFirst({ where: { locationId: location!.id, name: 'Sommelier' } });
      expect(sommelier, 'custom role created for the venue').not.toBeNull();

      // Invite: copy works, QR renders, individual list opens with the owner.
      await page.waitForSelector('text=Venue join-link', { timeout: 15000 });
      await page.getByRole('button', { name: 'Copy' }).click();
      await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
      await expect(page.getByRole('img', { name: 'Invite QR code' })).toBeVisible();
      await page.getByText('Or invite someone individually').click();
      await expect(page.getByText('E2E Test Owner')).toBeVisible();

      // Finish -> Done screen -> dashboard, with the venue name in the shell.
      await page.getByRole('button', { name: 'Finish setup' }).click();
      await expect(page.getByText("You're set up.")).toBeVisible();
      await shot(page, `p2-${viewport.name}-done`);
      await page.waitForURL(/\/$/, { timeout: 5000 });
      await expect(page.getByText(venueName).first()).toBeVisible({ timeout: 15000 });
      await shot(page, `p2-${viewport.name}-dashboard`);
      expect(errors, errors.join('\n')).toEqual([]);
    });

    test('Invite: Skip — invite later shows the alternate Done copy and still reaches the dashboard', async ({ page }) => {
      await signupNewVenue(page, testVenueName(`p2-inviteskip-${viewport.name}`));
      await continueThroughVenue(page);
      await page.getByRole('button', { name: /Skip for now/ }).click();
      await page.waitForSelector('text=Venue join-link', { timeout: 15000 });
      await page.getByRole('button', { name: /Skip — invite later/ }).click();
      await expect(page.getByText('Your room, your pace.')).toBeVisible();
      await page.getByRole('button', { name: 'Continue to Dashboard' }).click();
      await page.waitForURL(/\/$/, { timeout: 5000 });
    });
  });
}
