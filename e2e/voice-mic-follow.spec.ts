import { test, expect } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupTestOrgs, prisma, testVenueName } from './helpers';

/**
 * The listening orb follows the microphone (Chromium, fake audio device): a generated recording
 * that is silent for 2 s, speech-like and loud for 2 s, then silent again is fed in as the
 * microphone. While it plays, the orb's level, speed and outer ring must rise with the loud part
 * and settle back after it — read both from the orb loop (development-only probe) and from the
 * pixels of the outer ring on the canvas. Nothing is sent: the sheet is closed while recording.
 */

const RATE = 48_000;

/** 16-bit mono WAV: silence, a voiced "speech-like" stretch (harmonics, wobbling pitch, syllable swells), silence. */
function micFollowWav(): Buffer {
  const seconds = [2, 2, 3];
  const n = Math.round(RATE * seconds.reduce((a, b) => a + b, 0));
  const pcm = new Int16Array(n);
  const loudFrom = RATE * seconds[0]!;
  const loudTo = loudFrom + RATE * seconds[1]!;
  let phase = 0;
  for (let i = loudFrom; i < loudTo; i++) {
    const t = (i - loudFrom) / RATE;
    const f0 = 150 + 35 * Math.sin(2 * Math.PI * 0.9 * t) + 12 * Math.sin(2 * Math.PI * 5.3 * t);
    phase += (2 * Math.PI * f0) / RATE;
    const voiced = 0.55 * Math.sin(phase) + 0.25 * Math.sin(2 * phase) + 0.15 * Math.sin(3 * phase) + 0.08 * Math.sin(5 * phase);
    const syllables = 0.55 + 0.45 * Math.abs(Math.sin(2 * Math.PI * 2.1 * t));
    const edge = Math.min(1, t / 0.05, (seconds[1]! - t) / 0.05);
    pcm[i] = Math.round(Math.max(-1, Math.min(1, 0.6 * voiced * syllables * edge)) * 32767);
  }
  const data = Buffer.from(pcm.buffer);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const WAV = join(tmpdir(), 'shiftsync-mic-follow.wav');
writeFileSync(WAV, micFollowWav());

/** Where the run's evidence (the WAV, the frames, the numbers) is kept on the owner's machine. */
const EVIDENCE = 'C:/dev/_autonomous-run-artifacts/run15-screens/final/mic-follow';
const keepEvidence = process.platform === 'win32';

test.use({
  permissions: ['microphone'],
  viewport: { width: 390, height: 844 },
  launchOptions: {
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
    // %noloop: the file plays once, then the "microphone" is silent.
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${WAV}%noloop`],
  },
});

test.afterEach(async () => {
  await cleanupTestOrgs();
});

interface ProbeFrame {
  t: number;
  state: string;
  level: number;
  rate: number;
  ring: number;
}

test('the listening orb follows the microphone: level, speed and outer ring rise with a loud voice and settle after', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium has the fake audio-file device');
  test.setTimeout(90_000);
  const org = await prisma.organization.create({ data: { name: testVenueName('mic-follow') } });
  const location = await prisma.location.create({ data: { organizationId: org.id, name: org.name } });
  const user = await prisma.user.create({ data: { locationId: location.id, systemRole: 'MANAGER', fullName: 'E2E Mic Follow' } });
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 86_400_000);
  await prisma.session.create({ data: { userId: user.id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt } });
  const stored = JSON.stringify({ token, expiresAt: expiresAt.toISOString(), user: { id: user.id, fullName: 'E2E Mic Follow', jobTitle: null, locationId: location.id, systemRole: 'MANAGER' } });
  let sent = 0;
  await page.route('**/api/voice/**', async (route) => {
    sent++;
    await route.fulfill({ status: 500, body: '{}' });
  });

  await page.goto('/login');
  await page.evaluate(([s, id]) => {
    localStorage.setItem('shiftsync.session', s);
    localStorage.setItem(`shiftsync.voiceConsent.${id}`, '1');
  }, [stored, user.id] as const);
  await page.goto('/');
  await page.evaluate(() => ((window as unknown as { __voiceOrbProbe: unknown[] }).__voiceOrbProbe = []));

  await page.getByRole('button', { name: 'Start recording a voice command' }).click();
  const stage = page.locator('.voice-stage > [role="dialog"]');
  await expect(stage.getByRole('button', { name: 'Stop recording voice command' })).toBeVisible();
  const canvas = stage.locator('canvas');
  await expect(canvas).toBeVisible();
  const t0 = await page.evaluate(() => performance.now());

  /** Ink in the outer ring's band of the canvas (outside the sphere's dots), as a sum of alpha. */
  const ringInk = () =>
    canvas.evaluate((c: HTMLCanvasElement) => {
      const ctx = c.getContext('2d')!;
      const { width: w, height: h } = c;
      const px = ctx.getImageData(0, 0, w, h).data;
      const R = w / 2;
      let sum = 0;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const r = Math.hypot(x + 0.5 - R, y + 0.5 - R) / R;
          if (r >= 0.91 && r <= 0.99) sum += px[(y * w + x) * 4 + 3]!;
        }
      return sum;
    });

  if (keepEvidence) {
    mkdirSync(EVIDENCE, { recursive: true });
    copyFileSync(WAV, `${EVIDENCE}/mic-follow-input.wav`);
  }
  const ink: { at: number; ink: number }[] = [];
  const frames = new Map([[1.2, '1-silent'], [3.2, '2-loud'], [6.2, '3-silent-after']]);
  for (let at = 0.2; at <= 6.8; at = Math.round((at + 0.2) * 10) / 10) {
    const now = await page.evaluate(() => performance.now());
    const wait = t0 + at * 1000 - now;
    if (wait > 0) await page.waitForTimeout(wait);
    ink.push({ at, ink: await ringInk() });
    const name = frames.get(at);
    if (name && keepEvidence) await stage.screenshot({ path: `${EVIDENCE}/${name}.png` });
  }

  // Close while recording: the microphone is released and nothing is sent.
  await stage.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.voice-stage')).toHaveCount(0);

  const probe = (await page.evaluate(() => (window as unknown as { __voiceOrbProbe: ProbeFrame[] }).__voiceOrbProbe)).filter((f) => f.state === 'listening');
  const between = (from: number, to: number) => {
    const fs = probe.filter((f) => f.t - t0 >= from * 1000 && f.t - t0 <= to * 1000);
    const mean = (k: keyof ProbeFrame) => fs.reduce((a, f) => a + (f[k] as number), 0) / Math.max(1, fs.length);
    const inkIn = ink.filter((s) => s.at >= from && s.at <= to);
    return { frames: fs.length, level: mean('level'), rate: mean('rate'), ring: mean('ring'), ringInk: inkIn.reduce((a, s) => a + s.ink, 0) / Math.max(1, inkIn.length) };
  };
  const silentBefore = between(0.6, 1.8);
  const loud = between(2.6, 3.8);
  const silentAfter = between(5.0, 6.6);
  const summary = { silentBefore, loud, silentAfter };
  if (keepEvidence) writeFileSync(`${EVIDENCE}/mic-follow-result.json`, JSON.stringify({ summary, ink, probeFrames: probe.length }, null, 2));
  console.log(`[mic-follow] ${JSON.stringify(summary)}`);

  for (const w of [silentBefore, loud, silentAfter]) expect(w.frames).toBeGreaterThan(10);
  // Loud: the level rises, the orb runs clearly faster, and the outer ring appears.
  expect(loud.level).toBeGreaterThan(0.3);
  expect(loud.level - silentBefore.level).toBeGreaterThan(0.25);
  expect(loud.rate).toBeGreaterThan(silentBefore.rate * 1.3);
  expect(loud.ring).toBeGreaterThan(0.15);
  expect(loud.ringInk).toBeGreaterThan(Math.max(1000, silentBefore.ringInk * 5));
  // Silent before and after: no ring, base speed — it settles back once the voice stops.
  expect(silentBefore.ring).toBeLessThan(0.02);
  expect(silentAfter.ring).toBeLessThan(0.02);
  expect(silentAfter.level).toBeLessThan(0.05);
  expect(Math.abs(silentAfter.rate - silentBefore.rate)).toBeLessThan(silentBefore.rate * 0.1);
  expect(silentAfter.ringInk).toBeLessThan(loud.ringInk / 5);
  expect(sent).toBe(0);
});
