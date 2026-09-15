/**
 * Client for the ShiftSync roles API (server/src/routes/roles.ts).
 */
import { withAuth } from './identity';

export interface RoleSummary {
  id: string;
  name: string;
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

/** GET /api/roles */
export async function fetchRoles(token: string): Promise<RoleSummary[]> {
  const { roles } = await request<{ roles: RoleSummary[] }>('/api/roles', { headers: withAuth(token) });
  return roles;
}
