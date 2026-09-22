import type { Roster, Shift } from './types';
import { shiftHours } from './time';

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Resolve an ISO date (YYYY-MM-DD) to its weekday label (Mon..Sun). */
export function weekdayOf(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return WEEKDAY_LABELS[new Date(y, m - 1, d).getDay()];
}

/** Extract the AM/PM period label from a shift's source (e.g. "[AM]"). */
export function periodOf(shift: Shift): string {
  const m = shift.source?.match(/\[(AM|PM)\]/i);
  return m ? m[1].toUpperCase() : '';
}

/** The 7 consecutive ISO dates of a roster week, starting at weekStart. */
export function weekDates(weekStart: string): string[] {
  const [y, m, d] = weekStart.split('-').map(Number);
  const start = new Date(y, m - 1, d);
  return Array.from({ length: 7 }, (_, i) => {
    const dt = new Date(start);
    dt.setDate(start.getDate() + i);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  });
}

/** All shifts for one employee, sorted by date. */
export function shiftsFor(roster: Roster, employeeId: string): Shift[] {
  return roster.shifts
    .filter((s) => s.employeeId === employeeId)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Total scheduled hours across a set of shifts. */
export function totalHours(shifts: Shift[]): number {
  return shifts.reduce((sum, s) => sum + shiftHours(s.start, s.end), 0);
}

/**
 * Which employee the Personal Rota shows. An explicit "Viewing" selection
 * always wins. With none, a STAFF session lands on its own rota when it is
 * on this week's roster; a MANAGER/OWNER (whose use of this view is a team
 * review) and any session not on the roster get the first entry.
 */
export function pickViewedEmployee<E extends { id: string }>(
  employees: E[],
  currentEmployeeId: string | undefined,
  sessionUser: { id: string; systemRole: 'OWNER' | 'MANAGER' | 'STAFF' } | null,
): E | undefined {
  const selected = employees.find((e) => e.id === currentEmployeeId);
  if (selected) return selected;
  if (sessionUser?.systemRole === 'STAFF') {
    const self = employees.find((e) => e.id === sessionUser.id);
    if (self) return self;
  }
  return employees[0];
}
