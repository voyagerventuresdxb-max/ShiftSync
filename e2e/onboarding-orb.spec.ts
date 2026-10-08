import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTestOrgs, continueThroughVenue, signupNewVenue, testVenueName } from './helpers';

/**
 * Onboarding's gold dot orb (the voice sheet's orb): the Welcome hold, and the Roster step while a
 * roster is read — reading = working, matching = connecting, finished = a calm ring, an error = a
 * still dim orb beside the message. Visual only: the steps, labels and Continue are unchanged.
 * Decorative (aria-hidden); a still ring shows at once and stays if the orb's download fails.
 *
 * Set ONBOARDING_ORB_SCREENS_DIR to save a screenshot of each state.
 */

const WIDTH = Number(process.env.E2E_PHONE_WIDTH) || 390;
test.use({ viewport: { width: WIDTH, height: 844 }, hasTouch: true });

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.ONBOARDING_ORB_SCREENS_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const motion = test.info().title.includes('reduced motion') ? 'reduced' : 'motion';
  await page.screenshot({ path: join(dir, `${test.info().project.name}-${WIDTH}-${motion}-${name}.png`) });
}

/** Holds the roster upload until released, and answers the progress poll with a chosen stage. */
async function controlReading(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __read: { stage: string; release: (() => void) | null; fail: string | null } };
    w.__read = { stage: 'uploading', release: null, fail: null };
    const real = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
      if (url.pathname.includes('/api/schedules/upload-progress/')) {
        const order = ['uploading', 'reading_text', 'matching', 'done'];
        const passed = order.slice(0, Math.max(0, order.indexOf(w.__read.stage)));
        return new Response(JSON.stringify({ stage: w.__read.stage, passed, pages: null, secondRead: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname.endsWith('/api/schedules/upload')) {
        await new Promise<void>((resolve) => (w.__read.release = resolve));
        if (w.__read.fail) return new Response(JSON.stringify({ error: w.__read.fail }), { status: 422, headers: { 'Content-Type': 'application/json' } });
      }
      return real(input, init);
    };
  });
}

const setStage = (page: Page, stage: string) => page.evaluate((s) => ((window as unknown as { __read: { stage: string } }).__read.stage = s), stage);
const release = (page: Page, fail: string | null = null) =>
  page.evaluate((f) => {
    const r = (window as unknown as { __read: { release: (() => void) | null; fail: string | null } }).__read;
    r.fail = f;
    r.release?.();
  }, fail);

/** Gold pixels on the orb's canvas (0 = nothing drawn). */
const inked = (page: Page) =>
  page.getByTestId('roster-orb').locator('canvas').evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i]! > 20) n++;
    return n;
  });
const frame = (page: Page) => page.getByTestId('roster-orb').locator('canvas').evaluate((c: HTMLCanvasElement) => c.toDataURL());

const CSV = Buffer.from(['Employee Name,Role,Date,Start Time,End Time', 'Ava Thornton,Waiter,2031-03-03,17:00,23:00', 'Ben Okafor,Bartender,2031-03-03,17:00,23:00'].join('\n'));

async function toRoster(page: Page, label: string): Promise<void> {
  await signupNewVenue(page, testVenueName(label));
  await continueThroughVenue(page);
  await page.waitForSelector('text=Bring your team with you.');
}

