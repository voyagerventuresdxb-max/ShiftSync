import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PROPOSALS, proposeShiftTypes, type ProposalRow } from './proposeShiftTypes.js';

const row = (employeeName: string, date: string, startTime: string, endTime: string, sourceRowIndex?: number): ProposalRow => ({
  employeeName,
  date,
  startTime,
  endTime,
  ...(sourceRowIndex !== undefined ? { sourceRowIndex } : {}),
});

test('identical timings are counted and ranked by use; names follow the start time', () => {
  const rows = [
    row('Person A', '2031-03-03', '16:00', '01:00'),
    row('Person A', '2031-03-04', '16:00', '01:00'),
    row('Person B', '2031-03-03', '16:00', '01:00'),
    row('Person B', '2031-03-04', '07:00', '16:00'),
    row('Person C', '2031-03-03', '12:00', '20:00'),
  ];
  const proposals = proposeShiftTypes(rows);
  assert.deepEqual(
    proposals.map((p) => [p.name, p.ranges, p.count, p.tint, p.sortOrder]),
    [
      ['Evening', [{ start: '16:00', end: '01:00' }], 3, 'gold', 0],
      ['Morning', [{ start: '07:00', end: '16:00' }], 1, 'sand', 1],
      ['Mid', [{ start: '12:00', end: '20:00' }], 1, 'clay', 2],
    ],
  );
});

test('two rows of one person on one day are one split; the same start twice gets " 2"', () => {
  const rows = [
    row('Person A', '2031-03-03', '11:00', '15:00', 1),
    row('Person A', '2031-03-03', '18:00', '23:00', 1),
    row('Person B', '2031-03-03', '18:00', '23:00', 2),
    row('Person C', '2031-03-03', '17:00', '23:00', 3),
  ];
  const proposals = proposeShiftTypes(rows);
  assert.deepEqual(proposals.find((p) => p.ranges.length === 2), {
    name: 'Split',
    ranges: [{ start: '11:00', end: '15:00' }, { start: '18:00', end: '23:00' }],
    tint: proposals.find((p) => p.ranges.length === 2)!.tint,
    sortOrder: proposals.findIndex((p) => p.ranges.length === 2),
    count: 1,
  });
  const evenings = proposals.filter((p) => p.ranges.length === 1).map((p) => p.name).sort();
  assert.deepEqual(evenings, ['Evening', 'Evening 2'], 'names stay unique');
});

test('a legend entry with the same times names the timing', () => {
  const legend = [
    { code: 'M', meaning: 'Morning (07:00-15:00)' },
    { code: 'B', meaning: 'Brunch 10am - 4pm' },
    { code: 'X', meaning: '17:00-23:00' },
  ];
  const rows = [row('Person A', '2031-03-03', '07:00', '15:00'), row('Person B', '2031-03-03', '10:00', '16:00'), row('Person C', '2031-03-03', '17:00', '23:00')];
  const names = proposeShiftTypes(rows, legend).map((p) => p.name).sort();
  assert.deepEqual(names, ['Brunch', 'Evening', 'Morning'], 'a legend with only times falls back to the time-of-day name');
});

test('timings the venue already has are not proposed; names it already uses get a suffix; at most eight', () => {
  const rows = Array.from({ length: 12 }, (_, i) => row(`Person ${i}`, '2031-03-03', `${String(6 + i).padStart(2, '0')}:00`, `${String(6 + i).padStart(2, '0')}:30`));
  rows.push(row('Person Z', '2031-03-04', '06:00', '06:30'));
  const existing = [
    { name: 'Morning', ranges: [{ start: '06:00', end: '06:30' }] },
    { name: 'mid', ranges: [{ start: '23:00', end: '23:30' }], archived: true },
  ];
  const proposals = proposeShiftTypes(rows, [], existing);
  assert.equal(proposals.length, MAX_PROPOSALS);
  assert.ok(!proposals.some((p) => p.ranges[0]!.start === '06:00'), 'the venue already has 06:00–06:30');
  assert.ok(!proposals.some((p) => p.name === 'Morning' || p.name.toLowerCase() === 'mid'), 'existing names, archived too, are not reused');
  assert.equal(proposals[0]!.name, 'Morning 2');
  assert.deepEqual(proposals.map((p) => p.tint), ['gold', 'sand', 'clay', 'ochre', 'sage', 'cream', 'gold', 'sand']);
});

test('rows that are not a usable timing are ignored; nothing in, nothing out', () => {
  assert.deepEqual(proposeShiftTypes([]), []);
  assert.deepEqual(proposeShiftTypes([row('Person A', '2031-03-03', '09:00', '09:00'), row('Person B', '2031-03-03', '', '')]), []);
});
