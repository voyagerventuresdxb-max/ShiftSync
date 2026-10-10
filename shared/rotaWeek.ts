/**
 * Rota builder v2 — the week document contract shared by the server
 * (server/src/lib/actions/weekActions.ts, routes/weeks.ts, voice) and the
 * client (src/api/weeks.ts, the week grid, phone views, Team Matrix, Personal
 * Rota). One source of truth for the roster: `shifts` + `rota_leaves`, versioned
 * per (venue, Monday) by `rota_weeks.version`. Every write presents the version
 * it last saw and gets the new one back; every reader refetches on a bump.
 *
 * Design: Design canvas boards C (handoff spec) and E (sync map).
 */

/** "HH:MM" venue-local wall-clock. */
export type HHMM = string;
/** "YYYY-MM-DD" venue-local calendar day. */
export type IsoDate = string;

/** Chip-token names from tokens.css. Never a hex: the palette gate forbids colour literals. */
export const SHIFT_TINTS = ['gold', 'sand', 'clay', 'ochre', 'sage', 'cream'] as const;
export type ShiftTint = (typeof SHIFT_TINTS)[number];

export interface TimeRange {
  start: HHMM;
  end: HHMM;
}

export interface ShiftTypeDto {
  id: string;
  name: string;
  /** One range, or two for a split shift. */
  ranges: TimeRange[];
  /** The last range ends at or before it starts, so the shift ends the next venue day. */
  endsNextDay: boolean;
  tint: ShiftTint;
  sortOrder: number;
  archivedAt: string | null;
}

export interface DepartmentDto {
  id: string;
  name: string;
  tint: ShiftTint;
  sortOrder: number;
  /** Role ids grouped under this department. */
  roleIds: string[];
}

export type LeaveTypeCode = 'DAY_OFF' | 'ANNUAL_LEAVE' | 'SICK_LEAVE' | 'UNPAID_LEAVE' | 'HALF_DAY';

export const LEAVE_LABELS: Record<LeaveTypeCode, string> = {
  DAY_OFF: 'Day off',
  ANNUAL_LEAVE: 'Annual leave',
  SICK_LEAVE: 'Sick',
  UNPAID_LEAVE: 'Unpaid',
  HALF_DAY: 'Half day',
};

/** A leave type that locks the cell for drag/paint/tap (B2 state 3a). Day off and Half day never lock. */
export function leaveBlocksShifts(type: LeaveTypeCode): boolean {
  return type === 'ANNUAL_LEAVE' || type === 'SICK_LEAVE' || type === 'UNPAID_LEAVE';
}

export interface WeekShiftDto {
  id: string;
  /** null = open (unassigned) shift. */
  userId: string | null;
  roleId: string;
  departmentId: string | null;
  shiftTypeId: string | null;
  date: IsoDate;
  /** Frozen at creation from the shift type (or custom): 1–2 ranges. */
  ranges: TimeRange[];
  endsNextDay: boolean;
  /** Staff-visible, ≤ 80 chars. */
  note: string | null;
  status: 'draft' | 'published';
  /** True when changed after the week's last publish (gold dot). */
  editedSincePublish: boolean;
  /** Overlaps a pending time-off request for that person-day (B2 state 3b). */
  pendingRequestId: string | null;
}

export interface WeekLeaveDto {
  id: string;
  userId: string;
  date: IsoDate;
  type: LeaveTypeCode;
  status: 'draft' | 'published';
  /** True when created by an approved time-off request: locked until the request is reversed. */
  fromRequest: boolean;
}

export interface WeekPersonDto {
  id: string;
  fullName: string;
  initials: string;
  roleId: string | null;
  roleTitle: string | null;
  departmentId: string | null;
  /** A second department this person may be scheduled under ("also Bar"). */
  alsoDepartmentIds: string[];
  isActive: boolean;
  /** Has a device registered, so an in-app notice reaches them. */
  hasDevice: boolean;
}

export interface WeekRequestDto {
  id: string;
  kind: 'timeOff' | 'swap';
  status: 'pending' | 'approved' | 'declined';
  userId: string;
  /** timeOff: the dates asked for; swap: the two shift dates. */
  dates: IsoDate[];
  /** swap only */
  shiftId?: string;
  targetUserId?: string | null;
  targetShiftId?: string | null;
  reason: string | null;
  createdAt: string;
}

export interface CoverageDayDto {
  date: IsoDate;
  /** People with at least one shift that day (a double counts once). */
  on: number;
  /** People with no shift and no leave. */
  off: number;
  /** People on leave of any type. */
  leave: number;
  /** Departments under their minimum or with open shifts, and by how many. */
  uncovered: { departmentId: string; short: number }[];
}

export interface WeekDocDto {
  locationId: string;
  weekStart: IsoDate;
  timezone: string;
  clock: '12h' | '24h';
  version: number;
  state: 'draft' | 'published';
  publishedAt: string | null;
  publishedVersion: number | null;
  /** True when any shift or leave changed since `publishedVersion`. */
  hasUnpublishedChanges: boolean;
  departments: DepartmentDto[];
  shiftTypes: ShiftTypeDto[];
  people: WeekPersonDto[];
  shifts: WeekShiftDto[];
  leaves: WeekLeaveDto[];
  requests: WeekRequestDto[];
  coverage: CoverageDayDto[];
}

