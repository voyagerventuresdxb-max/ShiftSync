import { defineConfig, devices } from '@playwright/test';

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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run server:dev',
      url: 'http://localhost:4000/api/health',
      reuseExistingServer: !process.env.CI,
      // ALLOW_DEV_ERROR_INJECTION arms requireSession's sentinel-token throw
      // (see require-session-error-handling.spec.ts) — same dev-only-flag
      // shape as ALLOW_DEV_OTP_ECHO, inert for any real token.
      // LOGIN_METHODS=otp: the onboarding/signup specs create accounts by
      // phone code; login links work in either mode (see login-links.spec.ts).
      env: { ALLOW_DEV_OTP_ECHO: 'true', ALLOW_DEV_ERROR_INJECTION: 'true', LOGIN_METHODS: 'otp' },
      timeout: 60_000,
    },
    {
      command: 'npm run dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
