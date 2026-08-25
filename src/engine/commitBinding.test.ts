/**
 * Smoke test for the "Confirm & Commit" state-binding logic.
 *
 * Verifies that the reviewed shift rows flushed from the upload preview
 * (via `onCommitted`) are converted into Employee/Shift objects and merged
 * into the main roster state so the grid and weekly totals populate.
 *
 * This mirrors the exact conversion + merge logic in `src/App.tsx`
 * (`handleCommitted` + `mergedRoster`) and `src/components/ShiftUpload.tsx`
 * (`onCommitted?.(data.preview.filter((r) => r.status === 'matched' || r.status === 'unmatched_role'))`).
 * `unmatched_role` rows ARE flushed (not persisted server-side, but shown
 * flagged so they don't silently vanish from the manager's view) — see the
 * "needsRoleReview" tests below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Employee, Roster, Shift } from './types';
import type { PreviewRow } from '../api/schedules';
import { shiftHours } from './time';

/** Mirrors App.tsx handleCommitted: (PreviewRow[], batchId) -> { employees, shifts }. */
function toCommitted(rows: PreviewRow[], batchId: string): { employees: Employee[]; shifts: Shift[] } {
  const employees: Employee[] = [];
  const shifts: Shift[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const empId = `upload-emp-${row.employeeName}`;
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
    shifts.push({
      // Namespaced by batchId so two batches sharing a rowNumber don't collide.
      id: `upload-shift-${batchId}-${row.rowNumber}`,
      employeeId: empId,
      date: row.date,
      start: row.startTime,
      end: row.endTime,
      type: 'service',
      overnight: row.overnight,
      source: `Uploaded roster (${row.role || 'role unknown'})`,
    });
  }
  return { employees, shifts };
}

