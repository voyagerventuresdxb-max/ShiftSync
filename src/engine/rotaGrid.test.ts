import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cellId,
  classifyDrop,
  coverageView,
  diffWeeks,
  dropRing,
  fullDate,
  groupPeople,
  indexWeek,
  moveFocus,
  parseCellId,
  requestCells,
  shortNames,
  unpublishedCount,
  venueToday,
} from './rotaGrid.ts';
import { DAYS, leave, person, shift, timeOff, week } from './rotaFixture.ts';

const ctxOf = (w = week(), today = DAYS[0]!) => ({ week: w, idx: indexWeek(w), today });

test('cell ids round-trip, the open row included', () => {
  assert.equal(cellId('2026-10-12', 'a'), '2026-10-12|a');
  assert.equal(cellId('2026-10-12', null), '2026-10-12|open');
  assert.deepEqual(parseCellId('2026-10-12|a'), { date: '2026-10-12', userId: 'a' });
  assert.deepEqual(parseCellId('2026-10-12|open'), { date: '2026-10-12', userId: null });
  assert.equal(parseCellId('nonsense'), null);
});

test('fullDate never abbreviates and has no comma after the weekday', () => {
  assert.equal(fullDate('2026-10-15'), 'Thursday 15 October 2026');
});

test('venueToday reads the calendar day in the venue zone, not the device zone', () => {
  // 22:30 UTC on the 9th is already the 10th in Dubai (UTC+4).
  assert.equal(venueToday('Asia/Dubai', new Date('2026-10-09T22:30:00.000Z')), '2026-10-10');
  assert.equal(venueToday('Not/AZone', new Date('2026-10-09T22:30:00.000Z')), '2026-10-09');
});

test('shortNames adds a surname initial only when first names collide', () => {
  const names = shortNames([
    { id: '1', fullName: 'Sam Oak' },
    { id: '2', fullName: 'Sam Kay' },
    { id: '3', fullName: 'Person C' },
  ]);
  assert.equal(names.get('1'), 'Sam O.');
  assert.equal(names.get('2'), 'Sam K.');
  assert.equal(names.get('3'), 'Person');
});

test('drop of a type onto an empty person cell is ok; onto a filled one it replaces', () => {
  const w = week({ shifts: [shift('s1', 'a', DAYS[1]!)] });
  assert.deepEqual(classifyDrop(ctxOf(w), { kind: 'type', shiftTypeId: 'evening' }, { date: DAYS[0]!, userId: 'a' }), { state: 'ok', replaces: null });
  const v = classifyDrop(ctxOf(w), { kind: 'type', shiftTypeId: 'evening' }, { date: DAYS[1]!, userId: 'a' });
  assert.equal(v.state, 'ok');
  assert.equal(v.state === 'ok' && v.replaces, 'Morning 07:00–16:00');
});

test('approved leave blocks a drop with the explanation; a manager-set status is replaced', () => {
  const w = week({ leaves: [leave('a', DAYS[2]!, 'ANNUAL_LEAVE', true), leave('b', DAYS[2]!, 'SICK_LEAVE', false)] });
  const blocked = classifyDrop(ctxOf(w), { kind: 'type', shiftTypeId: 'morning' }, { date: DAYS[2]!, userId: 'a' });
  assert.equal(blocked.state, 'blocked');
  assert.match(blocked.state === 'blocked' ? blocked.message : '', /approved annual leave.*Decline the leave in Requests first/);
  assert.equal(dropRing(blocked), 'conflict');
  const replaced = classifyDrop(ctxOf(w), { kind: 'type', shiftTypeId: 'morning' }, { date: DAYS[2]!, userId: 'b' });
  assert.deepEqual(replaced, { state: 'ok', replaces: 'Sick' });
  // A status onto approved leave is blocked as well.
  assert.equal(classifyDrop(ctxOf(w), { kind: 'status', leaveType: 'DAY_OFF' }, { date: DAYS[2]!, userId: 'a' }).state, 'blocked');
});

test('a pending request asks for confirmation and carries the request', () => {
  const req = timeOff('r1', 'b', [DAYS[3]!]);
  const w = week({ requests: [req] });
  const v = classifyDrop(ctxOf(w), { kind: 'type', shiftTypeId: 'morning' }, { date: DAYS[3]!, userId: 'b' });
  assert.equal(v.state, 'confirm');
  assert.equal(v.state === 'confirm' && v.request.id, 'r1');
  assert.equal(dropRing(v), 'conflict');
});

test('invalid drops: status on the open row, past days, a chip dropped where it is', () => {
  const w = week({ shifts: [shift('s1', 'a', DAYS[4]!)] });
  assert.equal(classifyDrop(ctxOf(w), { kind: 'status', leaveType: 'DAY_OFF' }, { date: DAYS[4]!, userId: null }).state, 'invalid');
  assert.equal(classifyDrop(ctxOf(w, DAYS[3]!), { kind: 'type', shiftTypeId: 'morning' }, { date: DAYS[1]!, userId: 'a' }).state, 'invalid');
  assert.equal(classifyDrop(ctxOf(w), { kind: 'shift', shiftId: 's1' }, { date: DAYS[4]!, userId: 'a' }).state, 'noop');
  assert.equal(classifyDrop(ctxOf(w), { kind: 'shift', shiftId: 's1' }, { date: DAYS[4]!, userId: null }).state, 'ok');
  const inactive = week({ people: [person('a', 'Person A', 'floor', { isActive: false })] });
  assert.equal(classifyDrop(ctxOf(inactive), { kind: 'type', shiftTypeId: 'morning' }, { date: DAYS[4]!, userId: 'a' }).state, 'invalid');
});

