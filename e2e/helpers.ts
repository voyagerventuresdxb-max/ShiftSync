import type { Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';

// Shared Prisma client for e2e fixture teardown — real DB, no mocking.
export const prisma = new PrismaClient();

export const TEST_ORG_PREFIX = '__e2e-test__';

/** Marks a real org name as e2e-owned so teardown can find and delete it, and no
 * real venue name could ever collide with it. */
export function testVenueName(label: string): string {
  return `${TEST_ORG_PREFIX} ${label} ${Date.now()}`;
}

/** Deletes every organization created by e2e specs (matched by the shared name
 * prefix), cascading to Location/User/Shift/etc. via the schema's onDelete:
 * Cascade. Call from an afterEach/afterAll — never leave e2e fixtures in the
 * real DB between runs. */
export async function cleanupTestOrgs(): Promise<void> {
  await prisma.organization.deleteMany({ where: { name: { startsWith: TEST_ORG_PREFIX } } });
}

/**
 * Drives the Welcome intro (hold gesture → settled reveal → 3-card
 * carousel → "Let's set up your venue") the way a real thumb would. Ends
 * with the intro's Continue click, which hands over to the next step
 * (Account for a signed-out visitor, Venue for a signed-in manager).
 */
export async function passWelcomeIntro(page: Page): Promise<void> {
  await page.waitForSelector('text=ShiftSync', { timeout: 15000 });
  const viewport = page.viewportSize()!;
  const cx = viewport.width / 2;
  const cy = viewport.height / 2;

  // Hold for just over HOLD_MS (1000ms) to trigger the absorb + handoff.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.waitForTimeout(1200);
  await page.mouse.up();

  // Handoff (1100ms) + settled reveal timeline (5600ms) before the
  // "Swipe up · Continue" hint becomes interactive.
  await page.waitForTimeout(6000);
  await page.getByText('Swipe up · Continue').click();

  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Begin — set up your venue' }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
}

/**
 * Real signup via the dev-OTP echo path (requires the server started with
 * ALLOW_DEV_OTP_ECHO=true, which playwright.config.ts sets automatically).
 * Drives the actual UI — no API shortcuts — so it also exercises the real
 * phone->OTP->venue-creation path the way a real owner would: the Welcome
 * intro, then the wizard's Account step (2026-09-16: account creation is
 * step 1 of onboarding itself, no separate /signup screen any more).
 * Lands on /onboarding/venue when done.
 */
export async function signupNewVenue(page: Page, venueName: string): Promise<{ phone: string }> {
  const phone = `+97150${Date.now().toString().slice(-7)}`;

  // A cold Vite dev server can auto-reload mid-navigation the very first
  // time it hits a new route (dependency pre-bundling) — Playwright sees
  // that as the initial goto's navigation being aborted. One retry clears
  // it; a warm server (the common case once the suite is past its first
  // test) never needs it.
  try {
    await page.goto('/onboarding');
  } catch {
    await page.goto('/onboarding');
  }
  await passWelcomeIntro(page);
  await page.waitForURL('**/onboarding/account**');

  await page.waitForSelector('text=First, your number.');
  await page.getByPlaceholder('+971 50 123 4567').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.waitForSelector('text=Check your messages.');
  const devCode = (await page.locator('[data-dev-code]').innerText()).trim();

  await page.getByPlaceholder('······').fill(devCode);
  await page.getByPlaceholder('e.g. Layla Haddad').fill('E2E Test Owner');
  await page.getByPlaceholder('e.g. Sefarina, DIFC').fill(venueName);
  await page.getByRole('button', { name: 'Verify & continue' }).click();
  await page.waitForURL('**/onboarding/venue**');

  return { phone };
}

/**
 * Completes the Venue step (name is prefilled from signup; a city and a
 * venue type are the two remaining required picks) and lands on Roster.
 * Steps are gated by real progress (`unlockedSteps`, issue #14), so a spec
 * that wants Roster/Review can't just `goto` there straight after signup —
 * it has to actually pass Venue first.
 */
export async function continueThroughVenue(page: Page): Promise<void> {
  await page.waitForSelector('text=Tell us about the room.');
  await page.getByRole('button', { name: 'Dubai' }).click();
  await page.getByRole('button', { name: 'Fine Dining' }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.waitForURL('**/onboarding/roster**');
}
