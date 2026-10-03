import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, mondayOf, weekRangeLabel } from './weekMath.ts';

test('mondayOf snaps any day of the week to its Monday, Sunday included, across month and year ends', () => {
  assert.equal(mondayOf('2026-10-03'), '2026-09-28'); // Saturday
  assert.equal(mondayOf('2026-10-04'), '2026-09-28'); // Sunday belongs to the week before
  assert.equal(mondayOf('2026-09-28'), '2026-09-28'); // Monday stays
  assert.equal(mondayOf('2026-11-01'), '2026-10-26'); // Sunday 1 Nov → Mon 26 Oct
  assert.equal(mondayOf('2027-01-01'), '2026-12-28'); // Friday 1 Jan 2027 → Mon 28 Dec 2026
  assert.equal(mondayOf('2026-02-30'), '2026-02-30', 'a non-date is returned unchanged for the caller to reject');
});

test('addDays is plain calendar arithmetic', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-12-28', 7), '2027-01-04');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('weekRangeLabel always shows the month and the year, and both years when the week crosses one', () => {
  // ICU spells September "Sept" in en-GB on some Node builds and "Sep" on others.
  assert.match(weekRangeLabel('2026-09-28', '2026-10-04'), /^Mon 28 Sept? – Sun 4 Oct 2026$/);
  assert.equal(weekRangeLabel('2026-10-26', '2026-11-01'), 'Mon 26 Oct – Sun 1 Nov 2026');
  assert.equal(weekRangeLabel('2026-12-28', '2027-01-03'), 'Mon 28 Dec 2026 – Sun 3 Jan 2027');
});
