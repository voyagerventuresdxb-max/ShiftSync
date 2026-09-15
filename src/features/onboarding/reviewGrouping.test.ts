import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupByPerson, shouldAdvanceAfterConfirm } from './reviewGrouping';
import type { PreviewRow } from '../../api/schedules';

function row(overrides: Partial<PreviewRow>): PreviewRow {
  return {
    rowNumber: 1,
    employeeName: 'Ahmed Ali',
    role: 'Waiter',
    date: '2026-09-14',
    startTime: '09:00',
    endTime: '17:00',
    overnight: false,
    breakMinutes: 0,
    managerNotes: null,
    status: 'matched',
    issues: [],
    ...overrides,
  };
}

test('groupByPerson keeps two different employees who share a name as separate PersonRows when the parser provides sourceRowIndex (regression: same-name merge silently combined different staff)', () => {
  const preview: PreviewRow[] = [
    row({ rowNumber: 1, sourceRowIndex: 0, employeeName: 'Ahmed Ali', role: 'Runner', date: '2026-09-14' }),
    row({ rowNumber: 2, sourceRowIndex: 1, employeeName: 'Ahmed Ali', role: 'Waiter', date: '2026-09-15' }),
  ];

  const people = groupByPerson(preview);

  assert.equal(people.length, 2, 'two different physical roster rows must produce two separate PersonRows, even with an identical name');
  const runner = people.find((p) => p.originalRole === 'Runner');
  const waiter = people.find((p) => p.originalRole === 'Waiter');
  assert.ok(runner, 'the Runner-role Ahmed Ali must be present as its own row');
  assert.ok(waiter, 'the Waiter-role Ahmed Ali must be present as its own row');
  assert.deepEqual(runner!.rowNumbers, [1], 'the Runner row must not have absorbed the Waiter row-number');
  assert.deepEqual(waiter!.rowNumbers, [2], 'the Waiter row must not have absorbed the Runner row-number');
});

test('groupByPerson still merges multiple shifts belonging to the SAME physical employee (same sourceRowIndex) into one PersonRow', () => {
  const preview: PreviewRow[] = [
    row({ rowNumber: 5, sourceRowIndex: 3, employeeName: 'Layla H.', date: '2026-09-14' }),
    row({ rowNumber: 6, sourceRowIndex: 3, employeeName: 'Layla H.', date: '2026-09-15' }),
    row({ rowNumber: 7, sourceRowIndex: 3, employeeName: 'Layla H.', date: '2026-09-16' }),
  ];

  const people = groupByPerson(preview);

  assert.equal(people.length, 1, 'one employee\'s own multiple shifts must still collapse into a single PersonRow');
  assert.deepEqual(people[0]!.rowNumbers, [5, 6, 7]);
});

test('groupByPerson falls back to name-only grouping when sourceRowIndex is absent (free-text uploads, which have no per-employee row structure)', () => {
  const preview: PreviewRow[] = [
    row({ rowNumber: 1, sourceRowIndex: undefined, employeeName: 'Maria', date: '2026-09-14' }),
    row({ rowNumber: 2, sourceRowIndex: undefined, employeeName: 'Maria', date: '2026-09-15' }),
  ];

  const people = groupByPerson(preview);

  assert.equal(people.length, 1, 'without a sourceRowIndex, same-name rows must still merge the way the free-text path always relied on');
  assert.deepEqual(people[0]!.rowNumbers, [1, 2]);
});

test('shouldAdvanceAfterConfirm is false when any shift was skipped (regression: onContinue() used to fire unconditionally, hiding a silent shift drop)', () => {
  assert.equal(shouldAdvanceAfterConfirm({ skippedCount: 0 }), true);
  assert.equal(shouldAdvanceAfterConfirm({ skippedCount: 1 }), false);
  assert.equal(shouldAdvanceAfterConfirm({ skippedCount: 3 }), false);
});
