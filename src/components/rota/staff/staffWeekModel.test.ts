import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, nowAndNext, staffDays, swappableShifts } from './staffWeekModel';
import { myShiftLabels } from './myShiftLabels';
import { demoWeek, leave, shift } from './testWeek';

const fri = shift('a', '2026-10-09', 'd', [{ start: '11:00', end: '20:00' }]);
const sat = shift('a', '2026-10-10', 'e', [{ start: '16:00', end: '01:00' }]);
const split = shift('a', '2026-10-11', 'sp', [{ start: '11:00', end: '15:00' }, { start: '18:00', end: '23:00' }]);

test('on shift now, and the next one', () => {
  const r = nowAndNext([fri, sat, split], { date: '2026-10-09', minutes: 11 * 60 + 20 });
  assert.equal(r.current?.shift.id, fri.id);
  assert.equal(r.current?.endsIn, 8 * 60 + 40);
  assert.equal(r.next?.shift.id, sat.id);
});

test('a cross-midnight shift is still on at 00:30 the next day', () => {
  const r = nowAndNext([fri, sat, split], { date: '2026-10-11', minutes: 30 });
  assert.equal(r.current?.shift.id, sat.id);
  assert.equal(r.current?.endsIn, 30);
  assert.equal(r.next?.shift.id, split.id);
});

test('in the break of a split the second half is next', () => {
  const r = nowAndNext([split], { date: '2026-10-11', minutes: 16 * 60 });
  assert.equal(r.current, null);
  assert.equal(r.next?.shift.id, split.id);
  assert.equal(r.next?.startsIn, 120);
});

test('nothing left this week', () => {
  assert.deepEqual(nowAndNext([fri], { date: '2026-10-11', minutes: 0 }), { current: null, next: null });
});

test('formatDuration', () => {
  assert.equal(formatDuration(520), '8 h 40 min');
  assert.equal(formatDuration(35), '35 min');
  assert.equal(formatDuration(120), '2 h');
});

test('staff days: pending time off and pending swaps are marked; past days known', () => {
  const w = demoWeek({
    shifts: [fri, sat],
    leaves: [leave('a', '2026-10-06', 'ANNUAL_LEAVE')],
    requests: [
      { id: 't', kind: 'timeOff', status: 'pending', userId: 'a', dates: ['2026-10-08'], reason: null, createdAt: '' },
      { id: 'w', kind: 'swap', status: 'pending', userId: 'a', dates: ['2026-10-10'], shiftId: sat.id, reason: null, createdAt: '' },
    ],
  });
  const days = staffDays(w, 'a', '2026-10-09');
  assert.equal(days.length, 7);
  assert.equal(days[1]!.leave, 'ANNUAL_LEAVE');
  assert.equal(days[3]!.offRequested, true);
  assert.equal(days[4]!.today, true);
  assert.equal(days[3]!.past, true);
  assert.equal(days[5]!.swapRequested, true);
  // Saturday has a swap pending, Friday has started: nothing left to offer.
  assert.deepEqual(swappableShifts(days, { date: '2026-10-09', minutes: 12 * 60 }), []);
  assert.deepEqual(swappableShifts(days, { date: '2026-10-09', minutes: 9 * 60 }).map((s) => s.id), [fri.id]);
});

test('my-shift labels: old server reads exactly as before, v2 adds type, split, +1 and note', () => {
  assert.deepEqual(myShiftLabels({ startLabel: '17:00', endLabel: '23:00' }), { typeName: null, times: '17:00–23:00', nextDay: false, note: null });
  assert.deepEqual(
    myShiftLabels({ startLabel: '16:00', endLabel: '01:00', shiftTypeName: 'Evening', ranges: [{ start: '16:00', end: '01:00' }], endsNextDay: true, note: ' Dress code black ' }),
    { typeName: 'Evening', times: '16:00–01:00', nextDay: true, note: 'Dress code black' },
  );
  assert.equal(
    myShiftLabels({ startLabel: '11:00', endLabel: '23:00', shiftTypeName: 'Split', ranges: [{ start: '11:00', end: '15:00' }, { start: '18:00', end: '23:00' }], endsNextDay: false, note: null }).times,
    '11:00–15:00 · 18:00–23:00',
  );
  // An old server with a cross-midnight shift still gets the marker.
  assert.equal(myShiftLabels({ startLabel: '19:00', endLabel: '02:00' }).nextDay, true);
});
