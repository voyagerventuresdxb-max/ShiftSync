/** Client for the Announcements API (server/src/routes/announcements.ts). */
import { ApiError } from './schedules';
import { withAuth } from './identity';

export interface AnnouncementDto {
  id: string;
  body: string;
  authorId: string | null;
  authorName: string | null;
  createdAt: string;
  editedAt: string | null;
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

/** GET /api/announcements/:locationId */
export async function fetchAnnouncements(locationId: string): Promise<AnnouncementDto[]> {
  const data = await request<{ announcements: AnnouncementDto[] }>(`/api/announcements/${locationId}`);
  return data.announcements;
}

/**
 * POST /api/announcements — `requireSession`-gated server-side, so this now
 * takes the caller's own session token (`token`, same "token first" shape as
 * `shifts.ts`'s `createShift`) — 2026-09-20 tenant-isolation fix: the route
 * previously accepted no Authorization header at all from this client, which
 * meant every real POST from the app was silently 401ing.
 */
export async function postAnnouncement(token: string, locationId: string, body: string, authorId?: string): Promise<AnnouncementDto> {
  const data = await request<{ announcement: AnnouncementDto }>('/api/announcements', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...withAuth(token) },
    body: JSON.stringify({ locationId, body, authorId: authorId ?? null }),
  });
  return data.announcement;
}

/** PATCH /api/announcements/:id — now `requireSession`-gated server-side (2026-09-20), so this takes the caller's session token. */
export async function updateAnnouncement(token: string, id: string, body: string): Promise<AnnouncementDto> {
  const data = await request<{ announcement: AnnouncementDto }>(`/api/announcements/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...withAuth(token) },
    body: JSON.stringify({ body }),
  });
  return data.announcement;
}

/** DELETE /api/announcements/:id — now `requireSession`-gated server-side (2026-09-20), so this takes the caller's session token. */
export async function deleteAnnouncement(token: string, id: string): Promise<void> {
  await request(`/api/announcements/${id}`, { method: 'DELETE', headers: withAuth(token) });
}
