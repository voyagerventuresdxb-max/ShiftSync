import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShiftText, parseSingleTime, sheetDotStyle } from './shiftText.js';

const read = (cell: string, opts = {}) => parseShiftText(cell, opts)?.segments.map((s) => `${s.start}-${s.end}${s.overnight ? '+' : ''}`) ?? null;

test('parseShiftText: decimal hours, including hours past midnight (family A sub-cells joined)', () => {
  assert.deepEqual(read('11 17 18 25'), ['11:00-17:00', '18:00-01:00+']);
  assert.deepEqual(read('9.5 15.5 18 23'), ['09:30-15:30', '18:00-23:00']);
  assert.deepEqual(read('16 18 18.5 27'), ['16:00-18:00', '18:30-03:00+']);
  assert.deepEqual(read('16 20.5 21 26'), ['16:00-20:30', '21:00-02:00+']);
  assert.deepEqual(read('18 24'), ['18:00-00:00+']);
  assert.deepEqual(read('9.75 17.25'), ['09:45-17:15']);
});

test('parseShiftText: 24h, dot separators and overnight', () => {
  assert.deepEqual(read('18:30-01:00'), ['18:30-01:00+']);
  assert.deepEqual(read('09:30 15:30 18:00 02:00'), ['09:30-15:30', '18:00-02:00+']);
  assert.deepEqual(read('18.30-01.00'), ['18:30-01:00+']);
  assert.deepEqual(read('10.30-16.00/20.00-00.00'), ['10:30-16:00', '20:00-00:00+']);
  assert.deepEqual(read('16:00-02:00'), ['16:00-02:00+']);
  assert.deepEqual(read('10:00-15:00 / 19:00-00:00'), ['10:00-15:00', '19:00-00:00+']);
  assert.deepEqual(read('10-14/18-23'), ['10:00-14:00', '18:00-23:00']);
});

test('parseShiftText: 12-hour clock, with and without am/pm', () => {
  assert.deepEqual(read('4pm to 2am'), ['16:00-02:00+']);
  assert.deepEqual(read('1pm to 11pm'), ['13:00-23:00']);
  assert.deepEqual(read('4 PM - 2 AM'), ['16:00-02:00+']);
  assert.deepEqual(read('6.30pm-1am'), ['18:30-01:00+']);
  assert.deepEqual(read('10am/3pm-7pm/12am'), ['10:00-15:00', '19:00-00:00+']);
  assert.deepEqual(read('10AM-3PM / 7PM-12AM'), ['10:00-15:00', '19:00-00:00+']);
  // A 12-hour chain without am/pm reads forward in time.
  assert.deepEqual(read('10:30-4:00-8:00-12'), ['10:30-16:00', '20:00-00:00+']);
  assert.deepEqual(read('9-5'), ['09:00-17:00']);
  assert.equal(parseShiftText('9-5')!.inferred, true);
  assert.deepEqual(read('6-11pm'), ['18:00-23:00']);
  assert.deepEqual(read('10-3pm'), ['10:00-15:00']);
  assert.deepEqual(read('11-2am'), ['23:00-02:00+']);
  assert.deepEqual(read('noon to midnight'), ['12:00-00:00+']);
});

test('parseShiftText: anything that is not purely times is not a time cell', () => {
  for (const cell of ['OFF', 'UL', '4CL', '10IN', 'IN', 'Sofia - 20pax', 'Rest - 14 pax', '1920', '18', 'Ahmed 9-17', '9-17-18', '', 'AM PM']) {
    assert.equal(parseShiftText(cell), null, cell);
  }
});

test('dot style: ".30" anywhere in the sheet makes every dotted time hours.minutes', () => {
  assert.equal(sheetDotStyle(['18.5', '9.5 15.5']), undefined);
  assert.equal(sheetDotStyle(['10.15-18.50']), 'minutes');
  assert.deepEqual(read('18.50-23.00', { dotMeans: 'minutes' }), ['18:50-23:00']);
  assert.deepEqual(read('18.50 23'), ['18:30-23:00']);
});

test('parseSingleTime: the start of an open-ended cell', () => {
  assert.equal(parseSingleTime('10'), '10:00');
  assert.equal(parseSingleTime('4pm'), '16:00');
  assert.equal(parseSingleTime('18.5'), '18:30');
  assert.equal(parseSingleTime('9-17'), null);
});
