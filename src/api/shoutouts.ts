/** Client for the Shoutouts API (server/src/routes/shoutouts.ts). */
import { ApiError } from './schedules';

export interface ShoutoutDto {
  id: string;
  employeeId: string;
  employeeName: string;
  authorId: string | null;
  authorName: string | null;
  shiftSnapshot: string | null;
  note: string;
  createdAt: string;
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
  return (await res.json()) as T;
}

/** GET /api/shoutouts/:locationId */
export async function fetchShoutouts(locationId: string): Promise<ShoutoutDto[]> {
  const data = await request<{ shoutouts: ShoutoutDto[] }>(`/api/shoutouts/${locationId}`);
  return data.shoutouts;
}

/** POST /api/shoutouts */
export async function postShoutout(input: {
  locationId: string;
  employeeId: string;
  authorId?: string;
  shiftSnapshot?: string;
  note: string;
}): Promise<ShoutoutDto> {
  const data = await request<{ shoutout: ShoutoutDto }>('/api/shoutouts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, authorId: input.authorId ?? null, shiftSnapshot: input.shiftSnapshot ?? null }),
  });
  return data.shoutout;
}
