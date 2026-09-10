/**
 * Client for the My Shifts API (server/src/routes/myShifts.ts) — a
 * session-resolved staff member's next 5 upcoming shifts, plus whether
 * they still have a JoinRequest pending review.
 */
import { ApiError } from './schedules';
import { withAuth } from './identity';
export { ApiError };

export interface MyShiftEntry {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  roleName: string;
  status: 'DRAFT' | 'PUBLISHED' | 'COMPLETED' | 'CANCELLED';
}

/** GET /api/my-shifts — session-resolved via the Bearer token. */
export async function fetchMyShifts(token: string): Promise<{ pendingApproval: boolean; shifts: MyShiftEntry[] }> {
  const res = await fetch('/api/my-shifts', { headers: withAuth(token) });
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
  return (await res.json()) as { pendingApproval: boolean; shifts: MyShiftEntry[] };
}
