/**
 * The one-time "You're in" screen a staff member sees on their very first
 * sign-in after a manager approved them (or after their phone matched the
 * roster). The sign-in screens stash the venue name here before storing the
 * session; `/welcome` reads it once and clears it, then hands over to My
 * Shifts. sessionStorage: it is per tab and never outlives the browser
 * session, so it can't leak into another person's sign-in on a shared device.
 */
const KEY = 'shiftsync.welcome';

export const WELCOME_PATH = '/welcome';
export const STAFF_LOGIN_PATH = '/login?as=staff';

export function shouldShowStaffWelcome(result: { firstSignIn?: boolean; user: { systemRole: string } }): boolean {
  return result.firstSignIn === true && result.user.systemRole === 'STAFF';
}

export function stashStaffWelcome(venueName: string | undefined): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ venueName: venueName ?? null }));
  } catch {
    // Storage unavailable (private mode quirks): the welcome is skipped, nothing else changes.
  }
}

export function takeStaffWelcome(): { venueName: string | null } | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    sessionStorage.removeItem(KEY);
    return JSON.parse(raw) as { venueName: string | null };
  } catch {
    return null;
  }
}

export function hasStaffWelcome(): boolean {
  try {
    return sessionStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
}
