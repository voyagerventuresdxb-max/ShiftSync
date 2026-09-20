/** Client for the Shoutouts API (server/src/routes/shoutouts.ts). */
import { ApiError } from './schedules';
import { withAuth } from './identity';

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

/**
 * POST /api/shoutouts — `requireSession`-gated server-side, so this now
 * takes the caller's own session token (`token`, same "token first" shape as
 * `shifts.ts`'s `createShift`) — 2026-09-20 tenant-isolation fix: the route
 * previously accepted no Authorization header at all from this client, which
 * meant every real POST from the app was silently 401ing.
 */
export async function postShoutout(
  token: string,
  input: {
    locationId: string;
    employeeId: string;
    authorId?: string;
    shiftSnapshot?: string;
    note: string;
  },
): Promise<ShoutoutDto> {
  const data = await request<{ shoutout: ShoutoutDto }>('/api/shoutouts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...withAuth(token) },
    body: JSON.stringify({ ...input, authorId: input.authorId ?? null, shiftSnapshot: input.shiftSnapshot ?? null }),
  });
  return data.shoutout;
}
