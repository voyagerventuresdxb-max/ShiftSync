/**
 * Client for the My Shifts API (server/src/routes/myShifts.ts) — a
 * session-resolved staff member's next 5 upcoming shifts, plus whether
 * they still have a JoinRequest pending review.
 */
import { apiFetch } from './http';
import { ApiError } from './schedules';
import { withAuth } from './identity';
import { apiUrl } from '../lib/apiUrl';
import type { MyShiftV2Fields } from '../../shared/rotaWeek';
export { ApiError };

interface MyShiftEntryV1 {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  /** Venue wall-clock "HH:mm" — what to show, whatever timezone the device is in. */
  startLabel: string;
  endLabel: string;
  roleName: string;
  status: 'DRAFT' | 'PUBLISHED' | 'COMPLETED' | 'CANCELLED';
}

/**
 * Rota builder v2 adds the shift type's name, both ranges of a split, the
 * "ends next day" flag and the staff-visible note (shared/rotaWeek.ts
 * `MyShiftV2Fields`). Optional here: an older server omits them and every
 * screen still reads exactly as before.
 */
export type MyShiftEntry = MyShiftEntryV1 & Partial<MyShiftV2Fields>;

/** GET /api/my-shifts — session-resolved via the Bearer token. */
export async function fetchMyShifts(token: string): Promise<{ pendingApproval: boolean; shifts: MyShiftEntry[] }> {
  const res = await apiFetch(apiUrl('/api/my-shifts'), { headers: withAuth(token) });
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
