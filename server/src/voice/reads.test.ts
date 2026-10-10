import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Prisma, SystemRole } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { shiftInstantsOf } from '../lib/actions/weekActions.js';
import type { TimeRange } from '../../../shared/rotaWeek.js';
import { coverage, mySchedule, pendingRequests, spokenRanges, whoIsOff, whoIsWorking, type Caller } from './reads.js';
import { buildContext, DECLINES_PENDING_REQUEST, resolveModelAnswer } from './parseIntent.js';
import type { ParsedIntent } from './intentSchema.js';
import type { VenueContext } from './context.js';

/**
 * The rota reads against a small made-up week (no real names), through the week document with
 * the caller as viewer: staff hear published shifts and leave only, managers drafts too. The
 * spoken answers (`summary`) are asserted word for word: they are what the voice layer says.
 *
 * Week of Monday 2031-03-03, Asia/Dubai. Floor (Server) and Bar (Bartender); shift types Mid
 * 11–20, Evening 16–01 (+1), Split 11–15 + 18–23; Bar needs two people on Saturdays.
 *   Mon  Fay  Bar Mid (published)        → Fay also works Bar this week
 *   Wed  Ava Mid · Ben Evening (DRAFT) · Cara Evening · Dev Split; Eli sick; Gus annual leave (DRAFT)
 *   Thu  Ava Mid · Dev Evening · Fay Mid; Eli annual leave; Fay has a pending time-off request
 *   Fri  Cara Evening (DRAFT)
 *   Sat  Ava Mid · Cara Evening          → Bar is one short
 */
const TZ = 'Asia/Dubai';
const MON = '2031-03-03';
const WED = '2031-03-05';
const THU = '2031-03-06';
const FRI = '2031-03-07';
const SAT = '2031-03-08';
const MID: TimeRange[] = [{ start: '11:00', end: '20:00' }];
const EVENING: TimeRange[] = [{ start: '16:00', end: '01:00' }];
const SPLIT: TimeRange[] = [
  { start: '11:00', end: '15:00' },
  { start: '18:00', end: '23:00' },
];

type Key = 'ava' | 'ben' | 'cara' | 'dev' | 'eli' | 'fay' | 'gus' | 'max';
let orgId = '';
let locationId = '';
const users = {} as Record<Key, string>;
const types = {} as Record<'mid' | 'evening' | 'split', string>;
const depts = {} as Record<'floor' | 'bar', string>;
const roles = {} as Record<'server' | 'bartender', string>;

const json = (v: unknown) => v as Prisma.InputJsonValue;
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const caller = (key: Key, systemRole: SystemRole = 'STAFF'): Caller => ({ id: users[key], systemRole, locationId });
const ctx = (): VenueContext => ({ today: '2031-03-02', timezone: TZ, callerName: 'x', callerShifts: [], staffDirectory: [] });
const manager = () => caller('max', 'MANAGER');

