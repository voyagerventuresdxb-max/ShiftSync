import { ApiError } from './schedules';
import { withAuth } from './identity';
import type { LeaveTypeKey } from '../../shared/leaveTypes';

export interface LeaveDto {
  id: string;
  userId: string;
  date: string;
  type: LeaveTypeKey;
  status: 'draft' | 'published';
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

/** Same visibility as fetchWeekShifts: drafts only come back for a venue manager's token. */
export async function fetchWeekLeaves(locationId: string, weekStart: string, token?: string | null): Promise<LeaveDto[]> {
  const data = await request<{ leaves: LeaveDto[] }>(`/api/rota-leaves/${locationId}?weekStart=${weekStart}`, {
    headers: token ? withAuth(token) : {},
  });
  return data.leaves;
}

/** Marks or changes one person's leave for one day (409 if a blocking type clashes with a shift that day). */
export async function setLeave(token: string, input: { userId: string; date: string; type: LeaveTypeKey }): Promise<LeaveDto> {
  const data = await request<{ leave: LeaveDto }>('/api/rota-leaves', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...withAuth(token) },
    body: JSON.stringify(input),
  });
  return data.leave;
}

export async function deleteLeave(token: string, id: string): Promise<void> {
  await request(`/api/rota-leaves/${id}`, { method: 'DELETE', headers: withAuth(token) });
}
