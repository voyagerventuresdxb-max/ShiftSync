/** Client for the Swap Requests API (server/src/routes/swapRequests.ts). */
import { ApiError } from './schedules';
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

/** GET /api/swap-requests/:locationId */
export async function fetchSwapRequests(locationId: string): Promise<SwapRequest[]> {
  const data = await request<{ requests: SwapRequest[] }>(`/api/swap-requests/${locationId}`);
  return data.requests;
}

/** POST /api/swap-requests */
export async function createSwapRequest(input: {
  shiftId: string;
  requestedById: string;
  targetUserId: string;
  reason?: string;
}): Promise<SwapRequest> {
  const data = await request<{ request: SwapRequest }>('/api/swap-requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return data.request;
}

/** PATCH /api/swap-requests/:id */
export async function decideSwapRequest(
  id: string,
  decision: 'approved' | 'denied',
  reviewedById?: string,
): Promise<SwapRequest> {
  const data = await request<{ request: SwapRequest }>(`/api/swap-requests/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision, reviewedById: reviewedById ?? null }),
  });
  return data.request;
}
