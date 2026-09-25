import { ApiError } from './schedules';
import { withAuth } from './identity';

export interface ShiftDto {
  id: string;
  employeeId: string | null;
  employeeName: string | null;
  roleId: string;
  roleName: string;
  date: string;
  start: string;
  end: string;
  breakMinutes: number;
  status: 'draft' | 'published';
  briefingNote: string | null;
  sidework: string[];
  updatedAt: string;
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

/**
 * The token is optional: anonymous (kiosk) and staff callers get PUBLISHED
 * shifts only; a venue manager's token also returns drafts (server decides).
 */
export async function fetchWeekShifts(locationId: string, weekStart: string, token?: string | null): Promise<ShiftDto[]> {
  const data = await request<{ shifts: ShiftDto[] }>(`/api/shifts/${locationId}?weekStart=${weekStart}`, {
    headers: token ? withAuth(token) : {},
  });
  return data.shifts;
}

export async function createShift(
  token: string,
  input: {
    locationId: string;
    roleId: string;
    userId?: string | null;
    date: string;
    start: string;
    end: string;
    breakMinutes?: number;
    briefingNote?: string;
    sidework?: string[];
  },
): Promise<ShiftDto> {
  const data = await request<{ shift: ShiftDto }>('/api/shifts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...withAuth(token) },
    body: JSON.stringify(input),
  });
  return data.shift;
}

export async function updateShift(
  token: string,
  id: string,
  patch: Partial<{
    roleId: string;
    userId: string | null;
    date: string;
    start: string;
    end: string;
    breakMinutes: number;
    briefingNote: string | null;
    sidework: string[];
  }>,
): Promise<ShiftDto> {
  const data = await request<{ shift: ShiftDto }>(`/api/shifts/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...withAuth(token) },
    body: JSON.stringify(patch),
  });
  return data.shift;
}

export async function deleteShift(token: string, id: string): Promise<void> {
  await request(`/api/shifts/${id}`, {
    method: 'DELETE',
    headers: withAuth(token),
  });
}

export async function bulkCreateShifts(
  token: string,
  input: {
    locationId: string;
    shifts: { roleId: string; userId?: string | null; date: string; start: string; end: string; breakMinutes?: number }[];
  },
): Promise<{ shifts: ShiftDto[]; createdCount: number }> {
  return request('/api/shifts/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...withAuth(token) },
    body: JSON.stringify(input),
  });
}

export async function publishWeek(
  token: string,
  locationId: string,
  weekStart: string,
): Promise<{ publishedAt: string; notifiedCount: number }> {
  // The publisher is always the session user (server-side); no id is sent.
  return request(`/api/shifts/${locationId}/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...withAuth(token) },
    body: JSON.stringify({ weekStart }),
  });
}

export async function fetchPublishStatus(
  locationId: string,
  weekStart: string,
): Promise<{ publishedAt: string | null; notifiedCount: number; hasUnpublishedChanges: boolean }> {
  return request(`/api/shifts/${locationId}/publish-status?weekStart=${weekStart}`);
}
