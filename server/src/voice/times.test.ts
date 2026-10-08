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

test('"6 to 11" and "six to eleven" with no cue: both readings, the evening one first — never a morning-only answer', () => {
  assert.deepEqual(one('6', '11'), ['18:00-23:00', '06:00-11:00']);
  assert.deepEqual(one('six', 'eleven'), ['18:00-23:00', '06:00-11:00']);
  assert.deepEqual(one('six', 'eleven', 'give Omar a shift tomorrow six to eleven'), ['18:00-23:00', '06:00-11:00']);
});

test('code-mixed time-of-day words settle the reading: Hindi/Urdu, Arabic and Tagalog evening and morning words', () => {
  for (const word of ['shaam', 'sham', 'raat', 'masaa', 'masa', 'leil', 'layl', 'gabi', 'hapon']) {
    assert.equal(one('six', 'eleven', `Omar ko kal ${word} six to eleven ki shift do`), '18:00-23:00', word);
  }
  for (const word of ['subah', 'sabah', 'umaga', 'sabahan']) {
    assert.equal(one('six', 'eleven', `Omar ko kal ${word} six to eleven ki shift do`), '06:00-11:00', word);
  }
});

test('a model that turned "six to eleven" into 24-hour times has guessed: read back as said, so "kal shaam" settles it, and no cue asks', () => {
  const said = 'Omar ko kal shaam six to eleven ki shift do';
  assert.equal(one('06:00', '11:00', said), '18:00-23:00', 'the live miss: one morning reading was offered');
  assert.equal(one('18:00', '23:00', said), '18:00-23:00');
  assert.deepEqual(one('06:00', '11:00', 'Omar ko kal six to eleven ki shift do'), ['18:00-23:00', '06:00-11:00']);
  assert.deepEqual(one('18:00', '23:00', 'a shift tomorrow six to eleven'), ['18:00-23:00', '06:00-11:00']);
});

test('what the caller fixed stays fixed: digits said, am/pm next to a number, noon and midnight', () => {
  assert.equal(one('06:00', '11:00', 'six am to eleven am'), '06:00-11:00');
  assert.equal(one('18:00', '02:00', 'from 6 p.m. to 2 a.m.'), '18:00-02:00');
  assert.equal(one('19:00', '23:00', 'seven pee em to eleven'), '19:00-23:00');
  assert.equal(one('10:00', '14:00', 'Thursday, 10:00 to 14:00'), '10:00-14:00');
  assert.equal(one('12:00', '20:00', 'from noon to 8'), '12:00-20:00');
  assert.equal(one('16:00', '00:00', 'from 4 to midnight'), '16:00-00:00');
  // "I am" is not a time of day.
  assert.deepEqual(one('06:00', '11:00', 'I am asking for six to eleven'), ['18:00-23:00', '06:00-11:00']);
  // No transcript: values are taken as given.
  assert.equal(one('06:00', '11:00'), '06:00-11:00');
});

test('a changed start or end the model converted is read back as said too', () => {
  const r = readOneTime('06:00', 'start', '23:00', "push Priya's shift to start at six instead");
  assert.deepEqual(r.kind === 'one' && r.times, { start: '18:00', end: '23:00' });
});
