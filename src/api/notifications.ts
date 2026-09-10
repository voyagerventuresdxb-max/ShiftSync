/** Client for the in-app notification history API (server/src/routes/notifications.ts). */
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
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface AppNotification {
  id: string;
  title: string;
  body: string;
  url: string | null;
  readAt: string | null;
  createdAt: string;
}

/** GET /api/notifications — the caller's own, newest first. */
export async function fetchNotifications(token: string): Promise<AppNotification[]> {
  const data = await request<{ notifications: AppNotification[] }>('/api/notifications', { headers: withAuth(token) });
  return data.notifications;
}

/** PATCH /api/notifications/:id/read */
export async function markNotificationRead(token: string, id: string): Promise<void> {
  await request(`/api/notifications/${id}/read`, { method: 'PATCH', headers: withAuth(token) });
}

/** POST /api/notifications/read-all */
export async function markAllNotificationsRead(token: string): Promise<void> {
  await request('/api/notifications/read-all', { method: 'POST', headers: withAuth(token) });
}
