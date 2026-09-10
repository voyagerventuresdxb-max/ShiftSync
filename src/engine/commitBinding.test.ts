/**
 * Tests for the "Confirm & Commit" state-binding logic.
 *
 * Verifies that the reviewed shift rows flushed from the upload preview
 * (via `onCommitted`) are converted into Employee/Shift objects and merged
 * into the main roster state so the grid and weekly totals populate.
 *
 * These exercise the REAL functions (`buildCommitted` / `mergeCommitted` in
 * `./commitBinding`) that `src/state/AppStateContext.tsx` calls from
 * `handleCommitted` and its `mergedRoster` memo — not a local copy. An earlier
 * version of this file mirrored the logic privately and silently went stale
 * when the real code gained the `persisted` real-id parameter.
 *
 * `src/components/ShiftUpload.tsx` decides what gets flushed:
 * `onCommitted?.(data.preview.filter((r) => r.status === 'matched' || r.status === 'unmatched_role'))`.
 * `unmatched_role` rows ARE flushed (not persisted server-side, but shown
 * flagged so they don't silently vanish from the manager's view) — see the
 * "needsRoleReview" tests below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Roster } from './types';
import type { PreviewRow } from '../api/schedules';
import { shiftHours } from './time';
import { buildCommitted, mergeCommitted, type PersistedRow } from './commitBinding';

/**
 * Server response for rows that really were written to the DB. Mirrors what
 * `persistShifts` returns, correlated by `rowNumber`.
 */
function persistedFor(rows: PreviewRow[]): PersistedRow[] {
  return rows
    .filter((r) => r.status === 'matched')
    .map((r) => ({
      rowNumber: r.rowNumber,
      shiftId: `db-shift-${r.rowNumber}`,
      userId: `db-user-${r.employeeName}`,
    }));
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

  const committed = buildCommitted(committedRows, 'batch-1', persistedFor(committedRows));
  assert.equal(committed.employees.length, 8, '8 unique staff members');
  assert.equal(committed.shifts.length, 116, '116 shifts flushed');

  // Every row here was persisted, so every id must be the REAL database id —
  // the synthetic `upload-` fallback must not appear at all.
  assert.ok(
    committed.employees.every((e) => e.id.startsWith('db-user-')),
    'persisted rows use real User ids, not synthetic upload-emp- ids',
  );
  assert.ok(
    committed.shifts.every((s) => s.id.startsWith('db-shift-')),
    'persisted rows use real Shift ids, not synthetic upload-shift- ids',
  );

  // Base roster (empty text parse) + committed -> merged roster.
  const base: Roster = {
    id: 'roster-base',
    venueId: 'venue-1',
    weekStart: '2026-08-17',
    employees: [],
    shifts: [],
    createdAt: new Date().toISOString(),
  };
  const merged = mergeCommitted(base, committed);

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

  // The unmatched_role row is NOT persisted, so it is absent from `persisted`
  // and must fall back to synthetic ids while every other row gets real ones.
  const committed = buildCommitted(committedRows, 'batch-1', persistedFor(committedRows));
  assert.equal(committed.shifts.length, 116, 'all 116 shifts present, including the unresolved one');

  const unsavedShift = committed.shifts.find((s) => s.id === 'upload-shift-batch-1-1');
  assert.ok(unsavedShift, 'the unpersisted row keeps the synthetic shift id fallback');
  assert.equal(unsavedShift!.employeeId, 'upload-emp-Alessandro', 'and the synthetic employee id fallback');

  const savedShifts = committed.shifts.filter((s) => s.id !== 'upload-shift-batch-1-1');
  assert.ok(
    savedShifts.every((s) => s.id.startsWith('db-shift-')),
    'every persisted row still uses its real Shift id',
  );

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

  // Neither batch was persisted (empty `persisted`), so both fall back to the
  // synthetic ids — exactly the path where the collision bug lived.
  const committedA = buildCommitted(batchARows, 'batch-aaa', []);
  const committedB = buildCommitted(batchBRows, 'batch-bbb', []);

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
  const afterA = mergeCommitted(base, committedA);
  const afterB = mergeCommitted(afterA, committedB);

  assert.equal(afterB.employees.length, 2, 'both Person A and Person B present');
  assert.equal(afterB.shifts.length, 2, 'both shifts present -- neither silently dropped');
  assert.ok(afterB.shifts.some((s) => s.employeeId === 'upload-emp-Person A'));
  assert.ok(afterB.shifts.some((s) => s.employeeId === 'upload-emp-Person B'));
});

test('committed shifts merge into an existing text-parsed roster without duplication', () => {
  const preview = build116ShiftPreview();
  const matched = preview.filter((r) => r.status === 'matched');
  const committed = buildCommitted(matched, 'batch-1', persistedFor(matched));

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

  const merged = mergeCommitted(base, committed);
  // Maria exists in both base (emp-1) and committed (db-user-Maria) — both
  // are distinct ids, so both rows appear (no id collision). Shifts: base 1 +
  // committed 116 = 117, no dedup collision because ids differ.
  assert.equal(merged.employees.length, 9);
  assert.equal(merged.shifts.length, 117);
});