before(async () => {
  const org = await prisma.organization.create({ data: { name: `__voice-reads-test__ ${Date.now()}` } });
  orgId = org.id;
  const location = await prisma.location.create({ data: { organizationId: org.id, name: org.name, timezone: TZ } });
  locationId = location.id;
  depts.floor = (await prisma.department.create({ data: { locationId, name: 'Floor', sortOrder: 0 } })).id;
  depts.bar = (await prisma.department.create({ data: { locationId, name: 'Bar', sortOrder: 1 } })).id;
  roles.server = (await prisma.role.create({ data: { locationId, name: 'Server', departmentId: depts.floor } })).id;
  roles.bartender = (await prisma.role.create({ data: { locationId, name: 'Bartender', departmentId: depts.bar } })).id;
  types.mid = (await prisma.shiftType.create({ data: { locationId, name: 'Mid', ranges: json(MID), endsNextDay: false, sortOrder: 0 } })).id;
  types.evening = (await prisma.shiftType.create({ data: { locationId, name: 'Evening', ranges: json(EVENING), endsNextDay: true, sortOrder: 1 } })).id;
  types.split = (await prisma.shiftType.create({ data: { locationId, name: 'Split', ranges: json(SPLIT), endsNextDay: false, sortOrder: 2 } })).id;
  const person = async (key: Key, fullName: string, role: 'server' | 'bartender' | null, systemRole: SystemRole = 'STAFF') => {
    users[key] = (await prisma.user.create({ data: { locationId, fullName, systemRole, roleId: role ? roles[role] : null } })).id;
  };
  await person('ava', 'Ava Example', 'server');
  await person('ben', 'Ben Sample', 'server');
  await person('cara', 'Cara Test', 'bartender');
  await person('dev', 'Dev Demo', 'bartender');
  await person('eli', 'Eli Mock', 'server');
  await person('fay', 'Fay Fixture', 'server');
  await person('gus', 'Gus Trial', 'bartender');
  await person('max', 'Max Manager', null, 'MANAGER');

  const shift = (who: Key, role: 'server' | 'bartender', dept: 'floor' | 'bar', date: string, type: 'mid' | 'evening' | 'split', status: 'DRAFT' | 'PUBLISHED') => {
    const ranges = type === 'mid' ? MID : type === 'evening' ? EVENING : SPLIT;
    return prisma.shift.create({
      data: {
        locationId,
        roleId: roles[role],
        userId: users[who],
        date: day(date),
        ...shiftInstantsOf(date, ranges, TZ),
        status,
        shiftTypeId: types[type],
        departmentId: depts[dept],
        ranges: json(ranges),
        endsNextDay: type === 'evening',
      },
    });
  };
  await shift('fay', 'bartender', 'bar', MON, 'mid', 'PUBLISHED');
  await shift('ava', 'server', 'floor', WED, 'mid', 'PUBLISHED');
  await shift('ben', 'server', 'floor', WED, 'evening', 'DRAFT');
  await shift('cara', 'bartender', 'bar', WED, 'evening', 'PUBLISHED');
  await shift('dev', 'bartender', 'bar', WED, 'split', 'PUBLISHED');
  await shift('ava', 'server', 'floor', THU, 'mid', 'PUBLISHED');
  await shift('dev', 'bartender', 'bar', THU, 'evening', 'PUBLISHED');
  await shift('fay', 'server', 'floor', THU, 'mid', 'PUBLISHED');
  await shift('cara', 'bartender', 'bar', FRI, 'evening', 'DRAFT');
  await shift('ava', 'server', 'floor', SAT, 'mid', 'PUBLISHED');
  await shift('cara', 'bartender', 'bar', SAT, 'evening', 'PUBLISHED');
  await prisma.rotaLeave.create({ data: { locationId, userId: users.eli, date: day(WED), type: 'SICK_LEAVE', status: 'PUBLISHED' } });
  await prisma.rotaLeave.create({ data: { locationId, userId: users.eli, date: day(THU), type: 'ANNUAL_LEAVE', status: 'PUBLISHED' } });
  await prisma.rotaLeave.create({ data: { locationId, userId: users.gus, date: day(WED), type: 'ANNUAL_LEAVE', status: 'DRAFT' } });
  await prisma.timeOffRequest.create({ data: { userId: users.fay, startDate: day(THU), endDate: day(THU), status: 'PENDING', expiresAt: day(FRI) } });
  await prisma.departmentMinimum.create({ data: { locationId, departmentId: depts.bar, weekday: 6, minHeadcount: 2 } });
});

after(async () => {
  // Shifts first: a shift's role is ON DELETE RESTRICT, so the venue cascade can't remove them in any order.
  await prisma.shift.deleteMany({ where: { locationId } }).catch(() => {});
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
});

const answerOf = (r: ParsedIntent) => {
  assert.ok('answer' in r, `expected a read, got ${r.intent}`);
  return r.answer;
};

// ---------------------------------------------------------------------------
// WHO_IS_WORKING
// ---------------------------------------------------------------------------

test('WHO_IS_WORKING (manager): grouped by department, shift type names and times said once, sick in its department, drafts counted, then who is off', async () => {
  const r = await whoIsWorking(manager(), ctx(), { day: WED }, 0.9);
  assert.equal(
    r.summary,
    'Wednesday 5 March: 4 people. Floor — Ava on Mid 11 to 20, Ben on Evening 16 to 1, Eli is off sick. Bar — Dev on Split 11 to 15 and 18 to 23, Cara on Evening. Off: Fay, Max and Gus (annual leave). One of these shifts is not published yet.',
  );
  const a = answerOf(r);
  assert.deepEqual(
    a.items.map((i) => [i.primary, i.secondary, i.tertiary ?? '']),
    [
      ['Ava Example', '11:00–20:00 · Mid · Server', ''],
      ['Ben Sample', '16:00–01:00 (+1) · Evening · Server', 'Draft (not published yet)'],
      ['Dev Demo', '11:00–15:00 + 18:00–23:00 · Split · Bartender', ''],
      ['Cara Test', '16:00–01:00 (+1) · Evening · Bartender', ''],
      ['Eli Mock', 'Sick', ''],
      ['Gus Trial', 'Annual leave', 'Draft (not published yet)'],
    ],
  );
});

