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

/** POST /api/identity/request-otp — login path. `devCode` is only ever present outside production. */
export async function requestLoginOtp(phone: string): Promise<{ expiresAt: string; devCode?: string }> {
  return request('/api/identity/request-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  });
}

/** POST /api/identity/verify-otp */
export async function verifyLoginOtp(phone: string, code: string): Promise<{ token: string; expiresAt: string; user: SessionUser }> {
  return request('/api/identity/verify-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, code }),
  });
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
