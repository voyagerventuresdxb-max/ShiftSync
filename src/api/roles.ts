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

/** POST /api/roles — manager/owner only. A previously removed name is reactivated rather than duplicated. */
export async function createRole(token: string, name: string): Promise<RoleSummary> {
  const { role } = await request<{ role: RoleSummary }>('/api/roles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...withAuth(token) },
    body: JSON.stringify({ name }),
  });
  return role;
}

/** PATCH /api/roles/:id — rename; every shift and staff record on the role follows. */
export async function renameRole(token: string, id: string, name: string): Promise<RoleSummary> {
  const { role } = await request<{ role: RoleSummary }>(`/api/roles/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...withAuth(token) },
    body: JSON.stringify({ name }),
  });
  return role;
}

/** DELETE /api/roles/:id — deactivates the role and unassigns staff from it; existing shifts keep it. */
export async function removeRole(token: string, id: string): Promise<void> {
  const res = await fetch(`/api/roles/${id}`, { method: 'DELETE', headers: withAuth(token) });
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
}
