import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isClockTime, parseSpokenTime, readOneTime, readShiftTimes } from './times.js';

const one = (start: string, end: string, said = '') => {
  const r = readShiftTimes(start, end, said);
  return r.kind === 'one' ? `${r.times.start}-${r.times.end}` : r.kind === 'choice' ? r.readings.map((x) => `${x.start}-${x.end}`) : 'none';
};

test('spoken times: am/pm, the 24-hour clock, words, half past and quarter to, noon and midnight', () => {
  assert.deepEqual(parseSpokenTime('6pm'), { hour: 6, minute: 0, meridiem: 'pm', fixed: true });
  assert.deepEqual(parseSpokenTime('7 p.m.'), { hour: 7, minute: 0, meridiem: 'pm', fixed: true });
  assert.deepEqual(parseSpokenTime('seven pee em'), { hour: 7, minute: 0, meridiem: 'pm', fixed: true });
  assert.deepEqual(parseSpokenTime('18:30'), { hour: 18, minute: 30, meridiem: null, fixed: true });
  assert.deepEqual(parseSpokenTime('06:00'), { hour: 6, minute: 0, meridiem: null, fixed: true });
  assert.deepEqual(parseSpokenTime('6'), { hour: 6, minute: 0, meridiem: null, fixed: false });
  assert.deepEqual(parseSpokenTime('half past six'), { hour: 6, minute: 30, meridiem: null, fixed: false });
  assert.deepEqual(parseSpokenTime('quarter to seven'), { hour: 6, minute: 45, meridiem: null, fixed: false });
  assert.deepEqual(parseSpokenTime('six thirty'), { hour: 6, minute: 30, meridiem: null, fixed: false });
  assert.deepEqual(parseSpokenTime('noon'), { hour: 12, minute: 0, meridiem: null, fixed: true });
  assert.deepEqual(parseSpokenTime('midnight'), { hour: 0, minute: 0, meridiem: null, fixed: true });
  for (const bad of ['', 'closing', '25', '13pm', 'soon']) assert.equal(parseSpokenTime(bad), null, bad);
});

test('"N to M" with no am/pm: an end at or before the start runs past midnight; a two-way reading is asked, the evening one first', () => {
  assert.deepEqual(one('6', '2'), ['18:00-02:00', '06:00-14:00']);
  assert.equal(one('6pm', '2'), '18:00-02:00');
  assert.equal(one('18:30', '1'), '18:30-01:00');
  assert.equal(one('6', '2am'), '18:00-02:00');
  assert.equal(one('5pm', 'eleven'), '17:00-23:00');
  assert.equal(one('4', 'midnight'), '16:00-00:00');
  assert.equal(one('noon', '8'), '12:00-20:00');
  assert.equal(one('18:00', '02:00'), '18:00-02:00');
});

test('a service word the caller said settles a two-way reading: "tomorrow evening", "tonight", "lunch", Tagalog "gabi"', () => {
  assert.equal(one('6', '2', 'tomorrow evening 6 to 2'), '18:00-02:00');
  assert.equal(one('6', '2', 'tonight from 6 to 2'), '18:00-02:00');
  assert.equal(one('11', '3', 'lunch 11 to 3'), '11:00-15:00');
  assert.equal(one('6', '2', 'bukas ng gabi 6 to 2'), '18:00-02:00');
});

test('a new start or end for an existing shift keeps it a plausible length', () => {
  const r = readOneTime('six', 'start', '23:00');
  assert.deepEqual(r.kind === 'one' && r.times, { start: '18:00', end: '23:00' });
  const e = readOneTime('8 p.m.', 'end', '10:00');
  assert.deepEqual(e.kind === 'one' && e.times, { start: '10:00', end: '20:00' });
  assert.equal(readOneTime('later', 'start', '23:00').kind, 'none');
});

test('isClockTime: only real HH:MM', () => {
  assert.ok(isClockTime('00:00') && isClockTime('23:59'));
  for (const bad of ['24:00', '99:99', '6:00', '18:60', 6]) assert.equal(isClockTime(bad), false, String(bad));
});
