import type { OtpPurpose } from '@prisma/client';
import { toE164 } from './phone.js';

/**
 * Dev-OTP echo: with no SMS provider (#51), request-otp can hand the plaintext
 * code back (JSON `devCode` + one server-log line). Fail-closed and opt-in:
 * `ALLOW_DEV_OTP_ECHO` must be exactly 'true' AND the number must be listed in
 * `ECHO_ALLOWED_PHONES`, so the echo can never sign anyone in as an arbitrary
 * number. Everything here reads the env per call, so tests can vary it.
 */
export function devOtpEchoEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ALLOW_DEV_OTP_ECHO === 'true';
}

let cached: { raw: string; parsed: { phones: Set<string>; invalid: string[] } } | null = null;

/** `ECHO_ALLOWED_PHONES` (comma-separated, any format `toE164` accepts) as E.164, plus the entries it rejected. */
export function echoAllowedPhones(env: NodeJS.ProcessEnv = process.env): { phones: Set<string>; invalid: string[] } {
  const raw = env.ECHO_ALLOWED_PHONES ?? '';
  // Parsed on every request-otp call; libphonenumber is too slow to re-run a long e2e list each time.
  if (cached?.raw === raw) return cached.parsed;
  const phones = new Set<string>();
  const invalid: string[] = [];
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const e164 = toE164(entry);
    if (e164) phones.add(e164);
    else invalid.push(entry);
  }
  cached = { raw, parsed: { phones, invalid } };
  return cached.parsed;
}

/** Whether request-otp may echo the code for `e164` (already normalized by `toE164`). */
export function devOtpEchoFor(e164: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return devOtpEchoEnabled(env) && echoAllowedPhones(env).phones.has(e164);
}

/** The one plaintext-code log line, shared by the three request-otp routes. Call only when `devOtpEchoFor` is true. */
export function logDevOtpEcho(scope: string, phone: string, purpose: OtpPurpose, plainCode: string): void {
  console.log(`[${scope}] OTP for ${phone} (${purpose}): ${plainCode} — dev echo enabled via ALLOW_DEV_OTP_ECHO.`);
}
