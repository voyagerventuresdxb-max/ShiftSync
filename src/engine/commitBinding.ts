/**
 * Pure "Confirm & Commit" state-binding logic, extracted from
 * `src/state/AppStateContext.tsx` so it can be unit-tested directly rather
 * than mirrored by a copy in the test file (which previously drifted out of
 * date once the real logic gained the `persisted` real-id parameter).
 *
 * `AppStateContext` is the only production caller: `handleCommitted` wraps
 * `buildCommitted` and feeds the result to `setCommitted`, and its
 * `mergedRoster` memo wraps `mergeCommitted`.
 */
import type { Employee, Roster, Shift } from './types';
// Type-only import: keeps the engine layer free of any runtime dependency on
// the api layer.
import type { PreviewRow } from '../api/schedules';

/**
 * One row that the server actually wrote to the database, correlated back to
 * the preview row it came from by `rowNumber`.
 *
 * `userId` is null when the row matched a role but not a specific person
 * ("new_employee, imported unassigned").
 */
export interface PersistedRow {
  rowNumber: number;
  shiftId: string;
  userId: string | null;
}

/** The employees + shifts a commit contributes to the roster. */
export interface CommittedState {
  employees: Employee[];
  shifts: Shift[];
}

/**
 * Convert reviewed preview rows into Employee/Shift objects.
 *
 * Rows that were actually persisted carry their real `User.id` / `Shift.id`.
 * Rows that were never written (`unmatched_role`) have no real id, so they
 * keep a synthetic per-name / per-batch fallback id — they still need to
 * render, flagged as unsaved, rather than silently vanish from the manager's
 * view. The synthetic shift id is namespaced by `batchId` so two batches
 * sharing a `rowNumber` cannot collide.
 */
export function buildCommitted(
  rows: PreviewRow[],
  batchId: string,
  persisted: PersistedRow[],
): CommittedState {
  const persistedByRow = new Map(persisted.map((p) => [p.rowNumber, p]));
  const employees: Employee[] = [];
  const shifts: Shift[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const realUserId = persistedByRow.get(row.rowNumber)?.userId ?? null;
    const empId = realUserId ?? `upload-emp-${row.employeeName}`;
    if (!seen.has(empId)) {
      seen.add(empId);
      employees.push({
        id: empId,
        name: row.employeeName,
        role: row.role || 'staff',
        status: 'active',
        needsRoleReview: row.status === 'unmatched_role',
      });
    }
    const realShiftId = persistedByRow.get(row.rowNumber)?.shiftId;
    shifts.push({
      id: realShiftId ?? `upload-shift-${batchId}-${row.rowNumber}`,
      employeeId: empId,
      date: row.date,
      start: row.startTime,
      end: row.endTime,
      type: 'service',
      overnight: row.overnight,
      requiredRole: row.role || undefined,
      source: `Uploaded roster (${row.role || 'role unknown'})`,
    });
  }
  return { employees, shifts };
}

/**
 * Merge committed employees/shifts into a base roster, skipping anything whose
 * id is already present. Returns `base` untouched when nothing was committed,
 * so the caller's memo can keep its previous reference.
 */
export function mergeCommitted(base: Roster, committed: CommittedState): Roster {
  if (committed.employees.length === 0 && committed.shifts.length === 0) {
    return base;
  }
  const employees = [...base.employees];
  const shifts = [...base.shifts];
  for (const emp of committed.employees) {
    if (!employees.some((e) => e.id === emp.id)) employees.push(emp);
  }
  for (const s of committed.shifts) {
    if (!shifts.some((x) => x.id === s.id)) shifts.push(s);
  }
  return { ...base, employees, shifts };
}
