import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WeekDocDto, WeekPatchOp } from '../../../../shared/rotaWeek';
import { personDay } from '../staff/weekModel';
import { demoWeek, leave, shift } from '../staff/testWeek';
import {
  batchOps,
  dayGroups,
  needsConfirm,
  opsForAction,
  pushUndo,
  queuePaint,
  restoreOps,
  snapshotOf,
  tileFor,
  weekStrip,
  type CellAction,
  type UndoEntry,
} from './phoneModel';

const THU = '2026-10-08';
const mid = [{ start: '11:00', end: '20:00' }];

/**
 * A tiny in-memory stand-in for the server's patch rules, enough to check
 * that an action followed by its inverse lands back where it started.
 */
function apply(week: WeekDocDto, ops: WeekPatchOp[]): WeekDocDto {
  let shifts = week.shifts.map((s) => ({ ...s }));
  let leaves = week.leaves.map((l) => ({ ...l }));
  let n = 0;
  for (const op of ops) {
    switch (op.op) {
      case 'create': {
        const type = week.shiftTypes.find((t) => t.id === op.shiftTypeId);
        const ranges = op.ranges ?? type!.ranges;
        assert.ok(!shifts.some((s) => s.userId && s.userId === op.userId && s.date === op.date), 'already_has_shift');
        const blocking = leaves.find((l) => l.userId === op.userId && l.date === op.date);
        if (blocking) {
          assert.ok(blocking.type === 'DAY_OFF' || blocking.type === 'HALF_DAY', 'person_on_leave');
          leaves = leaves.filter((l) => l !== blocking);
        }
        shifts.push(shift(op.userId, op.date, op.shiftTypeId ?? null, ranges, { id: `new${++n}`, note: op.note ?? null, roleId: op.roleId ?? 'role-1' }));
        break;
      }
      case 'update':
        shifts = shifts.map((s) => {
          if (s.id !== op.shiftId) return s;
          const type = typeof op.shiftTypeId === 'string' ? week.shiftTypes.find((t) => t.id === op.shiftTypeId) : null;
          return {
            ...s,
            userId: op.userId === undefined ? s.userId : op.userId,
            date: op.date ?? s.date,
            shiftTypeId: op.shiftTypeId === undefined ? s.shiftTypeId : op.shiftTypeId,
            ranges: op.ranges ?? type?.ranges ?? s.ranges,
            note: op.note === undefined ? s.note : op.note,
          };
        });
        break;
      case 'delete':
        shifts = shifts.filter((s) => s.id !== op.shiftId);
        break;
      case 'setLeave':
        assert.ok(!shifts.some((s) => s.userId === op.userId && s.date === op.date), 'leave_over_shift');
        leaves = [...leaves.filter((l) => !(l.userId === op.userId && l.date === op.date)), leave(op.userId, op.date, op.type)];
        break;
      case 'clearLeave':
        leaves = leaves.filter((l) => !(l.userId === op.userId && l.date === op.date));
        break;
    }
  }
  return { ...week, shifts, leaves };
}

/** What a person-day looks like, ignoring ids. */
const look = (w: WeekDocDto, userId: string, date: string) => {
  const d = personDay(w, userId, date);
  return { shifts: d.shifts.map((s) => `${s.shiftTypeId}@${s.ranges.map((r) => r.start + '-' + r.end).join(',')}|${s.note ?? ''}`), leave: d.leave?.type ?? null };
};

const entry = (cells: UndoEntry['cells'], extra: Partial<UndoEntry> = {}): UndoEntry => ({
  id: 1,
  label: 'x',
  cells,
  openShifts: [],
  created: [],
  declinedRequest: false,
  stroke: null,
  at: 0,
  ...extra,
});

test('one-tap assign: empty day creates, a shift is re-typed in place, the same type is a no-op', () => {
  const s = shift('a', THU, 'd', mid);
  const w = demoWeek({ shifts: [s] });
  assert.deepEqual(opsForAction(personDay(w, 'b', THU), { kind: 'type', shiftTypeId: 'm' }), [{ op: 'create', userId: 'b', date: THU, shiftTypeId: 'm' }]);
  assert.deepEqual(opsForAction(personDay(w, 'a', THU), { kind: 'type', shiftTypeId: 'e' }), [{ op: 'update', shiftId: s.id, shiftTypeId: 'e' }]);
  assert.deepEqual(opsForAction(personDay(w, 'a', THU), { kind: 'type', shiftTypeId: 'd' }), []);
});

