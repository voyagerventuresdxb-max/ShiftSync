/**
 * ShiftSync canonical roster data contract.
 *
 * This is the single source of truth that the parser, the roster engine, and
 * the compliance engine all feed. It is deliberately framework-agnostic (pure
 * TypeScript, no React/DOM imports) so it can be reused in the web app, a
 * future parser API, and any backend.
 */

/** Jurisdiction-aware employment regime. */
export type Jurisdiction = 'mainland' | 'difc' | 'adgm';

/** A shift type, mapped to a desaturated surface variant in the UI. */
export type ShiftType = 'service' | 'kitchen' | 'bar' | 'break' | 'other';

/** Employment status of a staff member. */
export type EmploymentStatus = 'active' | 'inactive';

/** A single staff member. */
export interface Employee {
  id: string;
  /** Display name as parsed (may be a nickname or transliteration). */
  name: string;
  /** Canonical/registered name if known (from the MOHRE contract). */
  legalName?: string;
  role: string;
  status: EmploymentStatus;
  /** Required credentials for the role (e.g. DHA license, guard license). */
  requiredCredentials?: string[];
  /**
   * True when this employee came from an upload row whose role couldn't be
   * resolved (`unmatched_role`) — never persisted to the DB (Shift.roleId is
   * a required FK), shown here purely so the row doesn't silently vanish
   * from the manager's view after confirm. Cleared once the role is fixed
   * and re-imported.
   */
  needsRoleReview?: boolean;
}

/** A single shift assignment for one employee on one day. */
export interface Shift {
  id: string;
  employeeId: string;
  /** ISO date (YYYY-MM-DD) of the shift. */
  date: string;
  /** 24h "HH:MM" start time. */
  start: string;
  /** 24h "HH:MM" end time. */
  end: string;
  type: ShiftType;
  /** True when the shift crosses midnight (end < start). */
  overnight: boolean;
  /**
   * The role/position this shift actually needs, as extracted from the
   * source roster at parse time. Distinct from the assigned employee's own
   * role: after a cover/swap reassignment, the covering employee's role may
   * differ from what the shift requires (e.g. a server covering a
   * bartender shift is still a bartender shift).
   */
  requiredRole?: string;
  /** Raw source text this shift was parsed from (for audit/debug). */
  source?: string;
}

/** A weekly roster: employees + their shifts for a date range. */
export interface Roster {
  id: string;
  venueId: string;
  /** ISO date of the first day of the roster week. */
  weekStart: string;
  employees: Employee[];
  shifts: Shift[];
  /** ISO date the roster was created/parsed. */
  createdAt: string;
}

/** Compliance rule set, data-driven per tenant/industry (not hardcoded). */
export interface ComplianceRules {
  jurisdiction: Jurisdiction;
  /** Maximum normal hours per day. */
  maxDailyHours: number;
  /** Maximum normal hours per week. */
  maxWeeklyHours: number;
  /** Max consecutive hours before a break is required. */
  maxConsecutiveHours: number;
  /** Minimum break length in hours. */
  minBreakHours: number;
  /** Daytime overtime multiplier (e.g. 1.25). */
  daytimeOvertimeMultiplier: number;
  /** Nighttime overtime multiplier (e.g. 1.5). */
  nighttimeOvertimeMultiplier: number;
  /** Night premium window start (24h "HH:MM"). */
  nightWindowStart: string;
  /** Night premium window end (24h "HH:MM"). */
  nightWindowEnd: string;
  /** Max total working hours (incl. overtime) over the rolling window. */
  maxRollingHours: number;
  /** Rolling window length in weeks. */
  rollingWindowWeeks: number;
  /** Required rest days per week. */
  restDaysPerWeek: number;
  /** Rest-day work compensation multiplier (e.g. 1.5). */
  restDayMultiplier: number;
  /** Public-holiday work compensation multiplier (e.g. 1.5). */
  publicHolidayMultiplier: number;
}

/** Per-venue configuration that drives parsing and compliance. */
export interface VenueConfig {
  id: string;
  name: string;
  jurisdiction: Jurisdiction;
  compliance: ComplianceRules;
  /** Known shift-type labels in the venue's language mix. */
  shiftTypeLabels: Record<string, ShiftType>;
  /** Known role labels in the venue's language mix. */
  roleLabels: string[];
  /** Known staff names (used to disambiguate parsing). */
  knownStaff?: string[];
}

export type SwapRequestStatus = 'pending' | 'approved' | 'denied';

/** A cover/swap request against one real shift, made by its current owner. */
export interface SwapRequest {
  id: string;
  shiftId: string;
  /** Employee who currently owns the shift and is requesting cover. */
  requestedBy: string;
  /** Employee proposed to take over the shift. */
  coveringEmployeeId: string;
  status: SwapRequestStatus;
  createdAt: string;
  decidedAt?: string;
  /** ISO datetime the request window closes — drives the countdown timer. */
  expiresAt: string;
  /** True when a different approved request already reassigned this shift out from under this one. */
  locked: boolean;
  /** Human-readable audit line (e.g. "Approved · shift reassigned to Priya"). */
  auditNote?: string;
  /**
   * Display fields resolved server-side, so the Approvals panel can render real
   * names/times without depending on an in-memory roster that is empty on a
   * fresh page load. Optional because cached or locally-constructed requests
   * may predate them; consumers fall back to a roster lookup when absent.
   */
  requesterName?: string;
  coveringName?: string;
  shiftLabel?: string;
}

/** Result of a parse operation. */
export interface ParseResult {
  roster: Roster;
  /** Human-readable warnings (e.g. ambiguous names, unparsed lines). */
  warnings: string[];
  /** Lines that could not be parsed. */
  unparsedLines: string[];
  /** Time taken in milliseconds. */
  durationMs: number;
}

/** Default UAE mainland compliance rules (Federal Decree-Law No. 33 of 2021). */
export const DEFAULT_MAINLAND_RULES: ComplianceRules = {
  jurisdiction: 'mainland',
  maxDailyHours: 8,
  maxWeeklyHours: 48,
  maxConsecutiveHours: 5,
  minBreakHours: 1,
  daytimeOvertimeMultiplier: 1.25,
  nighttimeOvertimeMultiplier: 1.5,
  nightWindowStart: '22:00',
  nightWindowEnd: '04:00',
  maxRollingHours: 144,
  rollingWindowWeeks: 3,
  restDaysPerWeek: 1,
  restDayMultiplier: 1.5,
  publicHolidayMultiplier: 1.5,
};
