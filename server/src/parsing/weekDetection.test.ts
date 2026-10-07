import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comingMonday, detectWeek, isConsecutiveDayRun, parseDayLabel, parseTitleDate, type DayLabel } from './weekDetection.js';

const TODAY = '2026-10-07'; // a Wednesday
const labels = (...cells: unknown[]) => cells.map(parseDayLabel);

test('parseDayLabel: every printed day-header style seen on rosters', () => {
  const l = (v: unknown) => {
    const r = parseDayLabel(v);
    return r && [r.weekday, r.day, r.month, r.year];
  };
  assert.deepEqual(l('17-Aug'), [null, 17, 8, null]);
  assert.deepEqual(l('17 August'), [null, 17, 8, null]);
  assert.deepEqual(l('Mon 17/08'), [0, 17, 8, null]);
  assert.deepEqual(l('MONDAY 17 AUGUST'), [0, 17, 8, null]);
  assert.deepEqual(l('Aug 17'), [null, 17, 8, null]);
  assert.deepEqual(l('17th Aug'), [null, 17, 8, null]);
  assert.deepEqual(l('Monday, 17th of August 2026'), [0, 17, 8, 2026]);
  assert.deepEqual(l('17/08 Mon'), [0, 17, 8, null]);
  assert.deepEqual(l('Mon 24/08/2026'), [0, 24, 8, 2026]);
  assert.deepEqual(l('Mon 24 Aug 2026'), [0, 24, 8, 2026]);
  assert.deepEqual(l('17-Aug MONDAY'), [0, 17, 8, null]);
  assert.deepEqual(l('Mon 24'), [0, 24, null, null]);
  assert.deepEqual(l('THURS'), [3, null, null, null]);
  assert.deepEqual(l('2026-08-17'), [null, 17, 8, 2026]);
  assert.deepEqual(l(new Date(Date.UTC(2026, 7, 17))), [0, 17, 8, 2026]);
  // Numeric-only day/month is also a shift-time shape: marked so header detection can demand a run.
  assert.equal(parseDayLabel('17/08')!.numericOnly, true);
  assert.equal(parseDayLabel('Mon 17/08')!.numericOnly, false);
  for (const notADay of ['9-17', 'Sofia - 20pax', 'Simon', 'Sunil Rao', 'AM', 'OFF', '18.5', '', 'COVERS', 3]) assert.equal(parseDayLabel(notADay), null, String(notADay));
});

test('parseTitleDate: week titles', () => {
  assert.deepEqual(parseTitleDate('Rota 24 - 30 Aug'), { day: 24, month: 8, year: null });
  assert.deepEqual(parseTitleDate('Week of 24/08'), { day: 24, month: 8, year: null });
  assert.deepEqual(parseTitleDate('Venue - Week of 24th August'), { day: 24, month: 8, year: null });
  assert.deepEqual(parseTitleDate('Schedule 17-23 August 2026'), { day: 17, month: 8, year: 2026 });
  assert.deepEqual(parseTitleDate('w/c Aug 24'), { day: 24, month: 8, year: null });
  assert.equal(parseTitleDate('Le Petit Comptoir - FOH'), null);
});

