import { randomBytes } from 'node:crypto';
import { getAllowedFrontendOrigins } from './inviteLinks.js';
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
 * LOGIN_METHODS — which sign-in methods are on. Login links always work.
 *   unset / anything else: "both" — phone codes (join, login, signup) AND links.
 *   "links":               links only; the six phone-code routes answer 403 otp_disabled.
 * Only an explicit "links" may turn phone codes off.
 */
export type LoginMethods = 'both' | 'links';
export function loginMethods(): LoginMethods {
  return process.env.LOGIN_METHODS?.trim().toLowerCase() === 'links' ? 'links' : 'both';
}
export function otpLoginEnabled(): boolean {
  return loginMethods() !== 'links';
}

/** 256 random bits, base64url (43 chars, URL-fragment safe). Only its sha256 is ever stored. */
export function generateLoginLinkToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The link a person taps. Always the first configured frontend origin — never a caller-supplied base URL. */
export function buildLoginLinkUrl(token: string): string {
  return `${getAllowedFrontendOrigins()[0]}${LOGIN_LINK_PATH}#${token}`;
}

/** The message that goes with the link in the share sheet / WhatsApp. */
export function loginLinkShareText(venueName: string): string {
  return `Tap to sign in to ShiftSync for ${venueName}. This link works once and expires in ${loginLinkTtlHours()} hours.`;
}
