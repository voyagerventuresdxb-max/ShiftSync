/**
 * Client for the ShiftSync locations API (server/src/routes/locations.ts).
 */
import { withAuth } from './identity';

export { VENUE_TYPES } from '../../shared/venueTypes';

export interface LocationSummary {
  id: string;
  name: string;
  venueType: string | null;
  emirate: string | null;
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

/** GET /api/locations/:id */
export async function fetchLocation(token: string, locationId: string): Promise<LocationSummary> {
  const { location } = await request<{ location: LocationSummary }>(`/api/locations/${locationId}`, {
    headers: withAuth(token),
  });
  return location;
}

/** PATCH /api/locations/:id — any field may be omitted. */
export async function updateLocation(
  token: string,
  locationId: string,
  patch: { name?: string; venueType?: string | null; emirate?: string | null },
): Promise<LocationSummary> {
  const { location } = await request<{ location: LocationSummary }>(`/api/locations/${locationId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...withAuth(token) },
    body: JSON.stringify(patch),
  });
  return location;
}
