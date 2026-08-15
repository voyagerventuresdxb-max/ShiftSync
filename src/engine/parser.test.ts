import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRosterText } from './parser';
import { parseTime, shiftHours, isOvernight, dayToDate } from './time';
import { DEFAULT_MAINLAND_RULES, type VenueConfig } from './types';

const config: VenueConfig = {
  id: 'venue-1',
  name: 'Test Venue',
  jurisdiction: 'mainland',
  compliance: DEFAULT_MAINLAND_RULES,
  shiftTypeLabels: { bar: 'bar', kitchen: 'kitchen', service: 'service' },
  roleLabels: ['bartender', 'server', 'chef', 'host'],
  knownStaff: ['Maria', 'Jose', 'Ahmed', 'Priya'],
};

const WEEK = '2026-08-17'; // a Monday

test('parseTime handles 12h and 24h formats', () => {
  assert.equal(parseTime('6pm'), '18:00');
  assert.equal(parseTime('6:30pm'), '18:30');
  assert.equal(parseTime('18:00'), '18:00');
  assert.equal(parseTime('1800'), '18:00');
  assert.equal(parseTime('12am'), '00:00');
  assert.equal(parseTime('12pm'), '12:00');
  assert.equal(parseTime('9:00 am'), '09:00');
});

test('shiftHours handles overnight shifts', () => {
  assert.equal(shiftHours('18:00', '02:00'), 8);
  assert.equal(shiftHours('09:00', '17:00'), 8);
  assert.equal(isOvernight('18:00', '02:00'), true);
  assert.equal(isOvernight('09:00', '17:00'), false);
});

test('dayToDate maps day names to week dates', () => {
  assert.equal(dayToDate(WEEK, 'Monday'), '2026-08-17');
  assert.equal(dayToDate(WEEK, 'Fri'), '2026-08-21');
  assert.equal(dayToDate(WEEK, 'Sunday'), '2026-08-23');
  assert.equal(dayToDate(WEEK, 'Nope'), null);
});

test('parses a simple roster text block', () => {
  const text = [
    'Roster week of Aug 17',
    'Maria 6pm-2am Fri',
    'Jose 9am-5pm Mon',
    'Ahmed 10pm-4am Sat',
  ].join('\n');

  const result = parseRosterText(text, config, WEEK);
  assert.equal(result.roster.employees.length, 3);
  assert.equal(result.roster.shifts.length, 3);
  assert.equal(result.durationMs < 10000, true);

  const maria = result.roster.shifts.find((s) => s.employeeId === result.roster.employees[0].id);
  assert.ok(maria);
  assert.equal(maria.start, '18:00');
  assert.equal(maria.end, '02:00');
  assert.equal(maria.overnight, true);
  assert.equal(maria.date, '2026-08-21');
});

test('parses role labels and shift types', () => {
  const text = 'Maria bartender 6pm-2am Fri';
  const result = parseRosterText(text, config, WEEK);
  const emp = result.roster.employees[0];
  assert.equal(emp.role, 'bartender');
  assert.equal(result.roster.shifts[0].type, 'bar');
});

test('flags unrecognized staff names as warnings', () => {
  const text = 'Zed 6pm-2am Fri';
  const result = parseRosterText(text, config, WEEK);
  assert.equal(result.roster.employees.length, 1);
  assert.ok(result.warnings.some((w) => w.includes('Zed')));
});

test('collects unparsed shift-like lines', () => {
  const text = 'Maria 6pm-2am Fri\nJose 6pm Mon';
  const result = parseRosterText(text, config, WEEK);
  assert.equal(result.roster.shifts.length, 1);
  assert.equal(result.unparsedLines.length, 1);
});

test('deduplicates repeated employee names', () => {
  const text = 'Maria 6pm-2am Fri\nMaria 9am-5pm Mon';
  const result = parseRosterText(text, config, WEEK);
  assert.equal(result.roster.employees.length, 1);
  assert.equal(result.roster.shifts.length, 2);
});