test('WHO_IS_WORKING (staff): the published week only — no draft shift, no draft leave', async () => {
  const r = await whoIsWorking(caller('fay'), ctx(), { day: WED }, 0.9);
  assert.equal(
    r.summary,
    'Wednesday 5 March: 3 people. Floor — Ava on Mid 11 to 20, Eli is off sick. Bar — Dev on Split 11 to 15 and 18 to 23, Cara on Evening 16 to 1. Off: Ben, Fay, Gus and Max.',
  );
  const items = answerOf(r).items;
  assert.deepEqual(items.map((i) => i.primary), ['Ava Example', 'Dev Demo', 'Cara Test', 'Eli Mock']);
  assert.ok(!items.some((i) => i.tertiary === 'Draft (not published yet)'));
});

test('WHO_IS_WORKING with a period: morning keeps the split and the mid; the evening shifts are not "off"', async () => {
  const r = await whoIsWorking(manager(), ctx(), { day: WED, period: 'AM' }, 0.9);
  assert.equal(r.summary, 'Wednesday 5 March, morning: 2 people. Floor — Ava on Mid 11 to 20, Eli is off sick. Bar — Dev on Split 11 to 15 and 18 to 23. Off: Fay, Max and Gus (annual leave).');
  const empty = await whoIsWorking(caller('fay'), ctx(), { day: '2031-03-04' }, 0.9);
  assert.equal(empty.summary, 'Nobody is on the published rota for Tuesday 4 March 2031.');
});

// ---------------------------------------------------------------------------
// WHO_IS_OFF
// ---------------------------------------------------------------------------

test('WHO_IS_OFF: off, leave by type, and pending time-off requests said as pending; staff hear only their own request', async () => {
  const mgr = await whoIsOff(manager(), ctx(), { day: THU }, 0.9);
  assert.equal(mgr.summary, 'Thursday 6 March: Ben, Cara, Gus and Max are off. Eli is on annual leave. Fay has asked for the day off — that request is still pending.');
  assert.deepEqual(
    answerOf(mgr).items.map((i) => [i.primary, i.secondary]),
    [
      ['Ben Sample', 'Off'],
      ['Cara Test', 'Off'],
      ['Gus Trial', 'Off'],
      ['Max Manager', 'Off'],
      ['Eli Mock', 'Annual leave'],
      ['Fay Fixture', 'Asked for the day off'],
    ],
  );
  const fay = await whoIsOff(caller('fay'), ctx(), { day: THU }, 0.9);
  assert.equal(fay.summary, 'Thursday 6 March: Ben, Cara, Gus and Max are off. Eli is on annual leave. You have asked for the day off — that request is still pending.');
  const ben = await whoIsOff(caller('ben'), ctx(), { day: THU }, 0.9);
  assert.equal(ben.summary, 'Thursday 6 March: Ben, Cara, Gus and Max are off. Eli is on annual leave.', "another person's request is not shown to staff");
  // Sick leave is named, and staff never hear a draft leave as leave.
  const wed = await whoIsOff(caller('ben'), ctx(), { day: WED }, 0.9);
  assert.equal(wed.summary, 'Wednesday 5 March: Ben, Fay, Gus and Max are off. Eli is off sick.');
});

// ---------------------------------------------------------------------------
// COVERAGE
// ---------------------------------------------------------------------------

