import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickClockInShift, type ClockInCandidate } from './clockInShift.js';

const TZ = 'Asia/Dubai'; // UTC+4, no DST
const at = (iso: string) => new Date(iso);

const yesterdayEvening: ClockInCandidate = { id: 'evening', date: '2031-03-03', endTime: at('2031-03-03T21:00:00Z'), endsNextDay: true }; // 16:00–01:00 Dubai
const todayMorning: ClockInCandidate = { id: 'morning', date: '2031-03-04', endTime: at('2031-03-04T12:00:00Z'), endsNextDay: false }; // 07:00–16:00 Dubai

test('in the day, today\'s shift (start-day rule)', () => {
  assert.equal(pickClockInShift([yesterdayEvening, todayMorning], at('2031-03-04T03:30:00Z'), TZ)?.id, 'morning'); // 07:30 Dubai
  assert.equal(pickClockInShift([yesterdayEvening, todayMorning], at('2031-03-04T19:30:00Z'), TZ)?.id, 'morning'); // 23:30 Dubai, late
});

test("between 00:00 and 06:00, last night's unfinished cross-midnight shift wins", () => {
  // 00:20 Dubai on the 4th: the Evening that started on the 3rd runs until 01:00.
  assert.equal(pickClockInShift([yesterdayEvening, todayMorning], at('2031-03-03T20:20:00Z'), TZ)?.id, 'evening');
});

test('after last night\'s shift has ended, an early clock-in goes to today\'s shift', () => {
  // 05:30 Dubai: the Evening ended at 01:00.
  assert.equal(pickClockInShift([yesterdayEvening, todayMorning], at('2031-03-04T01:30:00Z'), TZ)?.id, 'morning');
});

test('a shift of yesterday that did not cross midnight never matches; no shift today is no match', () => {
  const yesterdayDay: ClockInCandidate = { id: 'day', date: '2031-03-03', endTime: at('2031-03-03T19:00:00Z'), endsNextDay: false };
  assert.equal(pickClockInShift([yesterdayDay], at('2031-03-03T20:30:00Z'), TZ), null); // 00:30 Dubai on the 4th
  assert.equal(pickClockInShift([], at('2031-03-04T05:00:00Z'), TZ), null);
});
