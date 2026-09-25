/**
 * Leave types a manager can mark on the rota builder grid (RotaLeave model).
 * Shared by server (validation, messages) and client (chips) so the two can
 * never disagree on the list, its order or its labels.
 */
export const LEAVE_TYPES = ['DAY_OFF', 'ANNUAL_LEAVE', 'SICK_LEAVE', 'UNPAID_LEAVE', 'HALF_DAY'] as const;

export type LeaveTypeKey = (typeof LEAVE_TYPES)[number];

export const LEAVE_LABELS: Record<LeaveTypeKey, string> = {
  DAY_OFF: 'Day Off',
  ANNUAL_LEAVE: 'Annual Leave',
  SICK_LEAVE: 'Sick Leave',
  UNPAID_LEAVE: 'Unpaid Leave',
  HALF_DAY: 'Half Day',
};

/** HALF_DAY may share a day with a shift; every other leave type means that person is not working that day. */
export function leaveBlocksShift(type: LeaveTypeKey): boolean {
  return type !== 'HALF_DAY';
}
