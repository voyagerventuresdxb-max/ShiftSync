/**
 * Client for the Join API (server/src/routes/join.ts) — the "join a venue"
 * phone/OTP flow for staff without an account yet, and the Pending
 * Approvals review queue it feeds when no existing User auto-matches.
 */
import { apiFetch, retryAfterSeconds } from './http';
import { ApiError } from './schedules';
import { withAuth, type SessionUser } from './identity';
import { apiUrl } from '../lib/apiUrl';
export { ApiError };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(apiUrl(url), init);
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    let errorCode: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; errorCode?: string };
      if (body?.error) message = body.error;
      errorCode = body?.errorCode;
    } catch {
      // non-JSON error body; keep the generic message
    }
    throw new ApiError(message, res.status, retryAfterSeconds(res) ?? undefined, errorCode);
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
  | { pending: false; token: string; expiresAt: string; user: SessionUser; firstSignIn?: boolean; venueName?: string }
  | { pending: true; joinRequestId: string; venueName: string; managerName: string | null };

/** POST /api/join/verify-otp — body: { inviteToken | locationId (old links), phone, code, fullName? } */
export async function verifyJoinOtp(input: {
  inviteToken?: string;
  locationId?: string;
  phone: string;
  code: string;
  fullName?: string;
}): Promise<JoinVerifyResult> {
  return request('/api/join/verify-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

/** A staff member imported from a roster (never signed in) that a join request might be. */
export interface JoinLinkCandidate {
  userId: string;
  fullName: string;
  roleName: string | null;
  /** 'exact': the same full name; 'close': a first name only, a nickname, an initial, another spelling. */
  match: 'exact' | 'close';
}

/**
 * What approving does about imported staff (server/src/lib/actions/joinActions.ts JoinLinkPlan):
 * 'link' claims that one record, 'choose' needs the manager to pick (or "new person"), 'new' adds them.
 */
export type JoinLinkPlan = { kind: 'link'; candidate: JoinLinkCandidate } | { kind: 'choose'; candidates: JoinLinkCandidate[] } | { kind: 'new' };

export interface JoinRequestDto {
  id: string;
  phone: string;
  fullName: string;
  createdAt: string;
  /** Times this phone was declined at this venue before. */
  previousDeclines: number;
  lastDeclinedAt: string | null;
  /** Absent from older servers. */
  link?: JoinLinkPlan;
}

/** GET /api/join/:locationId/pending — manager-only; the caller's own location. */
export async function fetchPendingJoinRequests(token: string, locationId: string): Promise<JoinRequestDto[]> {
  const data = await request<{ requests: JoinRequestDto[] }>(`/api/join/${locationId}/pending`, {
    headers: withAuth(token),
  });
  return data.requests;
}

/**
 * PATCH /api/join/:requestId — body: { decision: 'approve'|'decline', jobTitle?, linkTo? }
 * `linkTo`: the imported staff record this person is (its id), or 'new'. An approval that
 * needs that choice and lacks it is a 409 `link_choice_required`.
 * Manager-only; the reviewer is always the authenticated caller, resolved
 * server-side from the Bearer token — never accepted from the body.
 */
export async function decideJoinRequest(
  token: string,
  requestId: string,
  decision: 'approve' | 'decline',
  input?: { jobTitle?: string; linkTo?: string },
): Promise<{ status: string; userId?: string; linked?: boolean }> {
  return request(`/api/join/${requestId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...withAuth(token) },
    body: JSON.stringify({ decision, ...input }),
  });
}
