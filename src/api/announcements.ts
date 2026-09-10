/** Client for the Announcements API (server/src/routes/announcements.ts). */
import { ApiError } from './schedules';

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

/** POST /api/announcements */
export async function postAnnouncement(locationId: string, body: string, authorId?: string): Promise<AnnouncementDto> {
  const data = await request<{ announcement: AnnouncementDto }>('/api/announcements', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locationId, body, authorId: authorId ?? null }),
  });
  return data.announcement;
}

/** PATCH /api/announcements/:id */
export async function updateAnnouncement(id: string, body: string): Promise<AnnouncementDto> {
  const data = await request<{ announcement: AnnouncementDto }>(`/api/announcements/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  return data.announcement;
}

/** DELETE /api/announcements/:id */
export async function deleteAnnouncement(id: string): Promise<void> {
  await request(`/api/announcements/${id}`, { method: 'DELETE' });
}
