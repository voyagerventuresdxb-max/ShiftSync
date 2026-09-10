/**
 * Client for the Floor Feedback API (server/src/routes/floorFeedback.ts) —
 * anonymous-to-management direct floor feedback (SafetyValve) and the
 * manager-facing review queue it feeds.
 */
import { ApiError } from './schedules';
import { withAuth } from './identity';
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

export type FloorFeedbackStatus = 'open' | 'flagged' | 'reviewed';

export interface FloorFeedbackDto {
  id: string;
  content: string;
  status: FloorFeedbackStatus;
  createdAt: string;
  reviewedAt: string | null;
  reviewedByName: string | null;
}

/** POST /api/floor-feedback — body: { content }. Any authenticated session. */
export async function submitFloorFeedback(token: string, content: string): Promise<void> {
  await request<{ message: string }>('/api/floor-feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...withAuth(token) },
    body: JSON.stringify({ content }),
  });
}

/** GET /api/floor-feedback?status=... — manager-only, the caller's own location. */
export async function fetchFloorFeedback(token: string, status?: FloorFeedbackStatus): Promise<FloorFeedbackDto[]> {
  const query = status ? `?status=${status}` : '';
  const data = await request<{ feedback: FloorFeedbackDto[] }>(`/api/floor-feedback${query}`, {
    headers: withAuth(token),
  });
  return data.feedback;
}

/** PATCH /api/floor-feedback/:id — body: { status: 'flagged' | 'reviewed' }. Manager-only. */
export async function decideFloorFeedback(
  token: string,
  id: string,
  status: 'flagged' | 'reviewed',
): Promise<FloorFeedbackDto> {
  const data = await request<{ feedback: FloorFeedbackDto }>(`/api/floor-feedback/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...withAuth(token) },
    body: JSON.stringify({ status }),
  });
  return data.feedback;
}
