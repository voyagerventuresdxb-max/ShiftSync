import { apiFetch } from './http';
import { ApiError } from './schedules';
import { withAuth } from './identity';
import { apiUrl } from '../lib/apiUrl';
import type {
  DepartmentDto,
  DepartmentInput,
  DepartmentMinimumDto,
  ShiftTypeDto,
  ShiftTypeInput,
  ShiftTypePatch,
  TimeOffDecisionInput,
  TimeOffRequestDto,
} from '../../shared/rotaWeek';

/**
 * Rota builder v2 supporting endpoints (contracts at the bottom of
 * shared/rotaWeek.ts): venue shift types, departments and their minimum
 * headcounts, and time-off requests. Writes are manager-only server-side,
 * except filing a time-off request for yourself. Every roster change these
 * cause (a type's times, an approval) bumps the week version, so callers
 * refetch the week document afterwards.
 */

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(apiUrl(url), init);
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      if (body?.error) message = body.error;
      else if (body?.message) message = body.message;
    } catch {
      // non-JSON error body; keep the generic message
    }
    throw new ApiError(message, res.status);
  }
  return (await res.json()) as T;
}

const json = (token: string, method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json', ...withAuth(token) },
  body: JSON.stringify(body),
});

// ---------------------------------------------------------------------------
// Shift types
// ---------------------------------------------------------------------------

export async function fetchShiftTypes(token: string, locationId: string): Promise<ShiftTypeDto[]> {
  return (await request<{ shiftTypes: ShiftTypeDto[] }>(`/api/shift-types/${locationId}`, { headers: withAuth(token) })).shiftTypes;
}

export async function createShiftType(token: string, locationId: string, input: ShiftTypeInput): Promise<ShiftTypeDto> {
  return (await request<{ shiftType: ShiftTypeDto }>(`/api/shift-types/${locationId}`, json(token, 'POST', input))).shiftType;
}

export async function updateShiftType(token: string, locationId: string, id: string, patch: ShiftTypePatch): Promise<ShiftTypeDto> {
  return (await request<{ shiftType: ShiftTypeDto }>(`/api/shift-types/${locationId}/${id}`, json(token, 'PATCH', patch))).shiftType;
}

/** Archive (the "Delete" in the editor): the type leaves the dock; shifts already using it keep their times. */
export async function archiveShiftType(token: string, locationId: string, id: string): Promise<ShiftTypeDto> {
  return (await request<{ shiftType: ShiftTypeDto }>(`/api/shift-types/${locationId}/${id}/archive`, json(token, 'POST', {}))).shiftType;
}

/** The roster import's proposed types in one go; a name that already exists is skipped server-side. */
export async function bulkCreateShiftTypes(token: string, locationId: string, shiftTypes: ShiftTypeInput[]): Promise<ShiftTypeDto[]> {
  return (await request<{ shiftTypes: ShiftTypeDto[] }>(`/api/shift-types/${locationId}/bulk`, json(token, 'POST', { shiftTypes }))).shiftTypes;
}

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

export async function fetchDepartments(token: string, locationId: string): Promise<{ departments: DepartmentDto[]; minimums: DepartmentMinimumDto[] }> {
  return request(`/api/departments/${locationId}`, { headers: withAuth(token) });
}

export async function createDepartment(token: string, locationId: string, input: DepartmentInput): Promise<DepartmentDto> {
  return (await request<{ department: DepartmentDto }>(`/api/departments/${locationId}`, json(token, 'POST', input))).department;
}

export async function updateDepartment(token: string, locationId: string, id: string, patch: Partial<DepartmentInput>): Promise<DepartmentDto> {
  return (await request<{ department: DepartmentDto }>(`/api/departments/${locationId}/${id}`, json(token, 'PATCH', patch))).department;
}

export async function putDepartmentMinimums(
  token: string,
  locationId: string,
  id: string,
  minimums: { weekday: number; minHeadcount: number }[],
): Promise<DepartmentMinimumDto[]> {
  return (await request<{ minimums: DepartmentMinimumDto[] }>(`/api/departments/${locationId}/${id}/minimums`, json(token, 'PUT', { minimums }))).minimums;
}

// ---------------------------------------------------------------------------
// Time off
// ---------------------------------------------------------------------------

/** Staff file for themselves (omit `userId`); a manager may file on someone's behalf. */
export async function createTimeOffRequest(
  token: string,
  input: { userId?: string; startDate: string; endDate: string; reason?: string | null },
): Promise<TimeOffRequestDto> {
  return (await request<{ request: TimeOffRequestDto }>('/api/time-off', json(token, 'POST', input))).request;
}

export async function fetchTimeOffRequests(token: string, locationId: string, status: 'pending' | 'all' = 'pending'): Promise<TimeOffRequestDto[]> {
  return (await request<{ requests: TimeOffRequestDto[] }>(`/api/time-off/${locationId}?status=${status}`, { headers: withAuth(token) })).requests;
}

export type TimeOffDecisionResult =
  | { result: 'ok'; request: TimeOffRequestDto; versions: Record<string, number> }
  | { result: 'not_pending'; message: string }
  | { result: 'refused'; message: string };

/**
 * PATCH /api/time-off/:id — approve (every day becomes leave through the week
 * patch, shifts on those days become open shifts) or decline. 409 and 422
 * are normal answers the requests strip renders, so they come back as results.
 */
export async function decideTimeOff(token: string, id: string, input: TimeOffDecisionInput): Promise<TimeOffDecisionResult> {
  const res = await apiFetch(apiUrl(`/api/time-off/${id}`), json(token, 'PATCH', input));
  if (res.status === 200) {
    const body = (await res.json()) as { request: TimeOffRequestDto; versions?: Record<string, number> };
    return { result: 'ok', request: body.request, versions: body.versions ?? {} };
  }
  if (res.status === 409 || res.status === 422) {
    let message = res.status === 409 ? 'That request was already decided.' : 'That request could not be approved.';
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      message = body.message ?? body.error ?? message;
    } catch {
      // keep the default wording
    }
    return res.status === 409 ? { result: 'not_pending', message } : { result: 'refused', message };
  }
  let message = `Request failed (${res.status})`;
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) message = body.error;
  } catch {
    // non-JSON error body
  }
  throw new ApiError(message, res.status);
}