test('coverage cell: "N on · M off" and one pill per short department', () => {
  const w = week();
  assert.deepEqual(coverageView({ date: DAYS[5]!, on: 10, off: 4, leave: 1, uncovered: [{ departmentId: 'bar', short: 1 }] }, w.departments), {
    line: '10 on · 4 off',
    on: 10,
    off: 4,
    short: [{ departmentId: 'bar', short: 1, label: 'Bar −1' }],
  });
  assert.deepEqual(coverageView({ date: DAYS[0]!, on: 3, off: 0, leave: 0, uncovered: [] }, w.departments).short, []);
});

test('groupPeople follows department order, keeps inactive people only while they have something this week', () => {
  const w = week({
    people: [person('c', 'Person C', 'bar'), person('a', 'Person A'), person('x', 'Person X', null), person('gone', 'Person Gone', 'floor', { isActive: false })],
  });
  const groups = groupPeople(w);
  assert.deepEqual(
    groups.map((g) => [g.name, g.people.map((p) => p.id)]),
    [
      ['Floor', ['a']],
      ['Bar', ['c']],
      ['Other', ['x']],
    ],
  );
  const withHistory = groupPeople({ ...w, shifts: [shift('s', 'gone', DAYS[0]!)] });
  assert.deepEqual(withHistory[0]!.people.map((p) => p.id), ['a', 'gone']);
});

test('moveFocus: arrows clamp, Home/End, PageUp/PageDown jump departments', () => {
  const layout = { rows: 6, cols: 7, groupStarts: [0, 3, 5] };
  assert.deepEqual(moveFocus({ row: 0, col: 0 }, 'ArrowUp', layout), { row: 0, col: 0 });
  assert.deepEqual(moveFocus({ row: 0, col: 6 }, 'ArrowRight', layout), { row: 0, col: 6 });
  assert.deepEqual(moveFocus({ row: 2, col: 3 }, 'ArrowDown', layout), { row: 3, col: 3 });
  assert.deepEqual(moveFocus({ row: 2, col: 3 }, 'Home', layout), { row: 2, col: 0 });
  assert.deepEqual(moveFocus({ row: 2, col: 3 }, 'End', layout), { row: 2, col: 6 });
  assert.deepEqual(moveFocus({ row: 1, col: 2 }, 'PageDown', layout), { row: 3, col: 2 });
  assert.deepEqual(moveFocus({ row: 4, col: 2 }, 'PageUp', layout), { row: 3, col: 2 }, 'first to the start of its own department');
  assert.deepEqual(moveFocus({ row: 3, col: 2 }, 'PageUp', layout), { row: 0, col: 2 });
  assert.deepEqual(moveFocus({ row: 5, col: 2 }, 'PageDown', layout), { row: 5, col: 2 });
  assert.equal(moveFocus({ row: 0, col: 0 }, 'x', layout), null);
});

test('requestCells points at the requested days and at both shifts of a swap', () => {
  const w = week({ shifts: [shift('s1', 'a', DAYS[6]!), shift('s2', 'b', DAYS[6]!)] });
  assert.deepEqual(requestCells(w, timeOff('r', 'a', [DAYS[3]!, '2026-10-30'])), [`${DAYS[3]}|a`]);
  assert.deepEqual(
    requestCells(w, { id: 'sw', kind: 'swap', status: 'pending', userId: 'a', dates: [DAYS[6]!], shiftId: 's1', targetShiftId: 's2', reason: null, createdAt: '' }),
    [`${DAYS[6]}|a`, `${DAYS[6]}|b`],
  );
});

test('unpublishedCount counts drafts and edits since publish', () => {
  const w = week({
    shifts: [shift('s1', 'a', DAYS[0]!, { status: 'published' }), shift('s2', 'b', DAYS[0]!, { status: 'published', editedSincePublish: true }), shift('s3', 'c', DAYS[0]!)],
    leaves: [leave('a', DAYS[1]!, 'DAY_OFF')],
  });
  assert.equal(unpublishedCount(w), 3);
});

test('diffWeeks lists only the person-days that differ', () => {
  const mine = week({ shifts: [shift('s1', 'a', DAYS[0]!)] });
  const theirs = week({ shifts: [shift('s1', 'a', DAYS[0]!, { shiftTypeId: 'evening', ranges: [{ start: '16:00', end: '01:00' }] })], leaves: [leave('b', DAYS[1]!, 'SICK_LEAVE')] });
  assert.deepEqual(diffWeeks(mine, theirs), [
    { date: DAYS[0], userId: 'a', mine: 'Morning 07:00–16:00', theirs: 'Evening 16:00–01:00' },
    { date: DAYS[1], userId: 'b', mine: 'Empty', theirs: 'Sick' },
  ]);
});
