import type { OtpPurpose } from '@prisma/client';
import { isFlagOn, isProduction } from './productionGuards.js';

/**
 * The dev-OTP echo is FAIL-CLOSED and opt-in: it is only ever enabled when
 * `ALLOW_DEV_OTP_ECHO` is explicitly set to 'true'. It deliberately does NOT
 * key off `NODE_ENV`, because nothing in this repo's scripts, Dockerfile or
 * start command ever sets `NODE_ENV=production` — a `NODE_ENV !== 'production'`
 * check would therefore leak every real OTP by default. Gate both the HTTP
 * echo and the plaintext server-log line on this one flag.
 *
 * Read per call, not at module load, so the boot-time guard in
 * lib/productionGuards.ts and this stay in agreement with the live env (and
 * so tests can flip it).
 */
export function devOtpEchoEnabled(): boolean {
  return isFlagOn('ALLOW_DEV_OTP_ECHO');
}

/**
 * One place for the three request-otp routes to log the echoed code. In
 * production this also shouts on EVERY request, not just at boot: the boot
 * line scrolls out of a log tail in minutes, but a warning beside each
 * leaked code is impossible to miss when someone asks why login is
 * unauthenticated.
 */
export function logDevOtpEcho(scope: string, phone: string, purpose: OtpPurpose, plainCode: string): void {
  if (isProduction()) {
    console.warn(
      `[SECURITY] ALLOW_DEV_OTP_ECHO is on in production — the ${purpose} code for ${phone} was returned to the requester. Turn the flag off.`,
    );
  }
  console.log(`[${scope}] OTP for ${phone} (${purpose}): ${plainCode} — dev echo enabled via ALLOW_DEV_OTP_ECHO.`);
}
