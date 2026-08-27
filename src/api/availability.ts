/**
 * Client for the Availability API (server/src/routes/availability.ts) — a
 * staff member's per-day unavailable/preferred-off marks for a given week.
 */
import { ApiError } from './schedules';
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

/** GET /api/availability/:userId?weekStart=YYYY-MM-DD */
export async function fetchAvailability(userId: string, weekStart: string): Promise<AvailabilityMarkDto[]> {
  const data = await request<{ marks: AvailabilityMarkDto[] }>(`/api/availability/${userId}?weekStart=${weekStart}`);
  return data.marks;
}

/** POST /api/availability — body: { userId, date, type, note? } — upserts one mark per (userId, date). */
export async function setAvailability(input: { userId: string; date: string; type: 'UNAVAILABLE' | 'PREFERRED_OFF'; note?: string }): Promise<AvailabilityMarkDto> {
  return request('/api/availability', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

/** DELETE /api/availability/:id */
export async function removeAvailability(id: string): Promise<void> {
  await request(`/api/availability/${id}`, { method: 'DELETE' });
}
