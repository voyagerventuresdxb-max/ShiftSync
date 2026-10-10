import { apiFetch } from './http';
import { ApiError } from './schedules';
import { apiUrl } from '../lib/apiUrl';
import type {
  PublishPreviewDto,
  PublishResult,
  WeekDocDto,
  WeekPatchInput,
  WeekPatchResult,
} from '../../shared/rotaWeek';

/**
 * Rota builder v2 client for /api/weeks (server/src/routes/weeks.ts). The week
 * document is the one roster read every rota surface shares; every roster
 * write is a versioned batch patch. 409 and 422 are not thrown: they are the
 * normal "someone else saved" and "that move is not allowed" answers the grid
 * renders, so they come back as typed results.
 */

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) return body.error;
  } catch {
    // non-JSON error body
  }
  return `Request failed (${res.status})`;
}

/** GET /api/weeks/:locationId/:weekStart — `headers` from `venueReadHeaders` (a kiosk token gets the published-only view). */
export async function fetchWeekDoc(locationId: string, weekStart: string, headers: Record<string, string>): Promise<WeekDocDto> {
  const res = await apiFetch(apiUrl(`/api/weeks/${locationId}/${weekStart}`), { headers });
  if (!res.ok) throw new ApiError(await readError(res), res.status);
  return (await res.json()) as WeekDocDto;
}

/** PATCH /api/weeks/:locationId/:weekStart — 200 ok, 409 version_conflict, 422 refused, all as results. */
export async function patchWeek(token: string, locationId: string, weekStart: string, input: WeekPatchInput): Promise<WeekPatchResult> {
  const res = await apiFetch(apiUrl(`/api/weeks/${locationId}/${weekStart}`), {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (res.status === 200 || res.status === 409) return (await res.json()) as WeekPatchResult;
  if (res.status === 422) {
    const body = (await res.json()) as { error: string; refusal: Extract<WeekPatchResult, { result: 'refused' }>['refusal']; op: number };
    return { result: 'refused', refusal: body.refusal, op: body.op, message: body.error };
  }
  throw new ApiError(await readError(res), res.status);
}

/** POST …/publish-preview — the per-person diff and the fingerprint the publish must present. */
export async function previewPublish(token: string, locationId: string, weekStart: string): Promise<PublishPreviewDto> {
  const res = await apiFetch(apiUrl(`/api/weeks/${locationId}/${weekStart}/publish-preview`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new ApiError(await readError(res), res.status);
  return (await res.json()) as PublishPreviewDto;
}

/** POST …/publish — 409 (version_conflict / fingerprint_mismatch) and 422 (empty) come back as results. */
export async function publishWeek(token: string, locationId: string, weekStart: string, input: { expectedVersion: number; fingerprint: string }): Promise<PublishResult> {
  const res = await apiFetch(apiUrl(`/api/weeks/${locationId}/${weekStart}/publish`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (res.status === 200 || res.status === 409) return (await res.json()) as PublishResult;
  if (res.status === 422) {
    const body = (await res.json()) as { error: string };
    return { result: 'empty', message: body.error };
  }
  throw new ApiError(await readError(res), res.status);
}

// ---------------------------------------------------------------------------
// One "roster changed" signal for every surface that shows the roster
// ---------------------------------------------------------------------------

const ROSTER_CHANGED = 'shiftsync:roster-changed';

/**
 * Tell every rota surface in this tab (week grid, Team Matrix, Personal Rota,
 * My shifts, next-shift card) that the roster for `weekStart` moved to
 * `version`. Fired after any successful patch, publish, approval or import, so
 * no surface keeps a stale copy (Design board E, "Refresh signal").
 */
export function emitRosterChanged(detail: { locationId: string; weekStart: string; version: number }): void {
  window.dispatchEvent(new CustomEvent(ROSTER_CHANGED, { detail }));
}

export function onRosterChanged(listener: (detail: { locationId: string; weekStart: string; version: number }) => void): () => void {
  const handler = (e: Event) => listener((e as CustomEvent<{ locationId: string; weekStart: string; version: number }>).detail);
  window.addEventListener(ROSTER_CHANGED, handler);
  return () => window.removeEventListener(ROSTER_CHANGED, handler);
}