test('detectWeek: printed day-month dates land in their own week, never the upload week', () => {
  const r = detectWeek(labels('24-Aug', '25-Aug', '26-Aug', '27-Aug', '28-Aug', '29-Aug', '30-Aug'), [], { today: TODAY });
  assert.equal(r.week.weekStart, '2026-08-24');
  assert.equal(r.week.source, 'printed_dates');
  assert.equal(r.week.needsConfirmation, false);
  assert.deepEqual(r.dates, ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29', '2026-08-30']);
  // A client weekStart never overrides printed dates.
  assert.equal(detectWeek(labels('24-Aug', '25-Aug'), [], { today: TODAY, clientWeekStart: '2026-10-05' }).week.weekStart, '2026-08-24');
});

test('detectWeek: printed weekdays pick the year in which the dates fall on them (nearest to today)', () => {
  // 13 April is a Monday in 2026 and 2020, a Tuesday in 2027.
  const r = detectWeek(labels('Mon 13/04', 'Tue 14/04', 'Wed 15/04'), [], { today: '2027-03-01' });
  assert.equal(r.week.weekStart, '2026-04-13');
  // Without weekdays the nearest year wins.
  assert.equal(detectWeek(labels('13-Apr', '14-Apr'), [], { today: '2027-03-01' }).dates[0], '2027-04-13');
});

test('detectWeek: a roster crossing New Year moves on a year mid-week', () => {
  const r = detectWeek(labels('Mon 29 Dec', 'Tue 30 Dec', 'Wed 31 Dec', 'Thu 1 Jan', 'Fri 2 Jan'), [], { today: '2025-12-20' });
  assert.deepEqual(r.dates, ['2025-12-29', '2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02']);
  assert.equal(r.week.weekStart, '2025-12-29');
});

test('detectWeek: weekday-only headers take the week from a title', () => {
  const r = detectWeek(labels('MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'), ['Rota 24 - 30 Aug'], { today: TODAY });
  assert.equal(r.week.source, 'title');
  assert.equal(r.week.weekStart, '2026-08-24');
  assert.equal(r.week.needsConfirmation, false);
  assert.equal(r.dates[6], '2026-08-30');
});

test('detectWeek: weekday-only with nothing else → the coming Monday, flagged; a client weekStart is used instead', () => {
  const plain = detectWeek(labels('Mon', 'Tue', 'Wed'), [], { today: TODAY });
  assert.equal(plain.week.source, 'weekday_only');
  assert.equal(plain.week.weekStart, '2026-10-12');
  assert.equal(plain.week.needsConfirmation, true);
  assert.match(plain.week.reason!, /weekday names/);
  const client = detectWeek(labels('Mon', 'Tue'), [], { today: TODAY, clientWeekStart: '2026-11-02' });
  assert.equal(client.week.weekStart, '2026-11-02');
  assert.equal(client.week.needsConfirmation, false);
  assert.equal(comingMonday('2026-10-12'), '2026-10-12');
});

test('detectWeek: "Mon 24" with a title month, and without one (flagged)', () => {
  const titled = detectWeek(labels('Mon 24', 'Tue 25', 'Wed 26'), ['Week of 24th August'], { today: TODAY });
  assert.equal(titled.week.weekStart, '2026-08-24');
  assert.equal(titled.week.needsConfirmation, false);
  const bare = detectWeek(labels('Mon 24', 'Tue 25'), [], { today: TODAY });
  assert.equal(bare.week.needsConfirmation, true);
  assert.equal(new Date(`${bare.dates[0]}T00:00:00Z`).getUTCDay(), 1, 'still lands on a Monday 24th');
});

test('detectWeek: a weekday that disagrees with its date asks for confirmation', () => {
  const r = detectWeek(labels('Mon 17/08', 'Tue 18/08', 'Thu 19/08'), [], { today: TODAY });
  assert.equal(r.week.weekStart, '2026-08-17');
  assert.equal(r.week.needsConfirmation, true);
});

test('detectWeek: a Sunday-first week is dated by the Monday most of its days share', () => {
  const r = detectWeek(labels('Sun 23-Aug', 'Mon 24-Aug', 'Tue 25-Aug', 'Wed 26-Aug', 'Thu 27-Aug', 'Fri 28-Aug', 'Sat 29-Aug'), [], { today: TODAY });
  assert.equal(r.week.weekStart, '2026-08-24');
  assert.equal(r.dates[0], '2026-08-23');
});

test('isConsecutiveDayRun: numeric date rows are a header only as a run of consecutive days', () => {
  const run = (...v: string[]) => isConsecutiveDayRun(v.map((x) => parseDayLabel(x) as DayLabel));
  assert.equal(run('17/08', '18/08', '19/08'), true);
  assert.equal(run('31/08', '01/09'), true);
  assert.equal(run('10-12', '10-12'), false);
});
