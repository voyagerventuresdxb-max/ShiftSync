/**
 * Client for the venue's kiosk link (server/src/routes/kiosk.ts) — manager-only.
 * The link itself comes back once, from regenerate; the status read never includes it.
 */
import { apiFetch } from './http';
import { ApiError } from './schedules';
import { withAuth } from './identity';
import { apiUrl } from '../lib/apiUrl';
export { ApiError };

export interface KioskLinkStatus {
  createdAt: string;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(apiUrl(url), init);
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

/** The server only honours an allowlisted origin, so this can't point a link elsewhere. */
const baseUrlQuery = () => `?baseUrl=${encodeURIComponent(window.location.origin)}`;

/** GET /api/kiosk/:locationId — null when the venue has no kiosk link. */
export async function fetchKioskLink(token: string, locationId: string): Promise<KioskLinkStatus | null> {
  const data = await request<{ active: KioskLinkStatus | null }>(`/api/kiosk/${locationId}`, { headers: withAuth(token) });
  return data.active;
}

/** POST /api/kiosk/:locationId/regenerate — the previous kiosk link stops working; `url` is shown only now. */
export async function regenerateKioskLink(token: string, locationId: string): Promise<{ active: KioskLinkStatus; url: string }> {
  return request(`/api/kiosk/${locationId}/regenerate${baseUrlQuery()}`, { method: 'POST', headers: withAuth(token) });
}

/** POST /api/kiosk/:locationId/revoke */
export async function revokeKioskLink(token: string, locationId: string): Promise<void> {
  await request(`/api/kiosk/${locationId}/revoke`, { method: 'POST', headers: withAuth(token) });
}