// ---------------------------------------------------------------------------
// Writes: one batch patch for every roster mutation
// ---------------------------------------------------------------------------

export type WeekPatchOp =
  | {
      op: 'create';
      /** Client-side id echoed back in `results` so the grid can map temp chips. */
      tempId?: string;
      userId: string | null;
      roleId?: string;
      departmentId?: string | null;
      date: IsoDate;
      /** Either a venue shift type… */
      shiftTypeId?: string;
      /** …or custom ranges (manager edited the times in the shift sheet). */
      ranges?: TimeRange[];
      note?: string | null;
    }
  | {
      op: 'update';
      shiftId: string;
      userId?: string | null;
      roleId?: string;
      departmentId?: string | null;
      date?: IsoDate;
      shiftTypeId?: string | null;
      ranges?: TimeRange[];
      note?: string | null;
    }
  | { op: 'delete'; shiftId: string }
  | { op: 'setLeave'; userId: string; date: IsoDate; type: LeaveTypeCode }
  | { op: 'clearLeave'; userId: string; date: IsoDate };

export interface WeekPatchInput {
  /** The version the client last saw. Omit only for legacy single-shift callers (logged). */
  expectedVersion?: number;
  ops: WeekPatchOp[];
  /**
   * Set by the client after the confirm sheet: allows a create/update onto a
   * person-day with a PENDING time-off request, which declines that request in
   * the same transaction (B2 state 3b). Without it such an op is refused with
   * `pending_request`.
   */
  overridePendingRequests?: boolean;
  /** Free text for the audit note (a voice transcript, a template name). */
  note?: string | null;
}

export type WeekPatchRefusal =
  | 'version_conflict'
  | 'not_monday'
  | 'outside_week'
  | 'past_day'
  | 'unknown_shift'
  | 'unknown_person'
  | 'unknown_role'
  | 'unknown_shift_type'
  | 'bad_ranges'
  | 'note_too_long'
  | 'person_on_leave'
  | 'pending_request'
  | 'already_has_shift'
  | 'overlap'
  | 'leave_over_shift'
  /** `setLeave` with a `type` that is not a LeaveTypeCode. */
  | 'bad_leave_type';

export type WeekPatchResult =
  | {
      result: 'ok';
      version: number;
      /** Per-op outcome, same order as `ops`; `tempId` echoed for creates. */
      results: { op: number; tempId?: string; shiftId?: string; leaveId?: string }[];
      /** Requests declined because `overridePendingRequests` was set. */
      declinedRequestIds: string[];
      week: WeekDocDto;
    }
  | { result: 'version_conflict'; currentVersion: number; week: WeekDocDto }
  | { result: 'refused'; refusal: WeekPatchRefusal; op: number; message: string };

// ---------------------------------------------------------------------------
// Publish: server-computed diff + fingerprint
// ---------------------------------------------------------------------------

export interface PublishDiffRow {
  userId: string;
  fullName: string;
  hasDevice: boolean;
  changes: {
    date: IsoDate;
    before: string | null;
    after: string | null;
    /** The shift starts within 24 h of now: prompt the manager to call. */
    urgent: boolean;
  }[];
}

export interface PublishPreviewDto {
  weekStart: IsoDate;
  version: number;
  firstPublish: boolean;
  changeCount: number;
  notifiedCount: number;
  noDeviceUserIds: string[];
  rows: PublishDiffRow[];
  uncovered: { date: IsoDate; departmentId: string; departmentName: string; short: number }[];
  /** sha256 over (locationId, weekStart, version, canonical diff). Presented back to publish. */
  fingerprint: string;
}

export type PublishResult =
  | { result: 'ok'; version: number; publishedAt: string; notifiedCount: number; noDeviceUserIds: string[] }
  | { result: 'version_conflict'; currentVersion: number }
  | { result: 'fingerprint_mismatch'; preview: PublishPreviewDto }
  | { result: 'empty'; message: string };

// ---------------------------------------------------------------------------
// Helpers shared by both sides
// ---------------------------------------------------------------------------

/** True when the range ends at or before it starts, i.e. runs past midnight. */
export function rangeEndsNextDay(r: TimeRange): boolean {
  return r.end <= r.start;
}

/** A shift's `endsNextDay` from its ranges: only the last range may cross midnight. */
export function rangesEndNextDay(ranges: TimeRange[]): boolean {
  return ranges.length > 0 && rangeEndsNextDay(ranges[ranges.length - 1]);
}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Validates 1–2 well-formed ranges: HH:MM each, only the last may cross midnight, the two must not overlap. */
export function validateRanges(ranges: unknown): ranges is TimeRange[] {
  if (!Array.isArray(ranges) || ranges.length < 1 || ranges.length > 2) return false;
  for (const r of ranges) {
    if (!r || typeof r !== 'object') return false;
    const { start, end } = r as Partial<TimeRange>;
    if (typeof start !== 'string' || typeof end !== 'string' || !HHMM_RE.test(start) || !HHMM_RE.test(end)) return false;
    if (start === end) return false;
  }
  if (ranges.length === 2) {
    const [a, b] = ranges as TimeRange[];
    // First range must end before the second starts, on the same day.
    if (rangeEndsNextDay(a)) return false;
    if (b.start < a.end) return false;
  }
  return true;
}

