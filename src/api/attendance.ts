import { ApiError } from './schedules';
import { withAuth } from './identity';

export interface HourStaffEntry {
  id: string;
  name: string;
  hours: number;
  clockedIn: boolean;
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

export async function clockIn(token: string, userId: string, shiftId?: string): Promise<{ id: string; clockInAt: string; clockOutAt: string | null }> {
  return request('/api/attendance/clock-in', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...withAuth(token) },
    body: JSON.stringify({ userId, shiftId: shiftId ?? null }),
  });
}

export async function clockOut(token: string, userId: string): Promise<{ id: string; clockInAt: string; clockOutAt: string }> {
  return request('/api/attendance/clock-out', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...withAuth(token) },
    body: JSON.stringify({ userId }),
  });
}

export async function fetchWeeklyHours(locationId: string, weekStart: string): Promise<HourStaffEntry[]> {
  const data = await request<{ staff: HourStaffEntry[] }>(`/api/attendance/${locationId}/weekly-hours?weekStart=${weekStart}`);
  return data.staff;
}