for (const reduced of [false, true]) {
  test.describe(`onboarding orb${reduced ? ' — reduced motion' : ''}`, () => {
    test.use({ contextOptions: { reducedMotion: reduced ? 'reduce' : 'no-preference' } });
    test.afterEach(async ({ page }) => {
      await page.close().catch(() => {});
      await cleanupTestOrgs();
    });

    test(`roster reading: working, then connecting, then a calm ring; an error is still and dim${reduced ? ' (reduced motion)' : ''}`, async ({ page }) => {
      test.setTimeout(180_000);
      await controlReading(page);
      await toRoster(page, `orb-${reduced ? 'r' : 'm'}`);
      // Nothing being read: no orb, the screen as before.
      await expect(page.getByTestId('roster-orb')).toHaveCount(0);

      await page.locator('input[type=file][accept*=".xlsx"]').setInputFiles({ name: 'roster.csv', mimeType: 'text/csv', buffer: CSV });
      const orb = page.getByTestId('roster-orb').locator('[data-orb-phase]');
      await expect(orb).toHaveAttribute('data-orb-phase', 'working');
      await expect(orb).toHaveAttribute('aria-hidden', 'true');
      await expect(page.getByTestId('roster-orb').locator('canvas')).toBeVisible();
      await expect.poll(() => inked(page)).toBeGreaterThan(50);
      // The existing progress steps are still there, unchanged.
      await setStage(page, 'reading_text');
      await expect(page.getByTestId('reading-step').filter({ hasText: "Reading the file's text" })).toHaveAttribute('data-state', 'current');
      if (reduced) {
        const a = await frame(page);
        await page.waitForTimeout(400);
        expect(await frame(page)).toBe(a);
      }
      await shot(page, '1-working');

      await setStage(page, 'matching');
      await expect(orb).toHaveAttribute('data-orb-phase', 'connecting');
      await expect(page.getByTestId('reading-step').filter({ hasText: 'Matching people to your staff' })).toHaveAttribute('data-state', 'current');
      await shot(page, '2-connecting');

      await release(page);
      await expect(orb).toHaveAttribute('data-orb-phase', 'done');
      await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();
      await expect(page.getByTestId('roster-orb').getByRole('status')).toHaveText('Roster read. Continue to review it.');
      await shot(page, '3-done');

      // A file that can't be read: a still, dim orb beside the message.
      await page.getByRole('button', { name: /Remove/ }).first().click();
      await expect(page.getByTestId('roster-orb')).toHaveCount(0);
      await page.locator('input[type=file][accept*=".xlsx"]').setInputFiles({ name: 'roster.csv', mimeType: 'text/csv', buffer: CSV });
      await release(page, "We couldn't find any shifts in that file.");
      await expect(orb).toHaveAttribute('data-orb-phase', 'problem');
      await expect(page.getByText("We couldn't find any shifts in that file.").first()).toBeVisible();
      const a = await frame(page);
      await page.waitForTimeout(400);
      expect(await frame(page)).toBe(a);
      await shot(page, '4-problem');
    });

    test(`welcome: the dot orb at rest, "working" while the hold takes the icons in${reduced ? ' (reduced motion)' : ''}`, async ({ page }) => {
      await page.goto('/onboarding');
      await page.locator('.ob-root').waitFor({ timeout: 30000 });
      const orb = page.locator('.ob-root [data-orb-phase]').first();
      await expect(orb).toHaveAttribute('data-orb-phase', 'rest');
      await expect(orb.locator('canvas')).toBeVisible();
      await shot(page, '0-welcome-rest');
      const box = page.viewportSize()!;
      await page.mouse.move(box.width / 2, box.height / 2);
      await page.mouse.down();
      await expect(orb).toHaveAttribute('data-orb-phase', 'working');
      await page.waitForTimeout(450);
      await shot(page, '0-welcome-hold');
      await page.mouse.up();
    });
  });
}

test('if the orb download fails, a still ring shows and onboarding carries on', async ({ page }) => {
  test.setTimeout(180_000);
  // The orb's own module (dev server) or chunk (build) never arrives.
  await page.route(/VoiceOrb[^/]*\.(tsx|js)(\?.*)?$/, (route) => route.abort());
  await page.goto('/onboarding');
  await page.locator('.ob-root').waitFor({ timeout: 30000 });
  await expect(page.locator('.ob-root [data-orb-phase]').first().getByTestId('static-orb-ring')).toBeVisible();
  await cleanupTestOrgs();
});
