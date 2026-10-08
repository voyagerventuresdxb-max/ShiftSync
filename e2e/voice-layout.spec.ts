import { test, expect, type Locator, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { cleanupTestOrgs, prisma, settleOverlayHistory, testVenueName } from './helpers';

/**
 * The voice sheet's bottom row is always on screen: the mic or Show preview, the keyboard or mic
 * switch, and Cancel are pinned to the bottom of the visible area and only the middle scrolls.
 * Checked at 390x844, 360x640, 375x667 and with an on-screen keyboard (the visible area 340 px
 * tall, as an iPhone keyboard leaves it), with and without reduced motion, with and without a
 * problem message. Every check reads bounding boxes before anything is scrolled or tapped.
 *
 * Runs in Chromium with the suite; the same file also runs in WebKit (no Web Audio or media
 * encoder there in Playwright's Windows build, so a stand-in microphone is used for "listening").
 */

const SIZES = [
  { name: '390x844', width: 390, height: 844, keyboard: 0 },
  { name: '360x640', width: 360, height: 640, keyboard: 0 },
  { name: '375x667', width: 375, height: 667, keyboard: 0 },
  { name: '390x844 + keyboard (340 visible)', width: 390, height: 844, keyboard: 340 },
] as const;

test.use({
  launchOptions: {
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
  },
});

test.afterEach(async () => {
  await cleanupTestOrgs();
});

/** Microphone stand-in: refuses when `__mic.deny`, otherwise an empty stream (no Web Audio needed) and a recorder that records nothing. */
const STAND_IN_MIC = () => {
  const w = window as unknown as { __mic: { deny: boolean } };
  w.__mic = { deny: false };
  const getUserMedia = async () => {
    if (w.__mic.deny) throw new DOMException('Permission denied', 'NotAllowedError');
    return (typeof MediaStream !== 'undefined' ? new MediaStream() : { getTracks: () => [], getAudioTracks: () => [] }) as MediaStream;
  };
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = getUserMedia;
  else Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  class StandInRecorder {
    state = 'inactive';
    mimeType = 'audio/mp4';
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    constructor(public stream: MediaStream) {}
    static isTypeSupported(t: string) {
      return t.startsWith('audio/mp4');
    }
    start() {
      this.state = 'recording';
    }
    stop() {
      this.state = 'inactive';
      setTimeout(() => this.onstop?.(), 10);
    }
  }
  (window as unknown as { MediaRecorder: unknown }).MediaRecorder = StandInRecorder;
};

/** An on-screen keyboard: the visual viewport shrinks to `height` (the layout viewport doesn't, as on iPhone); 0 restores it. */
async function keyboard(page: Page, height: number) {
  await page.evaluate((h) => {
    const w = window as unknown as { __realVV?: VisualViewport | null };
    if (!('__realVV' in w)) w.__realVV = window.visualViewport;
    if (!h) {
      Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => w.__realVV });
      window.dispatchEvent(new Event('resize'));
      return;
    }
    const fake = new EventTarget();
    Object.defineProperties(fake, {
      width: { get: () => window.innerWidth },
      height: { value: h },
      offsetTop: { value: 0 },
      offsetLeft: { value: 0 },
      pageTop: { value: 0 },
      pageLeft: { value: 0 },
      scale: { value: 1 },
    });
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => fake });
    window.dispatchEvent(new Event('resize'));
  }, height);
}

async function signedIn(page: Page): Promise<void> {
  const org = await prisma.organization.create({ data: { name: testVenueName('voice-layout') } });
  const location = await prisma.location.create({ data: { organizationId: org.id, name: 'The Example Room' } });
  const user = await prisma.user.create({ data: { locationId: location.id, systemRole: 'MANAGER', fullName: 'E2E Voice Layout' } });
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 86_400_000);
  await prisma.session.create({ data: { userId: user.id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt } });
  const stored = JSON.stringify({ token, expiresAt: expiresAt.toISOString(), user: { id: user.id, fullName: 'E2E Voice Layout', jobTitle: null, locationId: location.id, systemRole: 'MANAGER' } });
  await page.addInitScript(STAND_IN_MIC);
  await page.goto('/login');
  await page.evaluate(([s, id]) => {
    localStorage.setItem('shiftsync.session', s);
    localStorage.setItem(`shiftsync.voiceConsent.${id}`, '1');
  }, [stored, user.id] as const);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Start recording a voice command' })).toBeVisible({ timeout: 30_000 });
}

/** Fully inside the visible area (no scrolling needed) and at least 44 px each way. */
async function expectReachable(locator: Locator, visible: { width: number; height: number }, what: string) {
  const box = await locator.boundingBox();
  expect(box, `${what}: on screen`).not.toBeNull();
  const b = box!;
  expect(b.y, `${what}: top`).toBeGreaterThanOrEqual(-0.5);
  expect(b.y + b.height, `${what}: bottom ≤ ${visible.height}`).toBeLessThanOrEqual(visible.height + 0.5);
  expect(b.x, `${what}: left`).toBeGreaterThanOrEqual(-0.5);
  expect(b.x + b.width, `${what}: right`).toBeLessThanOrEqual(visible.width + 0.5);
  expect(Math.min(b.width, b.height), `${what}: 44 px target`).toBeGreaterThanOrEqual(44);
}

const stage = (page: Page) => page.locator('.voice-stage > [role="dialog"]');

