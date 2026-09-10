/** Client for the Swap Requests API (server/src/routes/swapRequests.ts). */
import { ApiError } from './schedules';
import { withAuth } from './identity';
import type { SwapRequest } from '../engine/types';

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

/** GET /api/swap-requests/:locationId — session-gated; the server 403s on a location mismatch. */
export async function fetchSwapRequests(token: string, locationId: string): Promise<SwapRequest[]> {
  const data = await request<{ requests: SwapRequest[] }>(`/api/swap-requests/${locationId}`, {
    headers: withAuth(token),
  });
  return data.requests;
}

/**
 * POST /api/swap-requests — `requestedById` is only honored server-side for a
 * MANAGER/OWNER session (a manager filing on behalf of the employee selected
 * in SchedulingRoute's "Viewing" dropdown); a STAFF session's `requestedById`
 * is ignored outright and the requester is always that session's own user.
 */
export async function createSwapRequest(
  token: string,
  input: {
    shiftId: string;
    targetUserId: string;
    reason?: string;
    requestedById?: string;
  },
): Promise<SwapRequest> {
  const data = await request<{ request: SwapRequest }>('/api/swap-requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...withAuth(token) },
    body: JSON.stringify(input),
  });
  return data.request;
}

/** PATCH /api/swap-requests/:id — manager/owner-only; the reviewer is always the caller's own session. */
export async function decideSwapRequest(
  token: string,
  id: string,
  decision: 'approved' | 'denied',
): Promise<SwapRequest> {
  const data = await request<{ request: SwapRequest }>(`/api/swap-requests/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...withAuth(token) },
    body: JSON.stringify({ decision }),
  });
  return data.request;
}
