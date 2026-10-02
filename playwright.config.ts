import { defineConfig, devices } from '@playwright/test';
import { FAKE_GEMINI_URL } from './e2e/fakeGemini';

// The API echoes OTPs only for ECHO_ALLOWED_PHONES, so each run gets its own pool of
// numbers (handed out by e2e/helpers.ts `nextEchoPhone`). Workers re-evaluate this file;
// `??=` keeps the runner's values, which they inherit.
const ECHO_POOL_SIZE = 300;
process.env.E2E_RUN_ID ??= String(Date.now());
// A different 300-number block of +97156xxxxxxx every second (cycles after ~9h).
const echoBlock = Math.floor(Number(process.env.E2E_RUN_ID) / 1000) % Math.floor(10_000_000 / ECHO_POOL_SIZE);
const echoPhones = (process.env.E2E_ECHO_PHONES ??= Array.from(
  { length: ECHO_POOL_SIZE },
  (_, i) => `+97156${String(echoBlock * ECHO_POOL_SIZE + i).padStart(7, '0')}`,
).join(','));

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 90_000,
  // A cold dev-server start (first tsx compile + first pooled-Postgres
  // connection) can make the very first test of a fresh run miss its
  // timeout even with globalSetup's warm-up query — every later test in the
  // same run hits an already-warm server and is unaffected. One retry
  // absorbs that one-time cost instead of the whole suite intermittently
  // failing on a fresh invocation.
  retries: 1,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Opt-in system Chromium (e.g. a CI/container image that ships its own
        // build under a different revision than this Playwright version
        // bundles). Unset = Playwright's own managed browser, as before.
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
          ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } }
          : {}),
      },
    },
  ],
  webServer: [
    {
      command: 'npm run server:dev',
      url: 'http://localhost:4000/api/health',
      reuseExistingServer: !process.env.CI,
      // ALLOW_DEV_ERROR_INJECTION arms requireSession's sentinel-token throw
      // (see require-session-error-handling.spec.ts) — same dev-only-flag
      // shape as ALLOW_DEV_OTP_ECHO, inert for any real token.
      // A reused (already running) API won't have this run's ECHO_ALLOWED_PHONES.
      // GEMINI_BASE_URL sends only the voice pipeline's Gemini calls to e2e/fakeGemini.ts
      // (no key, no quota); roster vision parsing never reads it.
      env: { ALLOW_DEV_OTP_ECHO: 'true', ECHO_ALLOWED_PHONES: echoPhones, ALLOW_DEV_ERROR_INJECTION: 'true', GEMINI_BASE_URL: FAKE_GEMINI_URL },
      timeout: 60_000,
    },
    {
      command: 'node --import tsx e2e/fakeGemini.ts --serve',
      url: `${FAKE_GEMINI_URL}/__health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: 'npm run dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
