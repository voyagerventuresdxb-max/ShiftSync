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
 *    Matched by COUNT, not presence: two identical open Bartender slots last
 *    week become two this week (minus any identical ones already there);
 *  - the person already has a different shift overlapping those times in the
 *    target week (the server refuses the whole batch for one such row). Both
 *    segments of a split shift copy, since they don't overlap each other.
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
  skippedOverlap: number;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const keyOf = (r: { userId: string | null; date: string; roleId: string; start: string; end: string }) =>
  `${r.userId ?? 'open'}|${r.date}|${r.roleId}|${r.start}|${r.end}`;

/** [start, end) in wall-clock minutes since the epoch; an end at or before the start is the next day, as the server stores it. */
function spanOf(r: { date: string; start: string; end: string }): [number, number] {
  const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const day = Date.parse(`${r.date}T00:00:00.000Z`) / 60_000;
  return [day + minutes(r.start), day + minutes(r.end) + (r.end <= r.start ? 1440 : 0)];
}

const overlaps = (a: { date: string; start: string; end: string }, b: { date: string; start: string; end: string }) => {
  const [as, ae] = spanOf(a);
  const [bs, be] = spanOf(b);
  return as < be && bs < ae;
};

export function planCopyWeek(input: {
  previousWeekShifts: CopySourceShift[];
  /** Shifts already in the target week, as rows (for de-duplication). */
  targetWeekShifts: { userId: string | null; date: string; roleId: string; start: string; end: string }[];
  /** `${userId}|${date}` for every blocking leave in the target week. */
  blockingLeaveKeys: Set<string>;
  activeUserIds: Set<string>;
}): CopyPlan {
  // How many identical shifts the target week already has, per key; each one
  // absorbs one matching source row.
  const alreadyThere = new Map<string, number>();
  for (const t of input.targetWeekShifts) alreadyThere.set(keyOf(t), (alreadyThere.get(keyOf(t)) ?? 0) + 1);
  const plan: CopyPlan = { rows: [], skippedLeave: 0, skippedInactive: 0, skippedDuplicate: 0, skippedOverlap: 0 };
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
    const remaining = alreadyThere.get(key) ?? 0;
    if (remaining > 0) {
      alreadyThere.set(key, remaining - 1);
      plan.skippedDuplicate += 1;
      continue;
    }
    if (row.userId && [...input.targetWeekShifts, ...plan.rows].some((t) => t.userId === row.userId && overlaps(t, row))) {
      plan.skippedOverlap += 1;
      continue;
    }
    plan.rows.push(row);
  }
  return plan;
}
