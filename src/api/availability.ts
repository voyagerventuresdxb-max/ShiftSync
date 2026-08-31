/**
 * Client for the Availability API (server/src/routes/availability.ts) — a
 * staff member's per-day unavailable/preferred-off marks for a given week.
 */
import { ApiError } from './schedules';
import { withAuth } from './identity';
export { ApiError };

export interface AvailabilityMarkDto {
  id: string;
  date: string;
  type: 'UNAVAILABLE' | 'PREFERRED_OFF';
  note: string | null;
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
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * GET /api/availability/:userId?weekStart=YYYY-MM-DD — session-gated
 * (2026-08-31 anonymous-read sweep — see MEMORY.md; this doc comment used to
 * say "unauthenticated by design" for a reason that stopped being true once
 * RotaBuilder moved inside the session-gated `/schedule` route). Any signed-
 * in session can still read another user's marks, matching the server's own
 * unchanged read model — only anonymous access was closed.
 */
export async function fetchAvailability(token: string, userId: string, weekStart: string): Promise<AvailabilityMarkDto[]> {
  const data = await request<{ marks: AvailabilityMarkDto[] }>(`/api/availability/${userId}?weekStart=${weekStart}`, { headers: withAuth(token) });
  return data.marks;
}

/**
 * POST /api/availability — body: { date, type, note? } — upserts one mark per
 * (userId, date). The user comes from the Bearer session server-side, never
 * from the body: you can only ever mark your own availability.
 */
export async function setAvailability(
  token: string,
  input: { date: string; type: 'UNAVAILABLE' | 'PREFERRED_OFF'; note?: string },
): Promise<AvailabilityMarkDto> {
  return request('/api/availability', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...withAuth(token) },
    body: JSON.stringify(input),
  });
}

/** DELETE /api/availability/:id — session-gated; the server 403s on someone else's mark. */
export async function removeAvailability(token: string, id: string): Promise<void> {
  await request(`/api/availability/${id}`, { method: 'DELETE', headers: withAuth(token) });
}
