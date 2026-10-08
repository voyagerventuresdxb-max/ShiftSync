import { test, expect } from '@playwright/test';
import { cleanupTestOrgs, prisma } from './helpers';
import { alexShoutout, confirmSheet, micTracks, record, setHidden, signIn, stage, startRecording, stubVoice, trackMicrophone, usedPhones } from './voiceHarness';

/**
 * Voice bug hunt: each test reproduces one defect found by hand or by the state-machine fuzz
 * (e2e/voice-fuzz.spec.ts) and fails without its fix. Every /api/voice/* call is stubbed; names
 * are made up. See docs/voice-bug-hunt.md.
 */

test.use({
  permissions: ['microphone'],
  viewport: { width: 390, height: 844 },
  launchOptions: {
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  },
});

test.afterEach(async ({ page }) => {
  await page.close().catch(() => {});
  await cleanupTestOrgs();
  await prisma.otpCode.deleteMany({ where: { phone: { in: usedPhones.splice(0) } } });
});

test('a new recording never shows the last command\'s words: nothing under "Listening" but this recording', async ({ page }) => {
  await signIn(page, 'MANAGER');
  const first = 'Give Alex a shout-out for the spotless bar';
  const second = 'Give Alex a shout-out for closing up';
  await stubVoice(page, { transcript: [first, second], parse: [alexShoutout('Spotless bar'), alexShoutout('Closing up')] });

  await record(page);
  const sheet = confirmSheet(page);
  await expect(sheet.getByText(`“${first}”`)).toBeVisible();
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(stage(page)).toHaveCount(0);

  // The next recording: while listening, the sheet has no words yet (no live captions).
  await startRecording(page);
  await expect(stage(page).getByText('Listening', { exact: true })).toBeVisible();
  await expect(stage(page).getByText('I heard', { exact: true })).toHaveCount(0);
  await expect(stage(page).getByText(first)).toHaveCount(0);
  await page.waitForTimeout(400);
  await stage(page).getByRole('button', { name: 'Stop recording voice command' }).click({ force: true });
  // Its own words appear once transcribed.
  await expect(confirmSheet(page).getByText(`“${second}”`)).toBeVisible();
});

test('after a recording that could not be understood, the next recording starts with no words on screen', async ({ page }) => {
  await signIn(page, 'MANAGER');
  const heard = 'Give Alex a shout-out for the spotless bar';
  await stubVoice(page, { transcript: heard, parse: [{ status: 503, body: { error: 'Voice commands aren’t available right now — try again later.' } }] });
  await record(page);
  // The words are kept in the typed box (so they can be sent by typing).
  await expect(stage(page).getByLabel('Type it instead')).toHaveValue(heard);
  // The mic from the typed box: listening shows nothing from before.
  await stage(page).getByRole('button', { name: 'Start recording a voice command' }).click();
  await expect(stage(page).getByRole('button', { name: 'Stop recording voice command' })).toBeVisible();
  await expect(stage(page).getByText('I heard', { exact: true })).toHaveCount(0);
  await expect(stage(page).getByText(heard)).toHaveCount(0);
  await stage(page).getByRole('button', { name: 'Close' }).click();
});

test('the app going to the background while recording turns the microphone off, sends nothing, and says so on return', async ({ page }) => {
  await trackMicrophone(page);
  await signIn(page, 'MANAGER');
  const calls = await stubVoice(page, { transcript: 'should never be sent', parse: [alexShoutout('x')] });
  await startRecording(page);
  await page.waitForTimeout(400);
  await setHidden(page, true);
  await expect.poll(() => micTracks(page)).toEqual(['ended']);
  await setHidden(page, false);
  await expect(stage(page).getByText('Recording stopped')).toBeVisible();
  await expect(stage(page).getByText(/went to the background, so the microphone was turned off and nothing was sent/)).toBeVisible();
  await page.waitForTimeout(600);
  expect(calls.transcribe).toBe(0);
  expect(calls.parse).toEqual([]);
});

