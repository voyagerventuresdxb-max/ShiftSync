import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

/**
 * A bare local number ("050 123 4567") is read as a UAE number. Anything with
 * an explicit country code ("+44 7700 900123", "0044…") keeps its own country.
 */
const DEFAULT_REGION = 'AE';

/**
 * Canonical E.164 form ("+971501234567") of a MOBILE number, or null if `raw`
 * isn't one. Every phone the app stores or compares goes through this: a
 * phone is the login credential and, once SMS exists (#51), where the code is
 * sent, so it must be a full international mobile number. The old
 * `phoneDigits()` stripped the country code, so two different people could
 * collide (an Indian 9715551234 and a UAE +971 555 1234).
 *
 * `/max` metadata is needed to tell mobile from landline. A landline can't
 * receive an SMS code, so it is rejected.
 */
export function toE164(raw: string): string | null {
  const parsed = parsePhoneNumberFromString(raw.trim(), DEFAULT_REGION);
  if (!parsed || !parsed.isValid()) return null;
  const type = parsed.getType();
  if (type !== 'MOBILE' && type !== 'FIXED_LINE_OR_MOBILE') return null;
  return parsed.number;
}

export const INVALID_PHONE_ERROR = 'Enter a valid mobile number, e.g. 050 123 4567 or +971 50 123 4567.';
