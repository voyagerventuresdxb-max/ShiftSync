/**
 * Staff-side request calls for the "My week" screen: time off (POST
 * /api/time-off, contract in shared/rotaWeek.ts) and swaps (the existing
 * /api/swap-requests client, unchanged, so the manager's Approvals panel
 * keeps receiving them exactly as before).
 */
import { apiFetch } from '../../../api/http';
import { ApiError } from '../../../api/schedules';
import { withAuth } from '../../../api/identity';
import { createSwapRequest } from '../../../api/swapRequests';
import { apiUrl } from '../../../lib/apiUrl';
import type { IsoDate, TimeOffRequestDto } from '../../../../shared/rotaWeek';

export { ApiError };

/** POST /api/time-off — a staff session files for itself (any `userId` it sent would be ignored). */
export async function requestTimeOff(token: string, input: { startDate: IsoDate; endDate: IsoDate; reason?: string | null }): Promise<TimeOffRequestDto> {
  const res = await apiFetch(apiUrl('/api/time-off'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...withAuth(token) },
    body: JSON.stringify({ startDate: input.startDate, endDate: input.endDate, ...(input.reason ? { reason: input.reason } : {}) }),
  });
  if (!res.ok) {
    let message = res.status === 404 ? 'Time-off requests are not available yet. Ask your manager directly for now.' : `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      if (body?.error) message = body.error;
      else if (body?.message) message = body.message;
    } catch {
      // non-JSON error body; keep the generic message
    }
    throw new ApiError(message, res.status);
  }
  const body = (await res.json()) as { request: TimeOffRequestDto };
  return body.request;
}

/** Offer one of your shifts to a colleague (POST /api/swap-requests; the server takes the requester from the session). */
export async function requestSwap(token: string, input: { shiftId: string; targetUserId: string; reason?: string }): Promise<void> {
  await createSwapRequest(token, { shiftId: input.shiftId, targetUserId: input.targetUserId, ...(input.reason ? { reason: input.reason } : {}) });
}