test('the app going to the background while the microphone is starting: it is released as soon as it arrives', async ({ page }) => {
  await trackMicrophone(page);
  // The permission prompt takes a moment (as on a first use).
  await page.addInitScript(() => {
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => {
      await new Promise((r) => setTimeout(r, 1200));
      return gum(c);
    };
  });
  await signIn(page, 'MANAGER');
  const calls = await stubVoice(page, { transcript: 'should never be sent', parse: [alexShoutout('x')] });
  await page.getByRole('button', { name: 'Start recording a voice command' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Starting the microphone…' })).toBeAttached();
  await setHidden(page, true);
  await expect.poll(() => micTracks(page), { timeout: 5000 }).toEqual(['ended']);
  await setHidden(page, false);
  await expect(stage(page).getByRole('button', { name: 'Stop recording voice command' })).toHaveCount(0);
  await page.waitForTimeout(600);
  expect(calls.transcribe).toBe(0);
});

test('Confirm tapped twice in the same instant sends the command once', async ({ page }) => {
  await signIn(page, 'MANAGER');
  // No voice log id: the server could not tell the two taps apart.
  const calls = await stubVoice(page, {
    parse: [{ body: { transcript: 'Give Alex a shout-out saying great job', intent: alexShoutout('Great job'), voiceLogId: null, hasAdditionalRequest: false } }],
    execute: [{ body: { executed: true, result: {} }, delayMs: 300 }],
  });
  await page.getByRole('button', { name: 'Type a command' }).click();
  await stage(page).getByLabel("Type what you'd say").fill('Give Alex a shout-out saying great job');
  await stage(page).getByRole('button', { name: 'Show preview' }).click();
  const confirm = confirmSheet(page, 'You typed').getByRole('button', { name: 'Confirm' });
  await expect(confirm).toBeEnabled();
  await confirm.evaluate((b: HTMLButtonElement) => {
    b.click();
    b.click();
  });
  await expect(page.locator('.success-block')).toContainText('Done:');
  await page.waitForTimeout(500);
  expect(calls.execute).toHaveLength(1);
});

test('a new command never shows the last command\'s "Which one?" choices or its confirm sheet', async ({ page }) => {
  await signIn(page, 'MANAGER');
  const which = {
    intent: 'UNRECOGNIZED',
    confidence: 0.6,
    summary: 'Which Alex did you mean?',
    reason: 'Two people match.',
    options: [
      alexShoutout('Spotless bar'),
      { ...alexShoutout('Spotless bar'), targetUserId: 'user-alex-2', targetUserName: 'Alex Sample', summary: 'Give Alex Sample a shout-out with this note.', details: { person: 'Alex Sample', personRole: 'Server' } },
    ],
  };
  const calls = await stubVoice(page, { parse: [which, alexShoutout('Closing up')] });
  await page.getByRole('button', { name: 'Type a command' }).click();
  await stage(page).getByLabel("Type what you'd say").fill('Give Alex a shout-out for the spotless bar');
  await stage(page).getByRole('button', { name: 'Show preview' }).click();
  const first = confirmSheet(page, 'You typed');
  await expect(first.getByText('Alex Sample').first()).toBeVisible();
  await first.getByRole('button', { name: 'Cancel' }).click();
  await expect(stage(page)).toHaveCount(0);

  await page.getByRole('button', { name: 'Type a command' }).click();
  // The box starts empty: nothing typed before comes back.
  await expect(stage(page).getByLabel("Type what you'd say")).toHaveValue('');
  await stage(page).getByLabel("Type what you'd say").fill('Give Alex Example a shout-out for closing up');
  await stage(page).getByRole('button', { name: 'Show preview' }).click();
  const second = confirmSheet(page, 'You typed');
  await expect(second.getByText('“Give Alex Example a shout-out for closing up”')).toBeVisible();
  await expect(second.getByText('Closing up', { exact: true })).toBeVisible();
  // Nothing of the earlier choice is left: no second person to pick, no earlier note, no "back to choices".
  await expect(page.getByText('Alex Sample')).toHaveCount(0);
  await expect(page.getByText('Spotless bar', { exact: true })).toHaveCount(0);
  await expect(second.getByRole('button', { name: /choices/i })).toHaveCount(0);
  await expect(page.getByRole('dialog').filter({ hasText: 'You typed' })).toHaveCount(1);
  await second.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.locator('.success-block')).toContainText('Done:');
  expect(calls.execute.map((c) => c.intent.content)).toEqual(['Closing up']);
});
