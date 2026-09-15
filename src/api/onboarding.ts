/**
 * Client for the ShiftSync onboarding API (server/src/routes/onboarding.ts).
 */
import { withAuth } from './identity';

export interface MintedInvite {
  inviteUrl: string;
  qrDataUrl: string;
  whatsappUrl: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
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

/** GET /api/onboarding/:locationId/invite — mints (or re-mints) the venue's join-link + QR. */
export async function mintInvite(token: string, locationId: string): Promise<MintedInvite> {
  return request<MintedInvite>(`/api/onboarding/${locationId}/invite`, { headers: withAuth(token) });
}
