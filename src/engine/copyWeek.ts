/**
 * "Copy last week" for the rota builder: turns the previous week's shifts
 * into bulk-create rows for the target week (same weekday, same times, same
 * role and person). Pure so it is unit-testable; the builder sends the rows
 * through the existing POST /api/shifts/bulk (all rows land as DRAFT).
 *
 * Deliberately NOT copied: leave (it is date-specific — last week's sick day
 * says nothing about this week), briefing notes and sidework (per-day
 * directives). Rows that can't be placed are skipped and counted rather than
 * failing the whole copy:
 *  - the person is on a blocking leave that day in the target week (the
 *    server would 409 the entire batch for one such row);
 *  - the person is no longer an active staff member at the venue;
 *  - an identical shift (person, day, role, start, end) already exists in
 *    the target week — so pressing the button twice doesn't double the rota.
 */
export interface CopySourceShift {
  employeeId: string | null;
  roleId: string;
  date: string;
  start: string;
  end: string;
  breakMinutes: number;
}

export interface CopyRow {
  roleId: string;
  userId: string | null;
  date: string;
  start: string;
  end: string;
  breakMinutes: number;
}

export interface CopyPlan {
  rows: CopyRow[];
  skippedLeave: number;
  skippedInactive: number;
  skippedDuplicate: number;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const keyOf = (r: { userId: string | null; date: string; roleId: string; start: string; end: string }) =>
  `${r.userId ?? 'open'}|${r.date}|${r.roleId}|${r.start}|${r.end}`;

export function planCopyWeek(input: {
  previousWeekShifts: CopySourceShift[];
  /** Shifts already in the target week, as rows (for de-duplication). */
  targetWeekShifts: { userId: string | null; date: string; roleId: string; start: string; end: string }[];
  /** `${userId}|${date}` for every blocking leave in the target week. */
  blockingLeaveKeys: Set<string>;
  activeUserIds: Set<string>;
}): CopyPlan {
  const existing = new Set(input.targetWeekShifts.map(keyOf));
  const plan: CopyPlan = { rows: [], skippedLeave: 0, skippedInactive: 0, skippedDuplicate: 0 };
  for (const s of input.previousWeekShifts) {
    const row: CopyRow = {
      roleId: s.roleId,
      userId: s.employeeId,
      date: addDays(s.date, 7),
      start: s.start,
      end: s.end,
      breakMinutes: s.breakMinutes,
    };
    if (row.userId && !input.activeUserIds.has(row.userId)) {
      plan.skippedInactive += 1;
      continue;
    }
    if (row.userId && input.blockingLeaveKeys.has(`${row.userId}|${row.date}`)) {
      plan.skippedLeave += 1;
      continue;
    }
    const key = keyOf(row);
    if (existing.has(key)) {
      plan.skippedDuplicate += 1;
      continue;
    }
    existing.add(key);
    plan.rows.push(row);
  }
  return plan;
}
