/**
 * Client for the Join API (server/src/routes/join.ts) — the "join a venue"
 * phone/OTP flow for staff without an account yet, and the Pending
 * Approvals review queue it feeds when no existing User auto-matches.
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
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** POST /api/join/request-otp — join path, no existing-match requirement. */
export async function requestJoinOtp(phone: string): Promise<{ expiresAt: string; devCode?: string }> {
  return request('/api/join/request-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  });
}

export type JoinVerifyResult =
  | { pending: false; token: string; expiresAt: string; user: SessionUser }
  | { pending: true; joinRequestId: string };

/** POST /api/join/verify-otp — body: { locationId, phone, code, fullName? } */
export async function verifyJoinOtp(input: { locationId: string; phone: string; code: string; fullName?: string }): Promise<JoinVerifyResult> {
  return request('/api/join/verify-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export interface JoinRequestDto {
  id: string;
  phone: string;
  fullName: string;
  createdAt: string;
}

/** GET /api/join/:locationId/pending */
export async function fetchPendingJoinRequests(locationId: string): Promise<JoinRequestDto[]> {
  const data = await request<{ requests: JoinRequestDto[] }>(`/api/join/${locationId}/pending`);
  return data.requests;
}

/** PATCH /api/join/:requestId — body: { decision: 'approve'|'decline', reviewedById?, jobTitle? } */
export async function decideJoinRequest(
  requestId: string,
  decision: 'approve' | 'decline',
  input?: { reviewedById?: string; jobTitle?: string },
): Promise<{ status: string; userId?: string }> {
  return request(`/api/join/${requestId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision, ...input }),
  });
}
