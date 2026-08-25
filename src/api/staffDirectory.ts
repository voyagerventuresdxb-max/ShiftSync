/**
 * Client for the Staff Directory API (server/src/routes/staffDirectory.ts)
 * — the venue-configured staff-name -> job-title mapping, set manually
 * once, never inferred from an uploaded roster.
 */
import { ApiError } from './schedules';

export interface StaffDirectoryEntry {
  id: string;
  fullName: string;
  jobTitle: string | null;
  roleName: string | null;
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

/** GET /api/staff-directory/:locationId */
export async function fetchStaffDirectory(locationId: string): Promise<StaffDirectoryEntry[]> {
  const data = await request<{ staff: StaffDirectoryEntry[] }>(`/api/staff-directory/${locationId}`);
  return data.staff;
}

/** POST /api/staff-directory */
export async function addStaffMember(locationId: string, fullName: string, jobTitle: string): Promise<StaffDirectoryEntry> {
  return request<StaffDirectoryEntry>('/api/staff-directory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locationId, fullName, jobTitle: jobTitle || null }),
  });
}

/** PATCH /api/staff-directory/:userId */
export async function updateStaffMember(
  userId: string,
  updates: { fullName?: string; jobTitle?: string | null },
): Promise<StaffDirectoryEntry> {
  return request<StaffDirectoryEntry>(`/api/staff-directory/${userId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
}
