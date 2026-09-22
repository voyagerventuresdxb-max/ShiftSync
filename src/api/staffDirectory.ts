/**
 * Client for the Staff Directory API (server/src/routes/staffDirectory.ts)
 * — the venue-configured staff-name -> job-title mapping, set manually
 * once, never inferred from an uploaded roster.
 *
 * Extended to also carry phone, preferred language, start date (hiredAt),
 * employment status (isActive), and a read-only venue name (joined from
 * Location.name) — see the 2026-08-28 People/Identity plan, Task 5.
 */
import { ApiError } from './schedules';
import { withAuth } from './identity';

export interface StaffDirectoryEntry {
  id: string;
  fullName: string;
  jobTitle: string | null;
  /** The venue Role's DB id — what every shift-write endpoint requires. Null for staff with no role assigned yet. */
  roleId: string | null;
  roleName: string | null;
  phone: string | null;
  preferredLanguage: string | null;
  /** ISO date, YYYY-MM-DD, or null if never set. */
  hiredAt: string | null;
  /** Employment status is the isActive + terminatedAt pair, not a separate enum. */
  isActive: boolean;
  /** ISO date, YYYY-MM-DD, set when isActive flips to false and cleared when it flips back. */
  terminatedAt: string | null;
  /** Read-only, joined from Location.name. */
  venueName: string;
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

/**
 * GET /api/staff-directory/:locationId — returns ALL staff for a location,
 * including inactive/terminated ones (the server deliberately does not
 * filter by isActive so a manager can see and un-terminate someone).
 * Callers that render staff as assignable (e.g. Floor Plan) must filter
 * on `isActive` themselves.
 */
export async function fetchStaffDirectory(token: string, locationId: string): Promise<StaffDirectoryEntry[]> {
  const data = await request<{ staff: StaffDirectoryEntry[] }>(`/api/staff-directory/${locationId}`, {
    headers: withAuth(token),
  });
  return data.staff;
}

/**
 * POST /api/staff-directory — body: { fullName, jobTitle?, phone?, preferredLanguage?, hiredAt? }.
 * locationId is no longer accepted here — the server derives it from the
 * manager's own session, so there is nothing for a caller to supply or spoof.
 */
export async function addStaffMember(
  token: string,
  input: {
    fullName: string;
    jobTitle?: string | null;
    phone?: string | null;
    preferredLanguage?: string | null;
    hiredAt?: string | null;
  },
): Promise<StaffDirectoryEntry> {
  return request<StaffDirectoryEntry>('/api/staff-directory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...withAuth(token) },
    body: JSON.stringify(input),
  });
}

/** PATCH /api/staff-directory/:userId — accepts fullName, jobTitle, phone, preferredLanguage, hiredAt, isActive, roleId. */
export async function updateStaffMember(
  token: string,
  userId: string,
  updates: {
    fullName?: string;
    jobTitle?: string | null;
    phone?: string | null;
    preferredLanguage?: string | null;
    hiredAt?: string | null;
    isActive?: boolean;
    /** One of the venue's active roles (GET /api/roles), or null to unassign. */
    roleId?: string | null;
  },
): Promise<StaffDirectoryEntry> {
  return request<StaffDirectoryEntry>(`/api/staff-directory/${userId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...withAuth(token) },
    body: JSON.stringify(updates),
  });
}