async function closeStage(page: Page) {
  await stage(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.voice-stage')).toHaveCount(0);
  await settleOverlayHistory(page);
}

/** Opens one state of the sheet and checks its bottom row at every size and motion setting. */
async function everySize(page: Page, open: () => Promise<void>, check: (visible: { width: number; height: number }, label: string) => Promise<void>, after: () => Promise<void>) {
  for (const size of SIZES) {
    for (const reduced of [false, true]) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
      await keyboard(page, size.keyboard);
      await open();
      await page.waitForTimeout(reduced ? 100 : 700);
      await check({ width: size.width, height: size.keyboard || size.height }, `${size.name}${reduced ? ', reduced motion' : ''}`);
      await after();
      await keyboard(page, 0);
    }
  }
}

test.describe('voice sheet: the bottom row is always reachable', () => {
  test('typed command, no problem: Show preview, the mic and Cancel', async ({ page }) => {
    await signedIn(page);
    await everySize(
      page,
      async () => {
        await page.getByRole('button', { name: 'Type a command' }).click();
        await stage(page).getByLabel("Type what you'd say").fill('Who is on the terrace tonight?');
      },
      async (visible, label) => {
        await expectReachable(stage(page).getByRole('button', { name: 'Show preview' }), visible, `Show preview (${label})`);
        await expectReachable(stage(page).getByRole('button', { name: 'Start recording a voice command' }), visible, `mic (${label})`);
        await expectReachable(stage(page).getByRole('button', { name: 'Cancel' }), visible, `Cancel (${label})`);
      },
      () => closeStage(page),
    );
  });

  test('offline (a problem message): Show preview, the mic and Cancel stay on screen', async ({ page, context }) => {
    await signedIn(page);
    await everySize(
      page,
      async () => {
        await context.setOffline(true);
        await page.getByRole('button', { name: 'Start recording a voice command' }).click();
        await expect(stage(page).getByRole('alert')).toBeVisible();
        await stage(page).getByLabel('Type it instead').fill("Who's working tonight?");
      },
      async (visible, label) => {
        await expectReachable(stage(page).getByRole('button', { name: 'Show preview' }), visible, `Show preview (${label})`);
        await expectReachable(stage(page).getByRole('button', { name: 'Start recording a voice command' }), visible, `mic (${label})`);
        await expectReachable(stage(page).getByRole('button', { name: 'Cancel' }), visible, `Cancel (${label})`);
      },
      async () => {
        await closeStage(page);
        await context.setOffline(false);
      },
    );
  });

  test('microphone off (the longest problem message, with the iPhone steps): the bottom row stays on screen', async ({ page }) => {
    await signedIn(page);
    await page.evaluate(() => ((window as unknown as { __mic: { deny: boolean } }).__mic.deny = true));
    await everySize(
      page,
      async () => {
        await page.getByRole('button', { name: 'Start recording a voice command' }).click();
        await expect(page.getByRole('dialog', { name: 'Microphone is off' })).toBeVisible();
      },
      async (visible, label) => {
        await expectReachable(stage(page).getByRole('button', { name: 'Show preview' }), visible, `Show preview (${label})`);
        await expectReachable(stage(page).getByRole('button', { name: 'Start recording a voice command' }), visible, `mic (${label})`);
        await expectReachable(stage(page).getByRole('button', { name: 'Cancel' }), visible, `Cancel (${label})`);
      },
      () => closeStage(page),
    );
  });

  test('listening: the stop button, the keyboard and Cancel stay on screen', async ({ page }) => {
    await signedIn(page);
    await page.route('**/api/voice/**', (route) => route.fulfill({ status: 500, body: '{}' }));
    await everySize(
      page,
      async () => {
        await page.getByRole('button', { name: 'Start recording a voice command' }).click();
        await expect(stage(page).getByRole('button', { name: 'Stop recording voice command' })).toBeVisible();
      },
      async (visible, label) => {
        await expectReachable(stage(page).getByRole('button', { name: 'Stop recording voice command' }), visible, `stop (${label})`);
        await expectReachable(stage(page).getByRole('button', { name: 'Type instead' }), visible, `keyboard (${label})`);
        await expectReachable(stage(page).getByRole('button', { name: 'Cancel' }), visible, `Cancel (${label})`);
      },
      () => closeStage(page),
    );
  });

  test('variant B (the alternative layout, in the development preview of the same sheet): the bottom row stays on screen', async ({ page }) => {
    for (const [state, buttons] of [
      ['typing', ['Show preview', 'Start recording a voice command', 'Cancel']],
      ['problem-mic', ['Show preview', 'Start recording a voice command', 'Cancel']],
      ['listening', ['Stop recording voice command', 'Type instead', 'Cancel']],
    ] as const) {
      for (const size of SIZES) {
        for (const reduced of [false, true]) {
          await page.setViewportSize({ width: size.width, height: size.height });
          await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
          await page.goto(`/dev/voice?view=stage&variant=b&state=${state}`);
          await expect(stage(page)).toBeVisible();
          await keyboard(page, size.keyboard);
          await page.waitForTimeout(reduced ? 150 : 700);
          for (const name of buttons) {
            await expectReachable(stage(page).getByRole('button', { name }), { width: size.width, height: size.keyboard || size.height }, `B ${state}: ${name} (${size.name}${reduced ? ', reduced motion' : ''})`);
          }
        }
      }
    }
  });
});