/** Initials for an avatar: first letter of the first and last word ("Omar Al-Rashid" → "OA"). */
export function initialsOf(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Format a range for a chip: "07:00–16:00" or "7am–4pm". */
export function formatRange(r: TimeRange, clock: '12h' | '24h'): string {
  if (clock === '24h') return `${r.start}–${r.end}`;
  const f = (t: HHMM) => {
    const [h, m] = t.split(':').map(Number);
    const ap = h >= 12 ? 'pm' : 'am';
    const hh = h % 12 || 12;
    return m ? `${hh}:${String(m).padStart(2, '0')}${ap}` : `${hh}${ap}`;
  };
  return `${f(r.start)}–${f(r.end)}`;
}

/** The Monday (YYYY-MM-DD) of the week containing `iso`, pure calendar math. */
export function mondayOf(iso: IsoDate): IsoDate {
  const d = new Date(`${iso}T00:00:00.000Z`);
  const diff = d.getUTCDay() === 0 ? -6 : 1 - d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

/** `iso` + n days, pure calendar math. */
export function addDays(iso: IsoDate, n: number): IsoDate {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The seven days of the week starting `weekStart`. */
export function weekDays(weekStart: IsoDate): IsoDate[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

// ---------------------------------------------------------------------------
// Supporting endpoints (rota builder v2). Server: routes/shiftTypes.ts,
// routes/departments.ts, routes/timeOff.ts. Client: src/api/rotaSetup.ts.
// All venue-scoped by the caller's session; writes are manager-only except
// POST /api/time-off (staff file for themselves).
// ---------------------------------------------------------------------------

/** GET /api/shift-types/:locationId → { shiftTypes }. POST same path → { shiftType }. */
export interface ShiftTypeInput {
  name: string;
  ranges: TimeRange[];
  tint: ShiftTint;
  sortOrder?: number;
}
/** PATCH /api/shift-types/:locationId/:id (partial ShiftTypeInput) → { shiftType }; POST …/:id/archive → { shiftType }. */
export type ShiftTypePatch = Partial<ShiftTypeInput>;
/**
 * POST /api/shift-types/:locationId/bulk { shiftTypes: ShiftTypeInput[] } → { shiftTypes }.
 * Accepts the roster import's proposals in one go; a name that already exists is skipped, not duplicated.
 */
export interface ProposedShiftType extends ShiftTypeInput {
  /** How many imported cells used these exact times. */
  count: number;
}

/** GET /api/departments/:locationId → { departments, minimums }. */
export interface DepartmentMinimumDto {
  departmentId: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  minHeadcount: number;
}
/** POST /api/departments/:locationId { name, tint } → { department }; PATCH …/:id { name?, tint?, sortOrder?, roleIds? } → { department }. */
export interface DepartmentInput {
  name: string;
  tint: ShiftTint;
  sortOrder?: number;
  /** Replaces the set of roles grouped under this department. */
  roleIds?: string[];
}
/** PUT /api/departments/:locationId/:id/minimums { minimums: { weekday, minHeadcount }[] } → { minimums }. */

/** POST /api/time-off { userId?, startDate, endDate, reason? } → { request }. Staff may only file for themselves. */
export interface TimeOffRequestDto {
  id: string;
  userId: string;
  fullName: string;
  startDate: IsoDate;
  endDate: IsoDate;
  reason: string | null;
  status: 'pending' | 'approved' | 'declined';
  createdAt: string;
  reviewedAt: string | null;
  managerNote: string | null;
}
/** GET /api/time-off/:locationId?status=pending|all → { requests }. Staff see only their own. */
/**
 * PATCH /api/time-off/:id { decision, leaveType?, note? } (manager) →
 * 200 { result: 'ok', request, versions: { [weekStart]: version } } | 409 { result: 'not_pending' } | 422 { result: 'refused', message }.
 * Approve: every day of the range becomes a RotaLeave (default ANNUAL_LEAVE) through the week patch — any shift on
 * those days becomes an open shift in the same version bump — and the requester is told.
 */
export interface TimeOffDecisionInput {
  decision: 'approve' | 'decline';
  leaveType?: LeaveTypeCode;
  note?: string | null;
}

/**
 * GET /api/my-shifts (existing route) — v2 adds these fields to each item so
 * the staff week, next-shift card and kiosk can show the type, both ranges of
 * a split, the "+1" marker and the staff-visible note. Published shifts only.
 */
export interface MyShiftV2Fields {
  shiftTypeName: string | null;
  ranges: TimeRange[];
  endsNextDay: boolean;
  note: string | null;
}