test('COVERAGE: the short department, who is on, who is off, and who also works it and is free', async () => {
  const r = await coverage(manager(), ctx(), { day: SAT }, 0.9);
  assert.equal(r.summary, 'Not yet — Bar needs one more on Saturday 8 March. Cara is on; Dev and Gus are off. Fay also works Bar and is free that day.');
  assert.deepEqual(answerOf(r).items, [{ primary: 'Bar needs 1 more', secondary: 'On: Cara Test', tertiary: 'Free: Dev, Gus and Fay' }]);
  // "Are we short on bar Saturday?" — the department as said.
  const bar = await coverage(caller('ava'), ctx(), { day: SAT, department: 'the bar' }, 0.9);
  assert.equal(bar.summary, r.summary);
  const floor = await coverage(manager(), ctx(), { day: SAT, department: 'floor' }, 0.9);
  assert.equal(floor.summary, 'Yes — Floor is covered on Saturday 8 March: Ava is on.');
  const whole = await coverage(manager(), ctx(), { day: WED }, 0.9);
  assert.equal(whole.summary, 'Yes — Wednesday 5 March is covered: 4 people are on and no shift is left open.');
  const unknown = await coverage(manager(), ctx(), { day: SAT, department: 'kitchen' }, 0.9);
  assert.equal(unknown.intent, 'UNRECOGNIZED');
});

// ---------------------------------------------------------------------------
// QUERY_MY_SCHEDULE and PENDING_REQUESTS
// ---------------------------------------------------------------------------

test('QUERY_MY_SCHEDULE: published shifts only, grouped by shift type, both ranges of a split, "next day" past midnight, and the days off', async () => {
  const dev = await mySchedule(caller('dev'), ctx(), { week: MON }, 0.9);
  assert.equal(dev.summary, 'Split on Wednesday, 11 to 15 and 18 to 23. Evening on Thursday, 16 to 1 next day. Off Monday, Tuesday, Friday, Saturday and Sunday.');
  assert.deepEqual(answerOf(dev).items.map((i) => [i.primary, i.secondary]), [
    ['Wednesday 5 March 2031', '11:00–15:00 + 18:00–23:00 · Split · Bartender'],
    ['Thursday 6 March 2031', '16:00–01:00 (+1) · Evening · Bartender'],
  ]);
  // Cara's Friday shift is still a draft: not her schedule yet, even when a manager asks for theirs.
  const cara = await mySchedule(caller('cara'), ctx(), { week: WED }, 0.9);
  assert.equal(cara.summary, 'Evening on Wednesday and Saturday, 16 to 1 next day. Off Monday, Tuesday, Thursday, Friday and Sunday.');
  const eli = await mySchedule(caller('eli'), ctx(), { week: MON }, 0.9);
  assert.equal(eli.summary, 'Annual leave on Thursday. Sick on Wednesday. Off Monday, Tuesday, Friday, Saturday and Sunday.');
  const one = await mySchedule(caller('dev'), ctx(), { day: THU }, 0.9);
  assert.equal(one.summary, 'Thursday 6 March: Evening, 16 to 1 next day.');
  assert.equal(spokenRanges([{ start: '11:30', end: '15:00' }]), '11:30 to 15');
});

test('PENDING_REQUESTS: pending time-off requests alongside swaps and marks; staff only their own', async () => {
  const mgr = await pendingRequests(manager(), ctx(), 0.9);
  assert.equal(mgr.summary, 'One. Fay Fixture asked for Thu 6 Mar off.');
  assert.deepEqual(answerOf(mgr).items, [{ primary: 'Fay Fixture asked for time off', secondary: 'Thu 6 Mar', tertiary: 'Time-off request, waiting for a manager' }]);
  assert.equal((await pendingRequests(caller('fay'), ctx(), 0.9)).summary, 'One. You asked for Thu 6 Mar off.');
  assert.equal((await pendingRequests(caller('ben'), ctx(), 0.9)).summary, 'You have no pending swap requests or time off coming up.');
});

// ---------------------------------------------------------------------------
// Through the tool contract (no model call): the new reads and shift types
// ---------------------------------------------------------------------------

const asCaller = async (key: Key, systemRole: SystemRole) => ({ id: users[key], systemRole, fullName: key, locationId });
const raw = (tool: string, args: Record<string, unknown>) => ({ tool, args, confidence: 0.9, summary: `${tool} as heard.` });

test('WHO_IS_OFF and COVERAGE are tools staff may use; "bar" filed as a section still asks about the department', async () => {
  const staff = await asCaller('ava', 'STAFF');
  const sctx = await buildContext(staff);
  const off = await resolveModelAnswer(raw('WHO_IS_OFF', { day: THU }), sctx, staff, "who's off Thursday");
  assert.equal(off.response.intent, 'WHO_IS_OFF');
  assert.match(off.response.summary, /^Thursday 6 March: /);
  const short = await resolveModelAnswer(raw('COVERAGE', { day: SAT, section: 'bar' }), sctx, staff, 'are we short on bar Saturday');
  assert.equal(short.response.intent, 'COVERAGE');
  assert.match(short.response.summary, /^Not yet — Bar needs one more on Saturday 8 March\./);
});

