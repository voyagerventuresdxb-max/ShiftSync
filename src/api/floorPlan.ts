/**
 * Client for the Floor Plan API (server/src/routes/floorPlan.ts) — section
 * drawing (admin setup) and daily staff assignment, both drag-and-drop and
 * tap-to-pick writing through the same endpoints.
 */
import { ApiError } from './schedules';

export { ApiError };

export interface Point {
  x: number;
  y: number;
}

export interface FloorPlanImageDto {
  id: string;
  locationId: string;
  fileUrl: string;
  originalName: string | null;
  mimeType: string;
  createdAt: string;
}

export interface FloorSectionDto {
  id: string;
  locationId: string;
  floorPlanImageId: string;
  label: string;
  polygon: Point[];
  paxCapacity: number;
  notes: string | null;
  sortOrder: number;
}

export interface AssignmentDto {
  id: string;
  sectionId: string;
  staffId: string;
  staffName: string;
  dutyLabel: string | null;
  status: 'DRAFT' | 'PUBLISHED';
}

export interface AssignmentSectionDto {
  id: string;
  label: string;
  polygon: Point[];
  paxCapacity: number;
  notes: string | null;
  assignments: AssignmentDto[];
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

/** GET /api/floor-plan/:locationId — current plan image + its sections. */
export async function fetchFloorPlan(
  locationId: string,
): Promise<{ image: FloorPlanImageDto | null; sections: FloorSectionDto[] }> {
  return request(`/api/floor-plan/${locationId}`);
}

/** POST /api/floor-plan/upload — upload the venue floor-plan image/PDF. */
export async function uploadFloorPlanImage(
  file: File,
  locationId: string,
): Promise<{ image: FloorPlanImageDto; sections: FloorSectionDto[] }> {
  const form = new FormData();
  form.append('file', file);
  form.append('locationId', locationId);
  return request('/api/floor-plan/upload', { method: 'POST', body: form });
}

/** POST /api/floor-plan/sections — save a drawn polygon section. */
export async function createFloorSection(input: {
  locationId: string;
  floorPlanImageId: string;
  label: string;
  polygon: Point[];
  paxCapacity: number;
  notes?: string | null;
}): Promise<FloorSectionDto> {
  const { section } = await request<{ section: FloorSectionDto }>('/api/floor-plan/sections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return section;
}

/** PATCH /api/floor-plan/sections/:id */
export async function updateFloorSection(
  sectionId: string,
  updates: Partial<{ label: string; polygon: Point[]; paxCapacity: number; notes: string | null }>,
): Promise<FloorSectionDto> {
  const { section } = await request<{ section: FloorSectionDto }>(`/api/floor-plan/sections/${sectionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  return section;
}

/** DELETE /api/floor-plan/sections/:id */
export async function deleteFloorSection(sectionId: string): Promise<void> {
  await request(`/api/floor-plan/sections/${sectionId}`, { method: 'DELETE' });
}

/** GET /api/floor-plan/:locationId/assignments?date=YYYY-MM-DD */
export async function fetchAssignments(
  locationId: string,
  date: string,
): Promise<{ image: FloorPlanImageDto | null; sections: AssignmentSectionDto[] }> {
  return request(`/api/floor-plan/${locationId}/assignments?date=${date}`);
}

/** POST /api/floor-plan/assignments — assign staff to a section for a date (drag-drop or tap-to-pick). */
export async function assignStaff(input: {
  sectionId: string;
  staffId: string;
  shiftDate: string;
  dutyLabel?: string | null;
  createdById?: string;
}): Promise<AssignmentDto> {
  const { assignment } = await request<{ assignment: AssignmentDto }>('/api/floor-plan/assignments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return assignment;
}

/** DELETE /api/floor-plan/assignments/:id — unassign. */
export async function removeAssignment(assignmentId: string): Promise<void> {
  await request(`/api/floor-plan/assignments/${assignmentId}`, { method: 'DELETE' });
}

/** POST /api/floor-plan/:locationId/publish — assignment writes only, no notification. */
export async function publishAssignments(
  locationId: string,
  shiftDate: string,
): Promise<{ publishedCount: number }> {
  return request(`/api/floor-plan/${locationId}/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shiftDate }),
  });
}
