import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bulkSummary, copyCells, dayOffsOfWeek, entriesOfWeek, moveOps, placeOps, planBulk, planCopy, planPaste, roleForDepartment } from './rotaPlans.ts';
import { cellOf, indexWeek } from './rotaGrid.ts';
import { DAYS, WEEK, leave, person, shift, timeOff, week } from './rotaFixture.ts';
import { addDays, type WeekPatchOp } from '../../shared/rotaWeek.ts';

const strip = (ops: WeekPatchOp[]) => ops.map((o) => (o.op === 'create' ? { ...o, tempId: undefined } : o));
const today = DAYS[0]!;

test('placing a type: create on an empty cell, update on a filled one, clear a manager status first', () => {
  const w = week({ shifts: [shift('s1', 'a', DAYS[1]!)], leaves: [leave('b', DAYS[1]!, 'SICK_LEAVE')] });
  const idx = indexWeek(w);
  assert.deepEqual(strip(placeOps(w, cellOf(idx, DAYS[0]!, 'a'), { kind: 'type', shiftTypeId: 'evening' }, { today }).ops), [
    { op: 'create', tempId: undefined, userId: 'a', date: DAYS[0], departmentId: 'floor', shiftTypeId: 'evening' },
  ]);
  assert.deepEqual(placeOps(w, cellOf(idx, DAYS[1]!, 'a'), { kind: 'type', shiftTypeId: 'evening' }, { today }).ops, [{ op: 'update', shiftId: 's1', shiftTypeId: 'evening' }]);
  assert.deepEqual(placeOps(w, cellOf(idx, DAYS[1]!, 'a'), { kind: 'type', shiftTypeId: 'morning' }, { today }).ops, [], 'same type is a no-op');
  assert.deepEqual(
    strip(placeOps(w, cellOf(idx, DAYS[1]!, 'b'), { kind: 'type', shiftTypeId: 'morning' }, { today }).ops).map((o) => o.op),
    ['clearLeave', 'create'],
  );
});

test('placing a status over a shift deletes the shift first (the server refuses leave over a shift)', () => {
  const w = week({ shifts: [shift('s1', 'a', DAYS[2]!)] });
  assert.deepEqual(placeOps(w, cellOf(indexWeek(w), DAYS[2]!, 'a'), { kind: 'leave', type: 'DAY_OFF' }, { today }).ops, [
    { op: 'delete', shiftId: 's1' },
    { op: 'setLeave', userId: 'a', date: DAYS[2], type: 'DAY_OFF' },
  ]);
});

test('placing skips approved leave, past days, pending requests (unless confirmed) and people with no role', () => {
  const w = week({
    leaves: [leave('a', DAYS[3]!, 'ANNUAL_LEAVE', true)],
    requests: [timeOff('r1', 'b', [DAYS[3]!])],
    people: [person('a', 'Person A'), person('b', 'Person B'), person('n', 'Person N', 'floor', { roleId: null })],
  });
  const idx = indexWeek(w);
  const t = { kind: 'type' as const, shiftTypeId: 'morning' };
  assert.equal(placeOps(w, cellOf(idx, DAYS[3]!, 'a'), t, { today }).skip, 'leave');
  assert.equal(placeOps(w, cellOf(idx, DAYS[3]!, 'a'), { kind: 'clear' }, { today }).skip, 'leave');
  assert.equal(placeOps(w, cellOf(idx, DAYS[0]!, 'a'), t, { today: DAYS[1]! }).skip, 'past');
  assert.equal(placeOps(w, cellOf(idx, DAYS[3]!, 'b'), t, { today }).skip, 'request');
  assert.equal(placeOps(w, cellOf(idx, DAYS[3]!, 'b'), t, { today, allowPending: true }).ops.length, 1);
  assert.equal(placeOps(w, cellOf(idx, DAYS[3]!, 'n'), t, { today }).skip, 'noRole');
});

test('moving a chip onto someone else replaces what they had and files it under their department', () => {
  const mover = shift('s1', 'a', DAYS[1]!);
  const w = week({ shifts: [mover, shift('s2', 'c', DAYS[2]!)], leaves: [leave('c', DAYS[3]!, 'DAY_OFF')] });
  const idx = indexWeek(w);
  assert.deepEqual(moveOps(w, idx, mover, { date: DAYS[2]!, userId: 'c' }, false), [
    { op: 'delete', shiftId: 's2' },
    { op: 'update', shiftId: 's1', userId: 'c', date: DAYS[2], roleId: 'role-bar', departmentId: 'bar' },
  ]);
  assert.deepEqual(moveOps(w, idx, mover, { date: DAYS[3]!, userId: 'c' }, false).map((o) => o.op), ['clearLeave', 'update']);
  assert.deepEqual(moveOps(w, idx, mover, { date: DAYS[1]!, userId: null }, false), [{ op: 'update', shiftId: 's1', userId: null }]);
  const copy = moveOps(w, idx, mover, { date: DAYS[4]!, userId: 'a' }, true);
  assert.equal(copy.length, 1);
  assert.equal(copy[0]!.op, 'create');
});

test('bulk apply reports applied and skipped cells in one summary', () => {
  const w = week({ leaves: [leave('a', DAYS[3]!, 'ANNUAL_LEAVE', true)] });
  const cells = [DAYS[1]!, DAYS[2]!, DAYS[3]!].map((date) => ({ date, userId: 'a' as string | null }));
  const plan = planBulk(w, [...cells, { date: DAYS[3]!, userId: null }], { kind: 'type', shiftTypeId: 'morning' }, today);
  assert.equal(plan.ops.length, 2);
  assert.equal(bulkSummary(plan), 'Applied to 2 of 4 · 1 on leave skipped · 1 in the open row skipped');
  const clear = planBulk(week({ shifts: [shift('o1', null, DAYS[1]!)] }), [{ date: DAYS[1]!, userId: null }], { kind: 'clear' }, today);
  assert.deepEqual(clear.ops, [{ op: 'delete', shiftId: 'o1' }]);
});