/** Mirrors App.tsx mergedRoster: base roster + committed -> merged Roster. */
function mergeRoster(base: Roster, committed: { employees: Employee[]; shifts: Shift[] }): Roster {
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

/** Build a realistic 116-shift preview payload across a 7-day week. */
function build116ShiftPreview(): PreviewRow[] {
  const staff = [
    { name: 'Alessandro', role: 'Management' },
    { name: 'Pratik', role: 'Supervisor' },
    { name: 'Roberto', role: 'Management' },
    { name: 'Maria', role: 'Waiter' },
    { name: 'Jose', role: 'Waiter' },
    { name: 'Ahmed', role: 'Chef' },
    { name: 'Priya', role: 'Host' },
    { name: 'Derrick', role: 'Runner' },
  ];
  const days = ['2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21', '2026-08-22', '2026-08-23'];
  const rows: PreviewRow[] = [];
  let rowNumber = 1;
  // ~2 shifts per staff per day => 8 * 7 * 2 = 112; add 4 more for 116.
  for (const day of days) {
    for (const s of staff) {
      rows.push({
        rowNumber: rowNumber++,
        employeeName: s.name,
        role: s.role,
        date: day,
        startTime: '09:00',
        endTime: '17:00',
        overnight: false,
        breakMinutes: 30,
        managerNotes: null,
        status: 'matched',
        issues: [],
      });
      rows.push({
        rowNumber: rowNumber++,
        employeeName: s.name,
        role: s.role,
        date: day,
        startTime: '17:00',
        endTime: '01:00',
        overnight: true,
        breakMinutes: 30,
        managerNotes: null,
        status: 'matched',
        issues: [],
      });
    }
  }
  // Pad to exactly 116 matched rows.
  while (rows.length < 116) {
    rows.push({
      rowNumber: rowNumber++,
      employeeName: 'Maria',
      role: 'Waiter',
      date: '2026-08-23',
      startTime: '12:00',
      endTime: '20:00',
      overnight: false,
      breakMinutes: 30,
      managerNotes: null,
      status: 'matched',
      issues: [],
    });
  }
  return rows;
}

test('Confirm & Commit flushes matched preview rows into the roster state', () => {
  const preview = build116ShiftPreview();
  assert.equal(preview.length, 116, 'preview should have 116 rows');

  // Simulate ShiftUpload.onConfirm: matched + unmatched_role rows are flushed
  // (unmatched_role ones just arrive flagged, not silently dropped).
  const committedRows = preview.filter((r) => r.status === 'matched' || r.status === 'unmatched_role');
  assert.equal(committedRows.length, 116);

  const committed = toCommitted(committedRows, 'batch-1');
  assert.equal(committed.employees.length, 8, '8 unique staff members');
  assert.equal(committed.shifts.length, 116, '116 shifts flushed');

  // Base roster (empty text parse) + committed -> merged roster.
  const base: Roster = {
    id: 'roster-base',
    venueId: 'venue-1',
    weekStart: '2026-08-17',
    employees: [],
    shifts: [],
    createdAt: new Date().toISOString(),
  };
  const merged = mergeRoster(base, committed);

  // The grid renders mergedRoster.employees / mergedRoster.shifts.
  assert.equal(merged.employees.length, 8);
  assert.equal(merged.shifts.length, 116);

  // Every committed shift is present in the merged roster.
  for (const s of committed.shifts) {
    assert.ok(merged.shifts.some((x) => x.id === s.id), `shift ${s.id} present`);
  }

  // Weekly totals compute from the merged shifts (grid "Hours" column).
  const totalHours = merged.shifts.reduce((sum, s) => sum + shiftHours(s.start, s.end), 0);
  assert.ok(totalHours > 0, 'weekly totals are non-zero');
});

test('unmatched-role rows ARE flushed, flagged needsRoleReview, not silently dropped', () => {
  const preview = build116ShiftPreview();
  // Mark one row (Alessandro's first shift) as unmatched_role.
  preview[0] = { ...preview[0], status: 'unmatched_role' };
  const committedRows = preview.filter((r) => r.status === 'matched' || r.status === 'unmatched_role');
  assert.equal(committedRows.length, 116, 'the unmatched row is still flushed, not excluded');

  const committed = toCommitted(committedRows, 'batch-1');
  assert.equal(committed.shifts.length, 116, 'all 116 shifts present, including the unresolved one');

  const flagged = committed.employees.find((e) => e.name === 'Alessandro');
  assert.ok(flagged, 'Alessandro is present');
  assert.equal(flagged!.needsRoleReview, true, 'Alessandro is flagged for review');

  const others = committed.employees.filter((e) => e.name !== 'Alessandro');
  assert.ok(
    others.every((e) => !e.needsRoleReview),
    'no other employee is incorrectly flagged',
  );
});

test('two separate upload batches with overlapping rowNumbers do not collide (regression: shift-id collision bug)', () => {
  // Both batches independently number their rows starting at 1 -- exactly
  // the scenario that silently dropped a shift before batchId was folded
  // into the id.
  const batchARows: PreviewRow[] = [
    {
      rowNumber: 1,
      employeeName: 'Person A',
      role: 'Waiter',
      date: '2026-08-17',
      startTime: '09:00',
      endTime: '17:00',
      overnight: false,
      breakMinutes: 30,
      managerNotes: null,
      status: 'matched',
      issues: [],
    },
  ];
  const batchBRows: PreviewRow[] = [
    {
      rowNumber: 1,
      employeeName: 'Person B',
      role: 'Runner',
      date: '2026-08-18',
      startTime: '10:00',
      endTime: '18:00',
      overnight: false,
      breakMinutes: 30,
      managerNotes: null,
      status: 'matched',
      issues: [],
    },
  ];

  const committedA = toCommitted(batchARows, 'batch-aaa');
  const committedB = toCommitted(batchBRows, 'batch-bbb');

  assert.notEqual(
    committedA.shifts[0].id,
    committedB.shifts[0].id,
    'same rowNumber (1) in two different batches must produce different shift ids',
  );

  const base: Roster = {
    id: 'roster-base',
    venueId: 'venue-1',
    weekStart: '2026-08-17',
    employees: [],
    shifts: [],
    createdAt: new Date().toISOString(),
  };
  const afterA = mergeRoster(base, committedA);
  const afterB = mergeRoster(afterA, committedB);

  assert.equal(afterB.employees.length, 2, 'both Person A and Person B present');
  assert.equal(afterB.shifts.length, 2, 'both shifts present -- neither silently dropped');
  assert.ok(afterB.shifts.some((s) => s.employeeId === 'upload-emp-Person A'));
  assert.ok(afterB.shifts.some((s) => s.employeeId === 'upload-emp-Person B'));
});

test('committed shifts merge into an existing text-parsed roster without duplication', () => {
  const preview = build116ShiftPreview();
  const committed = toCommitted(preview.filter((r) => r.status === 'matched'), 'batch-1');

  // Base roster already has one employee + one shift from the text parser.
  const base: Roster = {
    id: 'roster-base',
    venueId: 'venue-1',
    weekStart: '2026-08-17',
    employees: [{ id: 'emp-1', name: 'Maria', role: 'Waiter', status: 'active' }],
    shifts: [
      { id: 'shift-1', employeeId: 'emp-1', date: '2026-08-17', start: '09:00', end: '17:00', type: 'service', overnight: false },
    ],
    createdAt: new Date().toISOString(),
  };

  const merged = mergeRoster(base, committed);
  // Maria exists in both base (emp-1) and committed (upload-emp-Maria) — both
  // are distinct ids, so both rows appear (no id collision). Shifts: base 1 +
  // committed 116 = 117, no dedup collision because ids differ.
  assert.equal(merged.employees.length, 9);
  assert.equal(merged.shifts.length, 117);
});
