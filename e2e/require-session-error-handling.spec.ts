import { test, expect } from '@playwright/test';
import { cleanupTestOrgs, signupNewVenue, testVenueName } from './helpers';

/**
 * Regression coverage for the requireSession crash fix (see MEMORY.md):
 * an unexpected thrown error inside the session-auth middleware used to
 * become an unhandled promise rejection — Express 4 doesn't auto-catch a
 * rejected promise from middleware — which crashed the entire Node process
 * for every connected user, not just fail the one request. The fix wraps
 * requireSession in try/catch and forwards via next(err) to app.ts's
 * existing error handler.
 *
 * The original trigger (a stale Session row racing a concurrent User
 * delete) isn't reliably forceable from outside the process — empirically
 * confirmed via 30 trials of real concurrent requests racing a real delete,
 * zero reproductions. Rather than mock anything, this uses the same
 * dev-only-env-flag pattern already established for ALLOW_DEV_OTP_ECHO:
 * ALLOW_DEV_ERROR_INJECTION (armed in playwright.config.ts's backend
 * webServer env) makes requireSession throw for one specific sentinel
 * bearer token — a real throw, through the real middleware, real
 * try/catch, real next(err), real app.ts error handler — just
 * deterministically triggered instead of relying on rare timing.
 */

test.describe('requireSession — thrown error does not crash the server', () => {
  test.afterEach(async ({ page }) => {
    await page.close().catch(() => {});
    await cleanupTestOrgs();
  });

  test('a deliberately-thrown error returns a proper response, the process survives, and a concurrent valid request is unaffected', async ({ page, request }) => {
    const venueName = testVenueName('requiresession-error');
    await signupNewVenue(page, venueName);

    const stored = await page.evaluate(() => localStorage.getItem('shiftsync.session'));
    expect(stored).toBeTruthy();
    const { token, user } = JSON.parse(stored!) as { token: string; user: { locationId: string } };

    const [badResponse, goodResponse] = await Promise.all([
      request.get(`/api/staff-directory/${user.locationId}`, {
        headers: { Authorization: 'Bearer __test-inject-requiresession-error__' },
      }),
      request.get(`/api/staff-directory/${user.locationId}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ]);

    // The thrown error reached app.ts's real error handler (400, not a
    // connection reset / no response at all).
    expect(badResponse.status()).toBe(400);
    const badBody = (await badResponse.json()) as { error: string };
    expect(badBody.error).toContain('Deliberate test-injected error');

    // A concurrent, real, valid request was completely unaffected.
    expect(goodResponse.status()).toBe(200);

    // The server process itself survived — not just this one connection.
    const health = await request.get('/api/health');
    expect(health.status()).toBe(200);

    // And it keeps serving normally afterward, not in some degraded state.
    const followUp = await request.get(`/api/staff-directory/${user.locationId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(followUp.status()).toBe(200);
  });
});
