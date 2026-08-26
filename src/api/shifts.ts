import { ApiError } from './schedules';

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

export async function fetchWeekShifts(locationId: string, weekStart: string): Promise<ShiftDto[]> {
  const data = await request<{ shifts: ShiftDto[] }>(`/api/shifts/${locationId}?weekStart=${weekStart}`);
  return data.shifts;
}

export async function createShift(input: {
  locationId: string;
  roleId: string;
  userId?: string | null;
  date: string;
  start: string;
  end: string;
  breakMinutes?: number;
  briefingNote?: string;
  sidework?: string[];
  createdById?: string;
}): Promise<ShiftDto> {
  const data = await request<{ shift: ShiftDto }>('/api/shifts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return data.shift;
}

export async function updateShift(
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
    actorId: string;
  }>,
): Promise<ShiftDto> {
  const data = await request<{ shift: ShiftDto }>(`/api/shifts/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return data.shift;
}

export async function deleteShift(id: string, actorId?: string): Promise<void> {
  await request(`/api/shifts/${id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actorId: actorId ?? null }),
  });
}

export async function bulkCreateShifts(input: {
  locationId: string;
  createdById?: string;
  shifts: { roleId: string; userId?: string | null; date: string; start: string; end: string; breakMinutes?: number }[];
}): Promise<{ shifts: ShiftDto[]; createdCount: number }> {
  return request('/api/shifts/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function publishWeek(locationId: string, weekStart: string, publishedById?: string): Promise<{ publishedAt: string; notifiedCount: number }> {
  return request(`/api/shifts/${locationId}/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ weekStart, publishedById: publishedById ?? null }),
  });
}

export async function fetchPublishStatus(
  locationId: string,
  weekStart: string,
): Promise<{ publishedAt: string | null; notifiedCount: number; hasUnpublishedChanges: boolean }> {
  return request(`/api/shifts/${locationId}/publish-status?weekStart=${weekStart}`);
}
