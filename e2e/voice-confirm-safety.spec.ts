import { test, expect } from '@playwright/test';
import { cleanupTestOrgs, prisma } from './helpers';
import { alexShoutout, confirmSheet, signIn, stage, stubVoice, usedPhones } from './voiceHarness';

/**
 * Run 17 voice Confirm safety in the app (every /api/voice/* call answered by the test; made-up
 * names): one key per preview, kept on a retry; a Confirm refused because the preview changed
 * reads the words again and shows the latest; the announcement card states the server's count;
 * a recording refused as too short says so plainly.
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

async function typeCommand(page: import('@playwright/test').Page, text: string) {
  await page.getByRole('button', { name: 'Type a command' }).click();
  await stage(page).getByLabel("Type what you'd say").fill(text);
  await stage(page).getByRole('button', { name: 'Show preview' }).click();
}

type Keyed = { idempotencyKey?: string };

test('one key per preview: a retry after a timeout sends the same key; a new preview gets a new key', async ({ page }) => {
  await page.addInitScript(() => ((window as unknown as { __shiftsyncVoiceTimeoutMs: number }).__shiftsyncVoiceTimeoutMs = 800));
  await signIn(page, 'MANAGER');
  const calls = await stubVoice(page, {
    parse: [alexShoutout('Great job'), alexShoutout('Great job tonight')],
    execute: [{ body: { executed: true, result: {} }, delayMs: 1600 }, { body: { executed: true, result: {} } }],
  });
  await typeCommand(page, 'Give Alex a shout-out saying great job');
  const sheet = confirmSheet(page, 'You typed');
  await sheet.getByRole('button', { name: 'Confirm' }).click();
  // No answer in time: the sheet stays, saying it may have gone through.
  await expect(sheet.getByText(/may still have gone through/)).toBeVisible();
  await sheet.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.locator('.success-block')).toContainText('Done:');
  const [first, retry] = calls.execute as Keyed[];
  expect(first!.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{16,100}$/);
  expect(retry!.idempotencyKey).toBe(first!.idempotencyKey);

  // A new preview: a new key.
  await typeCommand(page, 'Give Alex a shout-out saying great job tonight');
  await confirmSheet(page, 'You typed').getByRole('button', { name: 'Confirm' }).click();
  await expect(page.locator('.success-block')).toContainText('Done:');
  expect((calls.execute[2] as Keyed).idempotencyKey).not.toBe(first!.idempotencyKey);
});

test('a Confirm refused because things changed reads the words again and shows the latest; nothing was done', async ({ page }) => {
  await signIn(page, 'MANAGER');
  const announcement = (recipients: number) => ({
    intent: 'POST_ANNOUNCEMENT',
    content: 'Staff meeting Monday at 3.',
    recipients,
    fingerprint: `fp-${recipients}`,
    confidence: 0.95,
    summary: 'Post this announcement to the venue.',
  });
  const calls = await stubVoice(page, {
    parse: [announcement(3), announcement(4)],
    execute: [
      { status: 409, body: { error: 'Things changed since this preview, so nothing was sent. Check the latest and confirm again.', errorCode: 'voice_preview_changed' } },
      { body: { executed: true, result: {} } },
    ],
  });
  await typeCommand(page, 'Post an announcement: staff meeting Monday at 3');
  const sheet = confirmSheet(page, 'You typed');
  // The server's count, not a guess.
  await expect(sheet.getByText('3 people will be notified.')).toBeVisible();
  await sheet.getByRole('button', { name: /^Confirm|^Post/ }).first().click();
  // Read again: the latest count, and why.
  await expect(sheet.getByText('4 people will be notified.')).toBeVisible();
  await expect(sheet.getByText('Things changed since that preview, so nothing was sent.', { exact: false })).toBeVisible();
  await expect(page.locator('.success-block')).toHaveCount(0);
  expect(calls.parse.map((c) => c.transcript)).toEqual(['Post an announcement: staff meeting Monday at 3', 'Post an announcement: staff meeting Monday at 3']);
  // Confirm the latest: it carries the latest fingerprint and a new key.
  await sheet.getByRole('button', { name: /^Confirm|^Post/ }).first().click();
  await expect(page.locator('.success-block')).toContainText('Done:');
  expect(calls.execute[1]!.intent.fingerprint).toBe('fp-4');
  expect((calls.execute[1] as Keyed).idempotencyKey).not.toBe((calls.execute[0] as Keyed).idempotencyKey);
});

test('a recording refused as too short says so plainly, with the typed box', async ({ page }) => {
  await signIn(page, 'MANAGER');
  await page.route('**/api/voice/transcribe', (route) =>
    route.fulfill({
      status: 422,
      contentType: 'application/json',
      body: JSON.stringify({ error: "I didn't hear anything: the recording was empty or too short. Tap the mic and speak, or type your command below.", errorCode: 'voice_audio_too_short' }),
    }),
  );
  await page.getByRole('button', { name: 'Start recording a voice command' }).click();
  await expect(stage(page).getByRole('button', { name: 'Stop recording voice command' })).toBeVisible();
  await page.waitForTimeout(700);
  await stage(page).getByRole('button', { name: 'Stop recording voice command' }).click({ force: true });
  await expect(stage(page).getByText("Didn't hear anything", { exact: true })).toBeVisible();
  await expect(stage(page).getByText(/the recording was empty or too short/)).toBeVisible();
  await expect(stage(page).getByLabel('Type it instead')).toBeVisible();
});