test('assigning over blocking leave clears it first; Day off gives way on its own', () => {
  const w = demoWeek({ leaves: [leave('a', THU, 'SICK_LEAVE'), leave('b', THU, 'DAY_OFF')] });
  assert.deepEqual(opsForAction(personDay(w, 'a', THU), { kind: 'type', shiftTypeId: 'm' }).map((o) => o.op), ['clearLeave', 'create']);
  assert.deepEqual(opsForAction(personDay(w, 'b', THU), { kind: 'type', shiftTypeId: 'm' }).map((o) => o.op), ['create']);
});

test('leave over a shift removes the shift first; erase clears both', () => {
  const s = shift('a', THU, 'd', mid);
  const w = demoWeek({ shifts: [s], leaves: [leave('b', THU, 'ANNUAL_LEAVE')] });
  assert.deepEqual(opsForAction(personDay(w, 'a', THU), { kind: 'leave', type: 'SICK_LEAVE' }), [
    { op: 'delete', shiftId: s.id },
    { op: 'setLeave', userId: 'a', date: THU, type: 'SICK_LEAVE' },
  ]);
  assert.deepEqual(opsForAction(personDay(w, 'b', THU), { kind: 'leave', type: 'ANNUAL_LEAVE' }), []);
  assert.deepEqual(opsForAction(personDay(w, 'b', THU), { kind: 'erase' }), [{ op: 'clearLeave', userId: 'b', date: THU }]);
});

test('only a shift onto a pending request needs the confirm sheet', () => {
  const w = demoWeek({ requests: [{ id: 'r', kind: 'timeOff', status: 'pending', userId: 'a', dates: [THU], reason: null, createdAt: '' }] });
  const day = personDay(w, 'a', THU);
  assert.equal(needsConfirm(day, { kind: 'type', shiftTypeId: 'm' }), true);
  assert.equal(needsConfirm(day, { kind: 'leave', type: 'DAY_OFF' }), false);
  assert.equal(needsConfirm(personDay(w, 'b', THU), { kind: 'type', shiftTypeId: 'm' }), false);
});

test('undo restores every kind of one-tap change', () => {
  const s = shift('a', THU, 'd', mid, { note: 'Bring keys' });
  const base = demoWeek({ shifts: [s], leaves: [leave('b', THU, 'SICK_LEAVE'), leave('c', THU, 'DAY_OFF')] });
  const actions: [string, CellAction][] = [
    ['a', { kind: 'type', shiftTypeId: 'e' }],
    ['a', { kind: 'leave', type: 'ANNUAL_LEAVE' }],
    ['a', { kind: 'erase' }],
    ['b', { kind: 'type', shiftTypeId: 'm' }],
    ['b', { kind: 'leave', type: 'DAY_OFF' }],
    ['c', { kind: 'type', shiftTypeId: 'sp' }],
    ['d', { kind: 'type', shiftTypeId: 'm' }],
  ];
  for (const [userId, action] of actions) {
    const day = personDay(base, userId, THU);
    const after = apply(base, opsForAction(day, action));
    const undone = apply(after, restoreOps(after, entry([snapshotOf(day)])));
    assert.deepEqual(look(undone, userId, THU), look(base, userId, THU), `${userId} ${JSON.stringify(action)}`);
  }
});

test('undo keeps the original shift id when it still exists (re-time in place, not delete + create)', () => {
  const s = shift('a', THU, 'd', mid);
  const base = demoWeek({ shifts: [s] });
  const day = personDay(base, 'a', THU);
  const after = apply(base, opsForAction(day, { kind: 'type', shiftTypeId: 'm' }));
  const ops = restoreOps(after, entry([snapshotOf(day)]));
  assert.deepEqual(ops, [{ op: 'update', shiftId: s.id, userId: 'a', date: THU, shiftTypeId: 'd', ranges: mid, note: null }]);
});

test('undo of a "make open" puts the person back; undo of a duplicate deletes the copy', () => {
  const s = shift('a', THU, 'd', mid);
  const base = demoWeek({ shifts: [s] });
  const day = personDay(base, 'a', THU);
  const opened = apply(base, [{ op: 'update', shiftId: s.id, userId: null }]);
  assert.deepEqual(restoreOps(opened, entry([snapshotOf(day)])), [{ op: 'update', shiftId: s.id, userId: 'a', date: THU, shiftTypeId: 'd', ranges: mid, note: null }]);

  const dup = apply(base, [{ op: 'create', userId: null, date: THU, shiftTypeId: 'd' }]);
  const copyId = dup.shifts.find((x) => x.userId === null)!.id;
  assert.deepEqual(restoreOps(dup, entry([], { created: [copyId] })), [{ op: 'delete', shiftId: copyId }]);
});

