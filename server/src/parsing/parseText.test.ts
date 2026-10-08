import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRosterText } from './parseText.js';

const WEEK = '2026-08-17'; // Monday

test('every row gets its own row number (they used to all be 0 and collide downstream)', () => {
  const { rows } = parseRosterText('Test Alpha waiter 9am-5pm Mon\nTest Beta runner 10am-6pm Tue', WEEK);
  assert.deepEqual(rows.map((r) => r.rowNumber), [1, 2]);
});

test('a weekday inside a name is not the day ("Simon", "Sunil"); the day word after the times is', () => {
  const { rows } = parseRosterText('Simon waiter 9am-5pm Fri\nSunil runner 6pm-11pm Wed', WEEK);
  assert.deepEqual(rows.map((r) => `${r.employeeName}|${r.date}`), ['Simon|2026-08-21', 'Sunil|2026-08-19']);
});

test('a role word inside a name is not a role ("Barbara" is not "bar"); a line without a role keeps its shift', () => {
  const { rows, issues } = parseRosterText('Barbara 9am-5pm Mon\nTest Gamma bar 6pm-2am Sat', WEEK);
  assert.deepEqual(rows.map((r) => `${r.employeeName}|${r.roleName}|${r.startTime}-${r.endTime}`), ['Barbara||09:00-17:00', 'Test Gamma|bar|18:00-02:00']);
  assert.ok(issues.some((i) => i.severity === 'warning' && /No role/.test(i.message)));
  assert.ok(!issues.some((i) => i.severity === 'error'));
});

test('a line naming the week anchors the day names; without one, the client week (or the coming Monday)', () => {
  const titled = parseRosterText('Week of 24/08\nTest Alpha waiter 6pm-2am Fri', WEEK, { today: '2026-10-07', clientWeekStart: null });
  assert.equal(titled.rows[0]!.date, '2026-08-28');
  assert.equal(titled.week.source, 'title');
  const bare = parseRosterText('Test Alpha waiter 6pm-2am Fri', WEEK, { today: '2026-10-07', clientWeekStart: null });
  assert.equal(bare.rows[0]!.date, '2026-10-16');
  assert.equal(bare.week.needsConfirmation, true);
});
