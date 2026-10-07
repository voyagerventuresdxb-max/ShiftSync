/**
 * Client for the ShiftSync schedules API (server/src/routes/schedules.ts).
 *
 * Mirrors the server's preview-row contract so the review UI can render
 * exactly what the parser resolved before anything is committed.
 */

import { apiFetch } from './http';
import { withAuth } from './identity';
import { apiUrl } from '../lib/apiUrl';

export type RowMatchStatus =
  | 'matched'
  | 'new_employee'
  | 'unmatched_role'
  | 'error';

/** Which reader found a row or a person (server/src/parsing/rosterContract.ts). */
export type ReaderSource = 'ai' | 'table' | 'both';

/** Per-shift flags shown on the review screen. */
export type RowFlag = 'ai_only' | 'table_only' | 'times_differ' | 'low_confidence';

export interface ShiftAlternative {
  reader: 'ai' | 'table';
  startTime: string;
  endTime: string;
  overnight: boolean;
}

export interface PreviewRow {
  rowNumber: number;
  /**
   * Identifies which single physical source-file row/block this shift came
   * from — shared by every shift belonging to the same staff member, unlike
   * `rowNumber` (one per shift). Only set for grid/vision-parsed uploads;
   * absent for free-text uploads, whose input has no such structure.
   */
  sourceRowIndex?: number;
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
  /** Groups every shift of one person in this file. Absent from older servers / parsers. */
  personKey?: string;
  /** Section / group header the person was listed under, as printed. */
  section?: string | null;
  sourcePage?: number | null;
  readerSource?: ReaderSource;
  flags?: RowFlag[];
  /** With `times_differ`: what each reader read. */
  alternatives?: ShiftAlternative[];
}

/** Counts of PEOPLE (not rows) on the roster. */
export interface PeopleSummary {
  total: number;
  matched: number;
  new: number;
  needsDecision: number;
  roleUnresolved: number;
}

export interface UploadPreviewSummary {
  totalRows: number;
  matchedRows: number;
  newEmployeeRows: number;
  unmatchedRoleRows: number;
  errorRows: number;
  people?: PeopleSummary;
}

/** A person a reader saw on the roster, including people with no shifts that week. */
export interface ReadPerson {
  personKey: string;
  name: string;
  roleLabel: string | null;
  section: string | null;
  sourcePage: number | null;
  sourceRow: number | null;
  readerSource: ReaderSource;
}

/** A row that looks like part of the roster but could not be read. */
export interface UnreadRow {
  page: number | null;
  row: number | null;
  text: string;
  reason: string;
}

export interface WeekDetection {
  /** ISO Monday. */
  weekStart: string;
  /** ISO Sunday. */
  weekEnd: string;
  source: 'printed_dates' | 'title' | 'weekday_only' | 'none';
  printedLabel: string | null;
  /** The manager must confirm or pick the week before confirming. */
  needsConfirmation: boolean;
  reason: string | null;
}

export interface ReadingReport {
  ai: 'used' | 'cached' | 'not_used' | 'declined' | 'unavailable' | 'paused';
  table: 'used' | 'not_applicable' | 'failed';
  rowsDetected: number | null;
  peopleFound: number;
  rereadPages: number[];
  disagreements: number;
  /** "Read from previous upload": nothing was billed. */
  fromCache: boolean;
}

export type PersonStatus = 'matched' | 'new' | 'needs_decision';

export type PersonFlag =
  | { kind: 'possible_match'; candidates: { userId: string; fullName: string }[] }
  | { kind: 'duplicate_name'; personKeys: string[] }
  | { kind: 'two_sections'; sections: string[] }
  | { kind: 'name_differs'; spellings: string[] }
  | { kind: 'ai_only' }
  | { kind: 'table_only' }
  | { kind: 'role_unresolved' };

/** One entry per person on the roster: the review screen's unit. */
export interface PersonPreview {
  personKey: string;
  name: string;
  normalizedName: string;
  roleLabel: string | null;
  resolvedRoleId: string | null;
  section: string | null;
  status: PersonStatus;
  matchedUserId: string | null;
  flags: PersonFlag[];
  shiftCount: number;
  rowNumbers: number[];
  sourceRows: { page: number | null; row: number | null }[];
  suggestedAction?: 'create' | 'link';
  suggestedUserId?: string | null;
}

/** What the manager decided for one person. */
export interface ConfirmPersonDecision {
  personKey: string;
  action: 'create' | 'link' | 'skip';
  userId?: string;
  name?: string;
  roleName?: string | null;
}

/** "Add missing person". */
export interface AddedPerson {
  name: string;
  roleName: string | null;
}

export interface ImportOverlap {
  personKey: string;
  name: string;
  date: string;
  startTime: string;
  endTime: string;
  existing: { date: string; startTime: string; endTime: string };
}

