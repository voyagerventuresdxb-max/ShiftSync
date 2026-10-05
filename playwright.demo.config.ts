import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * The 5-minute demo (docs/mvp-status.md) as a recorded walkthrough, separate
 * from the test suite: `npm run demo:record`. One video per scene plus one of
 * the whole run, at phone size (390x844), into DEMO_VIDEO_DIR (default
 * test-results/demo-videos; videos are never committed). Starts the same local
 * API, fake Gemini and Vite servers as the e2e suite, so sign-in codes are
 * echoed for this run's made-up numbers only.
 */
export default defineConfig({
  ...base,
  testDir: './e2e/demo',
  testMatch: /.*\.demo\.ts$/,
  grep: undefined,
  grepInvert: undefined,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: 'test-results/demo-run',
  reporter: [['list']],
  use: { ...base.use, trace: 'off', video: 'off' },
  projects: [{ name: 'demo-390', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } }],
});
