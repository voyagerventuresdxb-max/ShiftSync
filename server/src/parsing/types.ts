/**
 * Excel/CSV schedule ingestion — shared types.
 *
 * Pure data contracts, no DB or HTTP imports, so the parsing engine stays
 * unit-testable in isolation from Express/Prisma.
 */

/** Canonical field keys every master template must resolve to. */
export type TemplateField =
  | 'employeeName'
  | 'role'
  | 'date'
  | 'startTime'
  | 'endTime'
  | 'managerNotes'
  | 'breakMinutes';

/** One of ShiftSync's 3 supported master roster template formats. */
export interface TemplateDefinition {
  id: 'STANDARD' | 'COMPACT' | 'TIME_RANGE';
  label: string;
  /** Header aliases (normalized: lowercase, alnum+space only) per field. */
  aliases: Record<TemplateField, string[]>;
  /** Fields that must resolve to a column for this template to match. */
  requiredFields: TemplateField[];
  /** True when startTime/endTime are combined in one "9:00-17:00" style column. */
  combinedTimeRange: boolean;
}

/** A raw spreadsheet row after column mapping, before validation. */
export interface RawMappedRow {
  rowNumber: number; // 1-based, matches spreadsheet row (header = row 1)
  employeeName: unknown;
  role: unknown;
  date: unknown;
  startTime: unknown;
  endTime: unknown;
  managerNotes: unknown;
  breakMinutes: unknown;
}

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface RowIssue {
  rowNumber: number;
  field?: TemplateField;
  severity: IssueSeverity;
  message: string;
}

/** A cleanly-parsed shift, ready for role/user resolution against the DB. */
export interface ParsedShiftRow {
  rowNumber: number;
  employeeName: string;
  roleName: string;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  /** 24h HH:mm. */
  startTime: string;
  /** 24h HH:mm. */
  endTime: string;
  overnight: boolean;
  breakMinutes: number;
  managerNotes: string | null;
}

export interface ParsedWorkbookResult {
  templateId: TemplateDefinition['id'] | null;
  templateLabel: string | null;
  rows: ParsedShiftRow[];
  issues: RowIssue[];
}

/**
 * A cell (or sheet-level artifact) the VLM ingestion path could not
 * confidently resolve into a shift/leave record. Surfaced separately from
 * `RowIssue` because these aren't tied to a droppable row — the manager
 * needs to see the raw source text and decide what it means.
 */
export interface AnomalyRecord {
  employeeName: string | null;
  date: string | null;
  rawText: string;
  reason: string;
  confidence: number;
  /**
   * Links this anomaly back to the `ParsedShiftRow`/`PreviewRow` it was
   * raised alongside (e.g. a resolved-but-`needsReview` cell), so the
   * Confirm UI can join anomalies onto rows by `rowNumber` at render time.
   * `null` when the anomaly has no corresponding row at all (the cell
   * couldn't be placed as a row — no employee, no date, no resolvable time).
   */
  rowNumber: number | null;
  /**
   * Distinguishes an anomaly kind that needs different manager-review
   * handling than a single unresolved cell. Undefined for every
   * pre-existing anomaly source (one unresolved vision-model cell, tied to
   * exactly one row via `rowNumber`) — only the deterministic grid
   * parser's unrecognized-section-header detection sets this, since one
   * such anomaly can span every row grouped under that header at once
   * (see `affectedRowNumbers`). Only 'unrecognized_section_header' today;
   * kept as a string union (not a boolean flag) so a future distinct kind
   * doesn't need a parallel field.
   */
  kind?: 'unrecognized_section_header';
  /**
   * Every row number this one anomaly applies to, for a `kind` that
   * doesn't map 1:1 onto the singular `rowNumber` field above (a section
   * header can apply to many staff rows at once). Undefined for anomaly
   * kinds that already use `rowNumber` alone.
   */
  affectedRowNumbers?: number[];
}

/** Non-working-day record (leave/day-off/public holiday) — not persisted as a Shift, shown for manager awareness. */
export interface LeaveRecord {
  employeeName: string;
  date: string;
  leaveCode: string;
  category: 'leave' | 'day_off' | 'public_holiday';
}

export interface ParsedVisionResult {
  templateLabel: string;
  rows: ParsedShiftRow[];
  issues: RowIssue[];
  anomalies: AnomalyRecord[];
  leaveRecords: LeaveRecord[];
  legend: { code: string; meaning: string }[];
}

/** Resolution status of a parsed row against Location/Role/User tables. */
export type RowMatchStatus = 'matched' | 'new_employee' | 'unmatched_role' | 'error';

export interface PreviewRow extends ParsedShiftRow {
  status: RowMatchStatus;
  resolvedRoleId: string | null;
  resolvedUserId: string | null;
  issues: RowIssue[];
}

export interface UploadPreviewSummary {
  totalRows: number;
  matchedRows: number;
  newEmployeeRows: number;
  unmatchedRoleRows: number;
  errorRows: number;
}