test('a paint stroke merges into one undo entry that returns to before the whole stroke', () => {
  const base = demoWeek({ shifts: [shift('a', THU, 'd', mid)] });
  let week = base;
  let stack: UndoEntry[] = [];
  const taps: [string, string, CellAction, number][] = [
    ['a', THU, { kind: 'type', shiftTypeId: 'm' }, 0],
    ['b', THU, { kind: 'type', shiftTypeId: 'm' }, 500],
    ['a', THU, { kind: 'leave', type: 'SICK_LEAVE' }, 1500],
  ];
  for (const [u, d, a, at] of taps) {
    const day = personDay(week, u, d);
    week = apply(week, opsForAction(day, a));
    stack = pushUndo(stack, entry([snapshotOf(day)], { stroke: 'p1', at }));
  }
  assert.equal(stack.length, 1);
  const undone = apply(week, restoreOps(week, stack[0]!));
  assert.deepEqual(look(undone, 'a', THU), look(base, 'a', THU));
  assert.deepEqual(look(undone, 'b', THU), look(base, 'b', THU));

  // A pause longer than 2 s, or a new stroke, starts a new entry.
  assert.equal(pushUndo(stack, entry([], { stroke: 'p1', at: 1500 + 2001 })).length, 2);
  assert.equal(pushUndo(stack, entry([], { stroke: 'p2', at: 1600 })).length, 2);
});

test('paint batching: last brush per tile wins, locked tiles and no-ops are skipped', () => {
  const w = demoWeek({ shifts: [shift('c', THU, 'm', [{ start: '07:00', end: '16:00' }])], leaves: [leave('b', THU, 'ANNUAL_LEAVE', { fromRequest: true })] });
  let pending = queuePaint([], { userId: 'a', date: THU, action: { kind: 'type', shiftTypeId: 'm' } });
  pending = queuePaint(pending, { userId: 'b', date: THU, action: { kind: 'type', shiftTypeId: 'm' } });
  pending = queuePaint(pending, { userId: 'c', date: THU, action: { kind: 'type', shiftTypeId: 'm' } });
  pending = queuePaint(pending, { userId: 'a', date: THU, action: { kind: 'type', shiftTypeId: 'e' } });
  assert.equal(pending.length, 3);
  const { ops, cells } = batchOps(pending, (u, d) => personDay(w, u, d));
  assert.deepEqual(ops, [{ op: 'create', userId: 'a', date: THU, shiftTypeId: 'e' }]);
  assert.deepEqual(cells.map((c) => c.userId), ['a']);
});

test('week strip: count per day, short days flagged instead of the count', () => {
  const w = demoWeek({
    coverage: [
      { date: '2026-10-09', on: 10, off: 4, leave: 0, uncovered: [] },
      { date: '2026-10-10', on: 9, off: 4, leave: 1, uncovered: [{ departmentId: 'bar', short: 1 }] },
    ],
  });
  const strip = weekStrip(w, w.weekStart, '2026-10-09', '2026-10-09');
  assert.equal(strip[4]!.count, '10 on');
  assert.equal(strip[4]!.selected, true);
  assert.equal(strip[5]!.count, '−1');
  assert.equal(strip[5]!.weekend, true);
  assert.equal(strip[5]!.label, 'Saturday 10 October, 9 on, needs 1 more');
  assert.equal(strip[0]!.count, '');
});

test('paint tiles: code letter and short times', () => {
  const w = demoWeek({ shifts: [shift('a', THU, 'e', [{ start: '16:00', end: '01:00' }])], leaves: [leave('b', THU, 'SICK_LEAVE')] });
  assert.deepEqual(
    { ...tileFor(personDay(w, 'a', THU), w.shiftTypes) },
    { code: 'E', sub: '16–01', tone: 'shift', spoken: 'Evening 16:00 to 01:00, ends next day' },
  );
  assert.equal(tileFor(personDay(w, 'b', THU), w.shiftTypes).code, 'Sk');
  assert.equal(tileFor(personDay(w, 'c', THU), w.shiftTypes).tone, 'empty');
});

test('day sections: open shifts sit under their department, even one with nobody on it', () => {
  const w = demoWeek({
    people: demoWeek().people.filter((p) => p.departmentId === 'floor'),
    shifts: [shift(null, THU, 'e', [{ start: '16:00', end: '01:00' }], { departmentId: 'bar' }), shift(null, THU, 'm', [{ start: '07:00', end: '16:00' }]), shift(null, '2026-10-09', 'm', [{ start: '07:00', end: '16:00' }])],
  });
  const sections = dayGroups(w, THU);
  assert.deepEqual(
    sections.map((s) => [s.group.name, s.group.people.length, s.open.length]),
    [
      ['Floor', 2, 1],
      ['Bar', 0, 1],
    ],
  );
});
