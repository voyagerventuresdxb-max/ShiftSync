import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCopyWeek, type CopySourceShift } from './copyWeek';

const shift = (over: Partial<CopySourceShift> = {}): CopySourceShift => ({
  employeeId: 'sara',
  roleId: 'bar',
  date: '2026-09-22',
  start: '17:00',
  end: '23:00',
  breakMinutes: 30,
  ...over,
});

const base = { targetWeekShifts: [], blockingLeaveKeys: new Set<string>(), activeUserIds: new Set(['sara', 'omar']) };

test('copies each shift to the same weekday next week, keeping person, role, times and break', () => {
  const plan = planCopyWeek({ ...base, previousWeekShifts: [shift(), shift({ employeeId: null, date: '2026-09-27', start: '10:00', end: '16:00' })] });
  assert.deepEqual(plan.rows, [
    { roleId: 'bar', userId: 'sara', date: '2026-09-29', start: '17:00', end: '23:00', breakMinutes: 30 },
    { roleId: 'bar', userId: null, date: '2026-10-04', start: '10:00', end: '16:00', breakMinutes: 30 },
  ]);
  assert.equal(plan.skippedLeave + plan.skippedInactive + plan.skippedDuplicate, 0);
});

test('skips a person on blocking leave that day in the target week', () => {
  const plan = planCopyWeek({ ...base, blockingLeaveKeys: new Set(['sara|2026-09-29']), previousWeekShifts: [shift(), shift({ employeeId: 'omar' })] });
  assert.deepEqual(plan.rows.map((r) => r.userId), ['omar']);
  assert.equal(plan.skippedLeave, 1);
});

test('skips people who are no longer active staff', () => {
  const plan = planCopyWeek({ ...base, previousWeekShifts: [shift({ employeeId: 'left-the-venue' })] });
  assert.equal(plan.rows.length, 0);
  assert.equal(plan.skippedInactive, 1);
});

test('running it twice does not double the week: target shifts already there are skipped, one for one', () => {
  const first = planCopyWeek({ ...base, previousWeekShifts: [shift()] });
  assert.equal(first.rows.length, 1);
  const second = planCopyWeek({ ...base, targetWeekShifts: first.rows, previousWeekShifts: [shift()] });
  assert.equal(second.rows.length, 0);
  assert.equal(second.skippedDuplicate, 1);
});

test('identical slots in the source are all copied (two open Bartender 17–23 slots stay two)', () => {
  const open = shift({ employeeId: null });
  const plan = planCopyWeek({ ...base, previousWeekShifts: [open, open] });
  assert.equal(plan.rows.length, 2);
  // …and with one already in the target week, only the missing one is added.
  const again = planCopyWeek({ ...base, targetWeekShifts: [plan.rows[0]!], previousWeekShifts: [open, open] });
  assert.equal(again.rows.length, 1);
  assert.equal(again.skippedDuplicate, 1);
});

test('crosses month and year boundaries correctly', () => {
  const plan = planCopyWeek({ ...base, previousWeekShifts: [shift({ date: '2026-12-28' })] });
  assert.equal(plan.rows[0]!.date, '2027-01-04');
});
