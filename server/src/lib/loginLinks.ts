import { randomBytes } from 'node:crypto';
import { getAllowedFrontendOrigins } from './frontendOrigins.js';
import { LOGIN_LINK_PATH } from '../../../shared/loginLinks.js';

/** LOGIN_LINK_TTL_HOURS — how long a freshly issued link stays redeemable. One value, read fresh so tests can flip it. */
export const DEFAULT_LOGIN_LINK_TTL_HOURS = 24;
export function loginLinkTtlHours(): number {
  const n = Number(process.env.LOGIN_LINK_TTL_HOURS ?? DEFAULT_LOGIN_LINK_TTL_HOURS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LOGIN_LINK_TTL_HOURS;
}

export function loginLinkExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + loginLinkTtlHours() * 60 * 60 * 1000);
}

/**
 * LOGIN_METHODS — which front doors exist.
 *   "links" (default): one-time login links only. The phone-code (OTP)
 *                      routes answer 403 and the OTP screens are hidden;
 *                      a brand-new venue is created by the CLI
 *                      (server/scripts/create-org-shell.ts), never by
 *                      self-signup.
 *   "otp":             the phone-code flows are on as well (local dev and
 *                      the e2e suite, until real SMS/WhatsApp delivery exists).
 * Login links themselves work in both modes.
 */
export type LoginMethods = 'links' | 'otp';
export function loginMethods(): LoginMethods {
  return process.env.LOGIN_METHODS?.trim().toLowerCase() === 'otp' ? 'otp' : 'links';
}
export function otpLoginEnabled(): boolean {
  return loginMethods() === 'otp';
}

/** 256 random bits, base64url (43 chars, URL-fragment safe). Only its sha256 is ever stored. */
export function generateLoginLinkToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The link a person taps. Always the first configured frontend origin — never a caller-supplied base URL. */
export function buildLoginLinkUrl(token: string): string {
  return `${getAllowedFrontendOrigins()[0]}${LOGIN_LINK_PATH}#${token}`;
}

/** "24 hours", "1 hour", "90 minutes" — never "0.5 hours". */
export function formatLoginLinkTtl(hours: number = loginLinkTtlHours()): string {
  if (hours < 1) return `${Math.round(hours * 60)} minutes`;
  const rounded = Math.round(hours * 10) / 10;
  return rounded === 1 ? '1 hour' : `${rounded} hours`;
}

/** The message that goes with the link in the share sheet / WhatsApp. */
export function loginLinkShareText(venueName: string): string {
  return `Tap to sign in to ShiftSync for ${venueName}. This link works once and expires in ${formatLoginLinkTtl()}.`;
}
