/**
 * Client for the Identity API (server/src/routes/identity.ts) — phone/OTP
 * login for existing staff, and the localStorage-backed session store
 * shared by every screen that needs the logged-in user's Bearer token.
 */
import { ApiError } from './schedules';
export { ApiError };

export interface SessionUser {
  id: string;
  fullName: string;
  jobTitle: string | null;
  locationId: string;
  systemRole: 'OWNER' | 'MANAGER' | 'STAFF';
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // non-JSON error body; keep the generic message
    }
    throw new ApiError(message, res.status);
  }
  return (await res.json()) as T;
}

/**
 * POST /api/identity/request-otp — login path. No `locationId` — the server
 * matches the phone globally across every venue (it's the real cross-venue
 * identity key under this app's one-user-one-location model), which is what
 * lets login work from contexts that don't know a venue yet, like
 * `RequireSession`'s redirect to `/join?mode=login`. `devCode` is only
 * present when the server has the opt-in ALLOW_DEV_OTP_ECHO flag set.
 */
export async function requestLoginOtp(phone: string): Promise<{ expiresAt: string; devCode?: string }> {
  return request('/api/identity/request-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  });
}

/** POST /api/identity/verify-otp */
export async function verifyLoginOtp(
  phone: string,
  code: string,
): Promise<{ token: string; expiresAt: string; user: SessionUser }> {
  return request('/api/identity/verify-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, code }),
  });
}

/**
 * DELETE /api/identity/session — revokes the session server-side on sign-out.
 * Without this the 30-day token stays valid even after the browser forgets
 * it, which matters on the shared venue devices this app actually runs on.
 */
export async function revokeSession(token: string): Promise<void> {
  const res = await fetch('/api/identity/session', {
    method: 'DELETE',
    headers: withAuth(token),
  });
  if (!res.ok && res.status !== 401) {
    throw new ApiError(`Request failed (${res.status})`, res.status);
  }
}

const SESSION_STORAGE_KEY = 'shiftsync.session';

export interface StoredSession {
  token: string;
  expiresAt: string;
  user: SessionUser;
}

export function saveSession(session: StoredSession): void {
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

export function loadSession(): StoredSession | null {
  const raw = localStorage.getItem(SESSION_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredSession;
    if (new Date(parsed.expiresAt) < new Date()) {
      clearSession();
      return null;
    }
    // Sessions saved before `locationId`/`systemRole` were added to the
    // payload won't have them. The type says they're always present, and the
    // upcoming de-hardcoding sweep trusts `session.user.locationId` as the
    // real venue id — silently handing it `undefined` there is worse than
    // forcing one extra login. Fail closed instead of letting a stale shape
    // masquerade as the current one.
    if (!parsed.user?.locationId) {
      clearSession();
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_STORAGE_KEY);
}

/** Shared header-builder for identity/join/my-shifts/availability consumers that need a Bearer token. */
export function withAuth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}