test('CREATE_SHIFT names a shift type: the venue type\'s ranges and id; a split type is one shift with two ranges', async () => {
  const mgr = await asCaller('max', 'MANAGER');
  const mctx = await buildContext(mgr);
  const evening = await resolveModelAnswer(raw('CREATE_SHIFT', { person: 'Gus', role: 'bartender', day: FRI, shiftType: 'evening' }), mctx, mgr, 'put Gus on evening Friday');
  const r = evening.response;
  assert.equal(r.intent, 'CREATE_SHIFT');
  if (r.intent !== 'CREATE_SHIFT') return;
  assert.deepEqual([r.shiftTypeId, r.start, r.end, r.second, r.userId], [types.evening, '16:00', '01:00', undefined, users.gus]);
  assert.match(r.summary, /^Create an Evening Bartender shift for Gus Trial, Fri 7 Mar 16:00–01:00\.$/);
  const split = await resolveModelAnswer(raw('CREATE_SHIFT', { person: 'Gus', role: 'bartender', day: FRI, shiftType: 'a split' }), mctx, mgr, 'give Gus a split on Friday');
  assert.ok(split.response.intent === 'CREATE_SHIFT' && split.response.second);
  assert.deepEqual(split.response.intent === 'CREATE_SHIFT' && [split.response.start, split.response.end, split.response.second], ['11:00', '15:00', { start: '18:00', end: '23:00' }]);
  const none = await resolveModelAnswer(raw('CREATE_SHIFT', { person: 'Gus', role: 'bartender', day: FRI, shiftType: 'brunch' }), mctx, mgr, 'put Gus on brunch Friday');
  assert.equal(none.response.intent, 'UNRECOGNIZED');
  assert.match(none.response.summary, /no brunch shift type/);
});

test('person-day rules before the Confirm: a second shift that day and approved leave are asked; a pending request is said, and Confirm declines it', async () => {
  const mgr = await asCaller('max', 'MANAGER');
  const mctx = await buildContext(mgr);
  const twice = await resolveModelAnswer(raw('CREATE_SHIFT', { person: 'Ava', role: 'server', day: SAT, start: '21', end: '23' }), mctx, mgr, 'Ava on server Saturday 21 to 23');
  assert.equal(twice.response.intent, 'UNRECOGNIZED');
  assert.equal(twice.response.summary, 'They already have a shift that day.');
  const leave = await resolveModelAnswer(raw('CREATE_SHIFT', { person: 'Eli', role: 'server', day: THU, shiftType: 'mid' }), mctx, mgr, 'put Eli on the mid Thursday');
  assert.equal(leave.response.summary, "They're on annual leave that day.");
  const pending = await resolveModelAnswer(raw('EDIT_SHIFT', { person: 'Dev', day: THU, newPerson: 'Fay' }), mctx, mgr, "give Dev's Thursday shift to Fay");
  // Fay already works Thursday (and her Mid overlaps Dev's Evening): asked, never offered.
  assert.equal(pending.response.intent, 'UNRECOGNIZED');
  assert.match(pending.response.summary, /^They already have a shift /);
  // Ben has no Thursday shift; give him a pending request and the reading carries the override, said on the sheet.
  const request = await prisma.timeOffRequest.create({ data: { userId: users.ben, startDate: day(THU), endDate: day(THU), status: 'PENDING', expiresAt: day(FRI) } });
  try {
    const r = (await resolveModelAnswer(raw('EDIT_SHIFT', { person: 'Dev', day: THU, newPerson: 'Ben' }), mctx, mgr, "give Dev's Thursday shift to Ben")).response;
    assert.equal(r.intent, 'EDIT_SHIFT');
    assert.ok(r.intent === 'EDIT_SHIFT' && r.overridePendingRequest === true);
    assert.ok(r.summary.endsWith(DECLINES_PENDING_REQUEST));
  } finally {
    await prisma.timeOffRequest.delete({ where: { id: request.id } });
  }
});
