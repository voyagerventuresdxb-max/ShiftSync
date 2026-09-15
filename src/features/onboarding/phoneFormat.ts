/**
 * Pure Invite-screen phone-formatting logic, kept in its own CSS-free
 * module (separate from InviteScreen.tsx, which imports
 * OnboardingScreenShell.tsx, which imports a real .css file — that import
 * breaks under `node --test`/tsx's Node-ESM loader, which has no CSS
 * handling the way Vite's bundler does) so this logic stays independently
 * unit-testable. See InviteScreen.test.ts.
 */

/**
 * Strips a leading UAE country code (`+971` or bare `971`) from a phone
 * string, if present. Applied to BOTH the persisted value and a manager's
 * own in-progress draft (not just the former): the input shows a static
 * "+971" label beside it, so a manager who types/pastes a full number
 * including the country code out of habit must not have it end up
 * double-prepended (`+971971...`) when `commitPhone` re-adds the "+971"
 * prefix.
 */
export function stripUaeCountryCode(raw: string): string {
  return raw.trim().replace(/^\+?971/, '').trim();
}
