/**
 * Client for venue invite links: the manager API (server/src/routes/invites.ts)
 * and the public peek a `/join?invite=<token>` page makes before showing the form.
 */
import { apiFetch } from './http';
import { ApiError } from './schedules';
import { withAuth } from './identity';
import { apiUrl } from '../lib/apiUrl';
export { ApiError };

/** The venue's active join link, as the manager sees it. */
export interface ActiveInvite {
  inviteUrl: string;
  qrDataUrl: string;
  whatsappUrl: string;
  expiresAt: string;
  maxUses: number | null;
  useCount: number;
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

/** GET /api/invites/:locationId — null when the venue has no active link. */
export async function fetchInviteLink(token: string, locationId: string): Promise<ActiveInvite | null> {
  const data = await request<{ active: ActiveInvite | null }>(`/api/invites/${locationId}${baseUrlQuery()}`, { headers: withAuth(token) });
  return data.active;
}

/** POST /api/invites/:locationId/regenerate — revokes the current link and returns the new one. */
export async function regenerateInviteLink(
  token: string,
  locationId: string,
  opts: { expiresInDays: number; maxUses: number | null },
): Promise<ActiveInvite> {
  const data = await request<{ active: ActiveInvite }>(`/api/invites/${locationId}/regenerate${baseUrlQuery()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...withAuth(token) },
    body: JSON.stringify(opts),
  });
  return data.active;
}

/** POST /api/invites/:locationId/revoke */
export async function revokeInviteLink(token: string, locationId: string): Promise<void> {
  await request(`/api/invites/${locationId}/revoke`, { method: 'POST', headers: withAuth(token) });
}

/** GET /api/join/invite/:token — throws an ApiError carrying the reason to show when the link can't be used. */
export async function peekInvite(inviteToken: string): Promise<{ venueName: string; expiresAt: string }> {
  return request(`/api/join/invite/${encodeURIComponent(inviteToken)}`);
}
