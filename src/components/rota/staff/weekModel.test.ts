import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayNumber, displayNames, formatStamp, groupPeople, longDate, personDay, roleLine, shortTimes, venueNow, weekRangeLabel } from './weekModel';
import { demoWeek, leave, person, shift } from './testWeek';

test('venueNow reads the venue clock, not the device clock', () => {
  // 21:30 UTC is 01:30 the next day in Dubai (UTC+4).
  assert.deepEqual(venueNow('Asia/Dubai', new Date('2026-10-09T21:30:00Z')), { date: '2026-10-10', minutes: 90 });
  assert.deepEqual(venueNow('UTC', new Date('2026-10-09T21:30:00Z')), { date: '2026-10-09', minutes: 21 * 60 + 30 });
  // A bad timezone falls back to UTC instead of throwing.
  assert.equal(venueNow('Not/AZone', new Date('2026-10-09T08:00:00Z')).date, '2026-10-09');
});

test('date labels never abbreviate where the design spells the date out', () => {
  assert.equal(longDate('2026-10-09'), 'Friday 9 October');
  assert.equal(longDate('2026-10-09', true), 'Friday 9 October 2026');
  assert.equal(weekRangeLabel('2026-10-05', '2026-10-11'), '5 – 11 Oct');
  // ICU spells September "Sep" or "Sept" depending on its version.
  assert.match(weekRangeLabel('2026-09-28', '2026-10-04'), /^28 Sept? – 4 Oct$/);
  assert.equal(dayNumber('1970-01-02'), 1);
});

test('formatStamp is in the venue timezone', () => {
  assert.equal(formatStamp('2026-10-06T14:40:00.000Z', 'Asia/Dubai'), 'Tue 6 Oct · 18:40');
});

test('shortTimes: hours only on the hour, both starts for a split', () => {
  assert.equal(shortTimes([{ start: '07:00', end: '16:00' }]), '07–16');
  assert.equal(shortTimes([{ start: '07:30', end: '16:00' }]), '07:30–16');
  assert.equal(shortTimes([{ start: '11:00', end: '15:00' }, { start: '18:00', end: '23:00' }]), '11·18');
});

test('groupPeople keeps department order and files the department-less under Other', () => {
  const groups = groupPeople(demoWeek());
  assert.deepEqual(
    groups.map((g) => [g.name, g.people.map((p) => p.id)]),
    [
      ['Floor', ['a', 'b']],
      ['Bar', ['c']],
      ['Other', ['d']],
    ],
  );
});

test('displayNames: first name, surname initial on a clash, full name when even that clashes', () => {
  const names = displayNames([
    { id: '1', fullName: 'Sam Oak' },
    { id: '2', fullName: 'Sam Kite' },
    { id: '3', fullName: 'Lee Ray' },
    { id: '4', fullName: 'Ana Moss' },
    { id: '5', fullName: 'Ana Mint' },
  ]);
  assert.equal(names.get('1'), 'Sam O.');
  assert.equal(names.get('2'), 'Sam K.');
  assert.equal(names.get('3'), 'Lee');
  assert.equal(names.get('4'), 'Ana Moss');
  assert.equal(names.get('5'), 'Ana Mint');
});

test('roleLine names the department, role and any second department', () => {
  const w = demoWeek();
  assert.equal(roleLine(person('x', 'Person X', 'floor', { alsoDepartmentIds: ['bar'] }), w.departments), 'Floor · Waiter · also Bar');
});

test('personDay: approved leave locks the day, a pending request is found by date', () => {
  const w = demoWeek({
    shifts: [shift('a', '2026-10-08', 'd', [{ start: '11:00', end: '20:00' }])],
    leaves: [leave('b', '2026-10-08', 'ANNUAL_LEAVE', { fromRequest: true }), leave('c', '2026-10-08', 'ANNUAL_LEAVE')],
    requests: [{ id: 'r1', kind: 'timeOff', status: 'pending', userId: 'a', dates: ['2026-10-08', '2026-10-09'], reason: null, createdAt: '' }],
  });
  const a = personDay(w, 'a', '2026-10-08');
  assert.equal(a.shifts.length, 1);
  assert.equal(a.pendingRequest?.id, 'r1');
  assert.equal(a.locked, false);
  assert.equal(personDay(w, 'b', '2026-10-08').locked, true);
  assert.equal(personDay(w, 'c', '2026-10-08').locked, false, 'leave a manager marked by hand can be painted over');
});
