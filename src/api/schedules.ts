/**
 * Client for the ShiftSync schedules API (server/src/routes/schedules.ts).
 *
 * Mirrors the server's preview-row contract so the review UI can render
 * exactly what the parser resolved before anything is committed.
 */

import { withAuth } from './identity';

export type RowMatchStatus =
  | 'matched'
  | 'new_employee'
  | 'unmatched_role'
  | 'error';

export interface PreviewRow {
  rowNumber: number;
  employeeName: string;
  role: string;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  /** 24h HH:mm. */
  startTime: string;
  /** 24h HH:mm. */
  endTime: string;
  overnight: boolean;
  breakMinutes: number;
  managerNotes: string | null;
  status: RowMatchStatus;
  issues: { rowNumber: number; field?: string; severity: 'error' | 'warning' | 'info'; message: string }[];
}

export interface UploadPreviewSummary {
  totalRows: number;
  matchedRows: number;
  newEmployeeRows: number;
  unmatchedRoleRows: number;
  errorRows: number;
}

export interface AnomalyRecord {
  employeeName: string | null;
  date: string | null;
  rawText: string;
  reason: string;
  confidence: number;
  /** Links this anomaly to a `PreviewRow.rowNumber`, if it also produced a row. `null` when it has no corresponding row. */
  rowNumber: number | null;
  /**
   * Distinguishes an anomaly kind from a single unresolved vision-model
   * cell (the default, undefined case) — the existing generic anomaly UI
   * already renders/gates any of these correctly without branching on
   * this field. See server/src/parsing/types.ts's AnomalyRecord for what
   * each kind means.
   */
  kind?: 'unrecognized_section_header' | 'unrecognized_merged_name_cell' | 'ignored_workbook_sheets';
  /** Every row number this one anomaly applies to, for a `kind` that doesn't map 1:1 onto `rowNumber` above. */
  affectedRowNumbers?: number[];
}

export interface LeaveRecord {
  employeeName: string;
  date: string;
  leaveCode: string;
  category: 'leave' | 'day_off' | 'public_holiday';
}

export interface UploadResponse {
  batchId: string;
  templateDetected: string | null;
  parseIssues: PreviewRow['issues'];
  summary: UploadPreviewSummary;
  /** Populated only for image/VLM uploads — cells the model could not confidently resolve. */
  anomalies: AnomalyRecord[];
  /** Populated only for image/VLM uploads — AL/PH/DO-style non-working-day records. */
  leaveRecords: LeaveRecord[];
  /** Populated only for image/VLM uploads — the shift-code legend the model inferred. */
  legend: { code: string; meaning: string }[];
  preview: PreviewRow[];
}

export interface ConfirmResponse {
  message: string;
  createdCount: number;
  skippedCount: number;
  rows: { rowNumber: number; shiftId: string; userId: string | null }[];
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

/** POST /api/schedules/upload — parse + preview an Excel/CSV roster. */
export async function uploadRoster(token: string, file: File): Promise<UploadResponse> {
  const form = new FormData();
  form.append('file', file);
  return request<UploadResponse>('/api/schedules/upload', {
    method: 'POST',
    headers: withAuth(token),
    body: form,
  });
}

/** A manager's Review-screen correction, applied server-side before persisting — see confirmRoster. */
export interface RosterRowEdit {
  rowNumber: number;
  employeeName?: string;
  role?: string;
}

/**
 * POST /api/schedules/upload/:batchId/confirm — commit a reviewed batch.
 * `edits`/`removedRowNumbers` carry the onboarding Review screen's inline
 * name/role corrections and row removals; both are re-resolved against
 * Role/User records server-side (a `role` with no existing match is created
 * as a new, reusable Role for the venue) rather than trusting the client's
 * display strings as-is.
 */
export async function confirmRoster(
  token: string,
  batchId: string,
  createdById?: string,
  edits?: RosterRowEdit[],
  removedRowNumbers?: number[],
): Promise<ConfirmResponse> {
  return request<ConfirmResponse>(`/api/schedules/upload/${batchId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...withAuth(token) },
    body: JSON.stringify({ createdById: createdById ?? null, edits: edits ?? undefined, removedRowNumbers: removedRowNumbers ?? undefined }),
  });
}