test('copy and paste cells keep their shape relative to the anchor', () => {
  const w = week({ shifts: [shift('s1', 'a', DAYS[1]!), shift('s2', 'b', DAYS[2]!, { shiftTypeId: 'evening', ranges: [{ start: '16:00', end: '01:00' }] })] });
  const rows = ['a', 'b', 'c'];
  const clip = copyCells(w, [{ date: DAYS[1]!, userId: 'a' }, { date: DAYS[2]!, userId: 'b' }], rows);
  assert.deepEqual(
    clip.map((c) => [c.rowOffset, c.dayOffset, c.content.kind]),
    [
      [0, 0, 'custom'],
      [1, 1, 'custom'],
    ],
  );
  const plan = planPaste(w, clip, { row: 1, day: 4 }, rows, today);
  assert.equal(plan.applied, 2);
  assert.deepEqual(
    strip(plan.ops).map((o) => (o.op === 'create' ? [o.userId, o.date, o.shiftTypeId] : o.op)),
    [
      ['b', DAYS[4], 'morning'],
      ['c', DAYS[5], 'evening'],
    ],
  );
});

test('copy last week: weekday to weekday, leave and leavers become open shifts, fill keeps what is there', () => {
  const lastWeek = addDays(WEEK, -7);
  const source = week({
    weekStart: lastWeek,
    shifts: [
      shift('p1', 'a', addDays(lastWeek, 0)),
      shift('p2', 'a', addDays(lastWeek, 2)),
      shift('p3', 'b', addDays(lastWeek, 1)),
      shift('p4', 'gone', addDays(lastWeek, 3)),
      shift('p5', null, addDays(lastWeek, 5)),
    ],
    leaves: [leave('c', addDays(lastWeek, 4), 'DAY_OFF'), leave('c', addDays(lastWeek, 6), 'ANNUAL_LEAVE', true)],
  });
  const target = week({
    people: [person('a', 'Person A'), person('b', 'Person B'), person('c', 'Person C', 'bar'), person('gone', 'Person Gone', 'floor', { isActive: false })],
    shifts: [shift('t1', 'b', DAYS[1]!)],
    leaves: [leave('a', DAYS[2]!, 'ANNUAL_LEAVE', true)],
  });
  const plan = planCopy({ target, entries: entriesOfWeek(source), dayOffs: dayOffsOfWeek(source), mode: 'fill', today, missingPerson: 'open' });
  assert.equal(plan.keptExisting, 1, "Person B's Tuesday is already filled");
  assert.deepEqual(
    plan.attention.map((a) => [a.userId, a.reason, a.count]),
    [
      ['a', 'leave', 1],
      ['gone', 'inactive', 1],
    ],
  );
  assert.equal(plan.dayOffs, 1, 'only the manager-set Day off is copied');
  const creates = strip(plan.ops).filter((o) => o.op === 'create');
  assert.deepEqual(
    creates.map((o) => (o.op === 'create' ? [o.userId, o.date] : null)),
    [
      ['a', DAYS[0]],
      [null, DAYS[2]],
      [null, DAYS[3]],
      [null, DAYS[5]],
    ],
  );
  assert.equal(plan.created, 4);

  const replace = planCopy({ target, entries: entriesOfWeek(source), mode: 'replace', today, missingPerson: 'open' });
  assert.equal(replace.overwritten, 1);
  assert.deepEqual(replace.ops[0], { op: 'delete', shiftId: 't1' });
  assert.equal(replace.keptExisting, 0);
});

test('templates drop leavers, honour a department filter and never write past days', () => {
  const target = week({ people: [person('a', 'Person A'), person('c', 'Person C', 'bar')] });
  const entries = [
    { dayOffset: 0, userId: 'a', roleId: 'role-floor', departmentId: 'floor', shiftTypeId: 'morning', ranges: [{ start: '07:00', end: '16:00' }], note: null },
    { dayOffset: 3, userId: 'c', roleId: 'role-bar', departmentId: 'bar', shiftTypeId: 'evening', ranges: [{ start: '16:00', end: '01:00' }], note: null },
    { dayOffset: 3, userId: 'left', roleId: 'role-floor', departmentId: 'floor', shiftTypeId: 'morning', ranges: [{ start: '07:00', end: '16:00' }], note: null },
  ];
  const plan = planCopy({ target, entries, mode: 'fill', today: DAYS[1]!, missingPerson: 'drop' });
  assert.equal(plan.skippedPast, 1);
  assert.equal(plan.dropped, 1);
  assert.equal(plan.created, 1);
  const barOnly = planCopy({ target, entries, mode: 'fill', today, missingPerson: 'drop', departmentId: 'bar' });
  assert.equal(barOnly.created, 1);
  assert.equal(barOnly.ops[0]!.op === 'create' && barOnly.ops[0]!.userId, 'c');
});

test('roleForDepartment prefers the department role, then a role someone in it holds', () => {
  const w = week();
  assert.equal(roleForDepartment(w, 'bar'), 'role-bar');
  assert.equal(roleForDepartment({ ...w, departments: [] }, null), 'role-floor');
});
