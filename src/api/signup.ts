/**
 * Client for the Signup API (server/src/routes/signup.ts) — the brand-new-venue
 * self-service signup flow, deliberately separate from `src/api/join.ts`
 * (joining an EXISTING venue's roster). There is no `locationId` param on
 * either endpoint here because no location exists yet — that's the whole
 * point of this route.
 */
import { ApiError } from './schedules';
import type { SessionUser } from './identity';
export { ApiError };

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

/** POST /api/signup/request-otp — body: { phone } */
export async function requestSignupOtp(phone: string): Promise<{ expiresAt: string; devCode?: string }> {
  return request('/api/signup/request-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  });
}

/**
 * POST /api/signup/verify-otp — body: { phone, code, fullName, venueName }
 *
 * On success (201), creates a brand-new Organization + Location + User(OWNER)
 * and returns a session directly — there is no "pending approval" branch here
 * unlike `/api/join`, since a signup owns the venue it's creating.
 *
 * A phone that already has an account fails with a 409 `ApiError` — callers
 * should catch that specifically (`err instanceof ApiError && err.status === 409`)
 * and point the user at `/join?mode=login` rather than treating it as a
 * generic failure.
 */
export async function verifySignupOtp(input: {
  phone: string;
  code: string;
  fullName: string;
  venueName: string;
}): Promise<{ token: string; expiresAt: string; user: SessionUser }> {
  return request('/api/signup/verify-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}