export interface ConfirmedPerson {
  personKey: string;
  name: string;
  outcome: 'created' | 'linked' | 'skipped';
  userId: string | null;
  roleName: string | null;
  shiftsCreated: number;
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
  /**
   * Present when the AI reader was used ('used'), would help but needs the manager's
   * go-ahead ('needs_consent'), or couldn't run ('unavailable'). See server parsing/escalation.ts.
   */
  escalation?: { reason: string; status: 'used' | 'needs_consent' | 'unavailable'; message: string };
  /** One entry per person (absent from older servers: the review screen derives people from `preview`). */
  people?: PersonPreview[];
  /** Every person a reader saw, including people with no shifts that week. */
  readPeople?: ReadPerson[];
  /** Rows that could not be read, listed for the manager. */
  unreadRows?: UnreadRow[];
  /** The week the shifts are dated in, and whether the manager must confirm it. */
  week?: WeekDetection;
  reading?: ReadingReport;
  preview: PreviewRow[];
}

export interface ConfirmResponse {
  message: string;
  /** Shifts written. */
  createdCount: number;
  /** Rows not written: skipped people, shifts already on the rota, overlaps. */
  skippedCount: number;
  rows: { rowNumber: number; shiftId: string; userId: string | null; date: string }[];
  createdPeople: number;
  linkedPeople: number;
  skippedPeople: number;
  createdShifts: number;
  /** Identical shifts already on the rota: not written again. */
  skippedDuplicates: number;
  overlaps: ImportOverlap[];
  people: ConfirmedPerson[];
  /** The Monday of the week the shifts were written into. */
  weekStart: string | null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /** From a 429's `Retry-After` header, when the server sent one. */
    public readonly retryAfterSeconds?: number,
    /** The server's machine-readable `errorCode`, when it sent one (e.g. `ai_consent_required`). */
    public readonly errorCode?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(apiUrl(url), init);
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    let errorCode: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; errorCode?: string };
      if (body?.error) message = body.error;
      errorCode = body?.errorCode;
    } catch {
      // non-JSON error body; keep the generic message
    }
    throw new ApiError(message, res.status, undefined, errorCode);
  }
  return (await res.json()) as T;
}

/**
 * POST /api/schedules/upload — parse + preview a roster. `aiConsent`: the manager agreed to send
 * THIS file to the third-party AI reader (the server asks with `ai_consent_required` first).
 */
export async function uploadRoster(token: string, file: File, options: { aiConsent?: boolean } = {}): Promise<UploadResponse> {
  const form = new FormData();
  form.append('file', file);
  if (options.aiConsent) form.append('aiConsent', 'true');
  try {
    return await request<UploadResponse>('/api/schedules/upload', {
      method: 'POST',
      headers: withAuth(token),
      body: form,
    });
  } catch (err) {
    throw uploadFailure(err);
  }
}

export const UPLOAD_TIMED_OUT_MESSAGE =
  'Reading this roster took too long and the connection timed out. Nothing was saved. Try again, or upload the spreadsheet (Excel/CSV) version, which reads in seconds.';
export const UPLOAD_CONNECTION_LOST_MESSAGE = 'The connection dropped while your roster was being read. Nothing was saved. Check your connection and try again.';

/**
 * A plain message for an upload that never got an answer from the API: a proxy timeout
 * (an AI read can take tens of seconds; the hosting rewrite gives up after ~120s with a bare
 * 502/504) or a dropped connection. The API's own errors keep their message.
 */
export function uploadFailure(err: unknown): unknown {
  if (err instanceof ApiError && [502, 503, 504].includes(err.status) && err.errorCode === undefined && /^Request failed/.test(err.message)) {
    return new ApiError(UPLOAD_TIMED_OUT_MESSAGE, err.status, err.retryAfterSeconds, 'upload_timed_out');
  }
  if (err instanceof TypeError) return new ApiError(UPLOAD_CONNECTION_LOST_MESSAGE, 0, undefined, 'connection_lost');
  return err;
}

/** A manager's per-row correction, applied server-side before persisting — see confirmRoster. */
export interface RosterRowEdit {
  rowNumber: number;
  employeeName?: string;
  role?: string;
  /** The manager's pick when the two readers read different times. */
  startTime?: string;
  endTime?: string;
  overnight?: boolean;
}

export interface ConfirmRosterRequest {
  createdById?: string | null;
  /** ISO Monday the manager confirmed; the server moves every shift by whole weeks to land in it. */
  weekStart?: string;
  people?: ConfirmPersonDecision[];
  addedPeople?: AddedPerson[];
  /** Remember role labels assigned by hand for the next import. */
  rememberRoleMappings?: boolean;
  edits?: RosterRowEdit[];
  removedRowNumbers?: number[];
}

/**
 * POST /api/schedules/upload/:batchId/confirm — commit a reviewed batch: every person not
 * skipped becomes (or links to) a real staff member and gets their shifts. Idempotent on the
 * server: confirming the same roster again creates nobody and no shifts.
 */
export async function confirmRoster(token: string, batchId: string, body: ConfirmRosterRequest): Promise<ConfirmResponse> {
  return request<ConfirmResponse>(`/api/schedules/upload/${batchId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...withAuth(token) },
    body: JSON.stringify(body),
  });
}
