import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HISTORY_CAP, afterRedo, afterUndo, aliasesFrom, emptyHistory, invertOps, recordAction, remapOps, resolveId } from './rotaUndo.ts';
import { DAYS, leave, shift, week } from './rotaFixture.ts';

test('create is undone by deleting the new shift, and a Day off it displaced comes back', () => {
  const before = week({ leaves: [leave('a', DAYS[2]!, 'DAY_OFF')] });
  const inv = invertOps(before, [{ op: 'create', tempId: 't1', userId: 'a', date: DAYS[2]!, shiftTypeId: 'morning' }], [{ op: 0, tempId: 't1', shiftId: 'new1' }]);
  assert.deepEqual(inv, [
    { op: 'delete', shiftId: 'new1' },
    { op: 'setLeave', userId: 'a', date: DAYS[2], type: 'DAY_OFF' },
  ]);
});

test('an explicit clearLeave + create is undone in reverse order: delete, then the leave back', () => {
  const before = week({ leaves: [leave('a', DAYS[2]!, 'SICK_LEAVE')] });
  const inv = invertOps(
    before,
    [
      { op: 'clearLeave', userId: 'a', date: DAYS[2]! },
      { op: 'create', userId: 'a', date: DAYS[2]!, shiftTypeId: 'morning' },
    ],
    [{ op: 0 }, { op: 1, shiftId: 'new1' }],
  );
  assert.deepEqual(inv, [
    { op: 'delete', shiftId: 'new1' },
    { op: 'setLeave', userId: 'a', date: DAYS[2], type: 'SICK_LEAVE' },
  ]);
});

test('update is undone by restoring every previous field', () => {
  const s = shift('s1', 'a', DAYS[1]!, { note: 'Brief at 15:45' });
  const inv = invertOps(week({ shifts: [s] }), [{ op: 'update', shiftId: 's1', userId: 'b', date: DAYS[3]!, shiftTypeId: 'evening' }], [{ op: 0, shiftId: 's1' }]);
  assert.deepEqual(inv, [
    {
      op: 'update',
      shiftId: 's1',
      userId: 'a',
      date: DAYS[1],
      roleId: 'role-floor',
      departmentId: 'floor',
      shiftTypeId: 'morning',
      ranges: [{ start: '07:00', end: '16:00' }],
      note: 'Brief at 15:45',
    },
  ]);
});

test('a move that replaced the target shift is undone in reverse: move back, then recreate the replaced one', () => {
  const mover = shift('s1', 'a', DAYS[1]!);
  const victim = shift('s2', 'b', DAYS[1]!, { shiftTypeId: 'evening', ranges: [{ start: '16:00', end: '01:00' }] });
  const inv = invertOps(
    week({ shifts: [mover, victim] }),
    [
      { op: 'delete', shiftId: 's2' },
      { op: 'update', shiftId: 's1', userId: 'b' },
    ],
    [
      { op: 0, shiftId: 's2' },
      { op: 1, shiftId: 's1' },
    ],
  );
  assert.equal(inv.length, 2);
  assert.equal(inv[0]!.op, 'update');
  assert.equal(inv[0]!.op === 'update' && inv[0]!.userId, 'a');
  assert.deepEqual(inv[1], {
    op: 'create',
    tempId: 's2',
    userId: 'b',
    roleId: 'role-floor',
    departmentId: 'floor',
    date: DAYS[1],
    shiftTypeId: 'evening',
    ranges: [{ start: '16:00', end: '01:00' }],
    note: null,
  });
});

test('leave ops invert to the previous leave or to nothing', () => {
  const before = week({ leaves: [leave('a', DAYS[0]!, 'HALF_DAY')] });
  assert.deepEqual(invertOps(before, [{ op: 'setLeave', userId: 'a', date: DAYS[0]!, type: 'DAY_OFF' }], [{ op: 0 }]), [
    { op: 'setLeave', userId: 'a', date: DAYS[0], type: 'HALF_DAY' },
  ]);
  assert.deepEqual(invertOps(before, [{ op: 'setLeave', userId: 'b', date: DAYS[0]!, type: 'DAY_OFF' }], [{ op: 0 }]), [{ op: 'clearLeave', userId: 'b', date: DAYS[0] }]);
  assert.deepEqual(invertOps(before, [{ op: 'clearLeave', userId: 'b', date: DAYS[0]! }], [{ op: 0 }]), []);
});

test('a recreated shift aliases its old id so older history entries still reach it', () => {
  const ops = [{ op: 'create' as const, tempId: 'old', userId: 'a', date: DAYS[0]!, ranges: [{ start: '07:00', end: '16:00' }] }];
  const alias = aliasesFrom(ops, [{ op: 0, tempId: 'old', shiftId: 'new' }]);
  assert.deepEqual(alias, { old: 'new' });
  assert.equal(resolveId('old', { ...alias, new: 'newer' }), 'newer');
  assert.deepEqual(remapOps([{ op: 'delete', shiftId: 'old' }, { op: 'clearLeave', userId: 'a', date: DAYS[0]! }], alias), [
    { op: 'delete', shiftId: 'new' },
    { op: 'clearLeave', userId: 'a', date: DAYS[0] },
  ]);
});

test('history: a new action clears redo, undo/redo move entries across, the stack is capped', () => {
  let h = emptyHistory();
  h = recordAction(h, { label: 'A', ops: [{ op: 'delete', shiftId: '1' }] });
  h = afterUndo(h, { label: 'A', ops: [{ op: 'delete', shiftId: '2' }] });
  assert.equal(h.undo.length, 0);
  assert.equal(h.redo.length, 1);
  h = afterRedo(h, { label: 'A', ops: [{ op: 'delete', shiftId: '3' }] }, { x: 'y' });
  assert.deepEqual([h.undo.length, h.redo.length, h.alias], [1, 0, { x: 'y' }]);
  h = afterUndo(h, { label: 'A', ops: [{ op: 'delete', shiftId: '4' }] });
  h = recordAction(h, { label: 'B', ops: [{ op: 'delete', shiftId: '5' }] });
  assert.equal(h.redo.length, 0, 'a new mutation invalidates redo');
  assert.equal(recordAction(h, { label: 'nothing', ops: [] }).undo.length, h.undo.length, 'an empty inverse is not recorded');
  for (let i = 0; i < HISTORY_CAP + 20; i++) h = recordAction(h, { label: String(i), ops: [{ op: 'delete', shiftId: String(i) }] });
  assert.equal(h.undo.length, HISTORY_CAP);
  assert.equal(h.undo[h.undo.length - 1]!.label, String(HISTORY_CAP + 19));
});
